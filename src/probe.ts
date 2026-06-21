import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { Logger } from './logger';
import { ApiClient } from './api';
import { HostAdapter } from './host';

/**
 * Context-Guard SPAWN probe — self-test for the "one-tap reborn" hypothesis.
 *
 * Background: Context Guard can detect critical context pressure but cannot
 * shrink the host's window from an MCP tool / hook. The open question is
 * whether the EXTENSION can drive a new chat session via the host command
 * surface (`vscode.commands.executeCommand`) — something hooks can't do — and
 * whether continuity survives (MCP connection + SessionStart bootstrap).
 *
 * This module answers the parts an extension CAN observe, and instruments the
 * part it can't so a human tester can read the result off the server:
 *
 *   #1 DISCOVER  — list the real chat/session command-ids the host registers
 *                  (getCommands is authoritative for THIS host + version, far
 *                  better than guessing the id in host.ts).
 *   #2 EXECUTE   — actually invoke a chosen command and report success/failure.
 *   #3 CONTINUITY— drop a uniquely-tagged bootstrap marker BEFORE the spawn so
 *                  the tester can confirm, after the new session opens, whether
 *                  the SessionStart hook re-hit /v1/ide/guard/bootstrap (proving
 *                  MCP + rehydrate survived). The extension can't see the MCP
 *                  process, so this is the honest seam.
 *
 * Nothing here runs automatically. It's a manual command — no production flow
 * touches it. Safe to ship dark or strip before release.
 */

// Heuristics for "this command starts/opens a new chat or agent session".
const VERB = /(new|create|start|open|begin|fresh|reset|clear)/i;
const NOUN = /(chat|conversation|session|composer|cascade|agent|thread)/i;

interface RankedCommand {
    id: string;
    score: number;
    why: string;
}

/** Rank discovered command-ids by how likely they open a new chat session. */
function rankCandidates(all: string[], adapter: HostAdapter): RankedCommand[] {
    const declared = new Set(
        [adapter.newSessionCommand()].filter((x): x is string => !!x),
    );
    const ranked: RankedCommand[] = [];
    for (const id of all) {
        const hasNoun = NOUN.test(id);
        if (!hasNoun) continue;
        const hasVerb = VERB.test(id);
        let score = 0;
        const reasons: string[] = [];
        if (declared.has(id)) {
            score += 100;
            reasons.push('declared-in-host.ts');
        }
        if (hasVerb && hasNoun) {
            score += 10;
            reasons.push('verb+noun');
        } else if (hasNoun) {
            score += 2;
            reasons.push('noun-only');
        }
        // Prefer agent-family namespaces over generic editor ones.
        if (/^(kiroAgent|composer|cascade|workbench\.action\.chat|aichat|continue|cline)/i.test(id)) {
            score += 5;
            reasons.push('chat-namespace');
        }
        ranked.push({ id, score, why: reasons.join(',') || 'noun-match' });
    }
    ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return ranked;
}

/**
 * Entry point for the `memoryai.debug.probeContext` command.
 */
export async function runSpawnProbe(
    adapter: HostAdapter,
    api: ApiClient,
    log: Logger,
    context: vscode.ExtensionContext,
): Promise<void> {
    const out = log; // alias for readability
    out.reveal(); // force the MemoryAI Output panel visible
    out.raw('════════════════════════════════════════════════════');
    out.raw(`SPAWN PROBE — host=${adapter.id} (${adapter.displayName})`);
    out.raw(`appName="${vscode.env.appName}"  appHost="${vscode.env.appHost}"`);
    out.raw(`declared newSessionCommand = ${adapter.newSessionCommand() ?? '(none)'}`);
    out.raw('────────────────────────────────────────────────────');

    // ── #1 DISCOVER ──────────────────────────────────────────────────
    let all: string[] = [];
    try {
        all = await vscode.commands.getCommands(true);
    } catch (e) {
        out.raw(`getCommands failed: ${(e as Error).message}`);
    }
    out.raw(`#1 DISCOVER — host registers ${all.length} commands total.`);
    const ranked = rankCandidates(all, adapter);
    out.raw(`#1 DISCOVER — ${ranked.length} look chat/session-related:`);
    for (const c of ranked.slice(0, 40)) {
        out.raw(`     [${String(c.score).padStart(3)}] ${c.id}   (${c.why})`);
    }
    if (ranked.length > 40) out.raw(`     … and ${ranked.length - 40} more (see picker).`);

    const action = await vscode.window.showQuickPick(
        [
            { label: '$(list-unordered) Just show candidates', detail: 'Discovery only — already logged to Output. No command executed.', act: 'list' as const },
            { label: '$(search) Find raw transcript (B5 feeder)', detail: 'Scan Kiro storage for a conversation file the extension can read raw — the missing piece for 100% job continuity.', act: 'transcript' as const },
            { label: '$(json) Dump transcript schema', detail: 'Read the newest Kiro session file and print its structure (redacted) so the feeder parser can be written.', act: 'schema' as const },
            { label: '$(cloud-upload) Test B5 feeder (read history → POST tail)', detail: 'Parse history[] from the newest session, extract last turns, POST to /v1/ide/guard/compact as tail_messages. Real server write.', act: 'feeder' as const },
            { label: '$(inspect) Verify promptLogs.completion', detail: 'Inspect promptLogs[] on each turn — is the real assistant answer in .completion (vs the "On it." placeholder in message.content)?', act: 'promptlogs' as const },
            { label: '$(microscope) Deep-scan largest session', detail: 'Open the LARGEST session file and dump every key on assistant turns + any long string field, to locate where the real answer is stored.', act: 'deepscan' as const },
            { label: '$(target) Inspect sessions.json + activeTabId', detail: 'Read the workspace sessions.json index + each session file’s activeTabId/mtime, to pick the ACTIVE session (not just newest mtime).', act: 'activesession' as const },
            { label: '$(rocket) Execute a command (test spawn)', detail: 'Pick one of the discovered ids and actually run it. May open a new chat.', act: 'exec' as const },
            { label: '$(beaker) Full continuity test', detail: 'Drop a bootstrap marker, then execute a spawn command. Check server logs after.', act: 'continuity' as const },
        ],
        {
            title: 'MemoryAI SPAWN Probe',
            placeHolder: 'What do you want to test?',
            ignoreFocusOut: true,
        },
    );
    if (!action) {
        out.raw('Probe cancelled at action picker.');
        return;
    }

    if (action.act === 'list') {
        vscode.window.showInformationMessage(
            `MemoryAI probe: ${ranked.length} chat-related commands found. See Output > MemoryAI.`,
            'Open Output',
        ).then((c) => { if (c === 'Open Output') out.exportLogs(); });
        return;
    }

    if (action.act === 'transcript') {
        await findTranscript(out, context);
        return;
    }

    if (action.act === 'schema') {
        await dumpSchema(out);
        return;
    }

    if (action.act === 'feeder') {
        await testFeeder(out, api);
        return;
    }

    if (action.act === 'promptlogs') {
        await verifyPromptLogs(out);
        return;
    }

    if (action.act === 'deepscan') {
        await deepScanLargest(out);
        return;
    }

    if (action.act === 'activesession') {
        await inspectActiveSession(out);
        return;
    }

    // ── #3 CONTINUITY (pre-spawn marker) ─────────────────────────────
    let marker = '';
    if (action.act === 'continuity') {
        marker = `PROBE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        out.raw(`#3 CONTINUITY — dropping pre-spawn bootstrap marker: ${marker}`);
        const boot = await api.bootstrap(`spawn-probe marker=${marker}`, 3);
        if (boot) {
            out.raw(`#3 CONTINUITY — pre-spawn bootstrap OK (restored=${boot.memories_restored}, tokens=${boot.tokens_used}).`);
            out.raw('     → After the new session opens, check the server for a SECOND');
            out.raw(`       /v1/ide/guard/bootstrap hit. If it fires, SessionStart + MCP`);
            out.raw('       survived the spawn → continuity is real. If not, the spawn');
            out.raw('       killed the MCP wiring and bootstrap must be re-armed.');
        } else {
            out.raw('#3 CONTINUITY — pre-spawn bootstrap FAILED (offline / no key?). '
                + 'Continuity verdict will be unreliable. Continue anyway to test execute.');
        }
    }

    // ── #2 EXECUTE ───────────────────────────────────────────────────
    const picks = ranked.slice(0, 50).map((c) => ({
        label: c.id,
        description: `score ${c.score}`,
        detail: c.why,
    }));
    // Always offer the declared id even if discovery didn't surface it.
    const declaredId = adapter.newSessionCommand();
    if (declaredId && !ranked.some((r) => r.id === declaredId)) {
        picks.unshift({ label: declaredId, description: 'declared (NOT in getCommands!)', detail: 'host.ts guess — may not exist' });
    }
    picks.push({ label: '$(close) Cancel — do not execute anything', description: '', detail: '' });

    const chosen = await vscode.window.showQuickPick(picks, {
        title: 'MemoryAI SPAWN Probe — pick a command to EXECUTE',
        placeHolder: 'This will actually run the command. A new chat may open and this panel may lose focus.',
        ignoreFocusOut: true,
    });
    if (!chosen || chosen.label.startsWith('$(close)')) {
        out.raw('#2 EXECUTE — cancelled, no command run.');
        return;
    }

    const cmdId = chosen.label;
    out.raw(`#2 EXECUTE — invoking "${cmdId}" …`);
    const existed = all.includes(cmdId);
    out.raw(`     command present in getCommands: ${existed}`);
    const t0 = Date.now();
    let ok = false;
    let err = '';
    try {
        await vscode.commands.executeCommand(cmdId);
        ok = true;
    } catch (e) {
        err = (e as Error).message;
    }
    const dt = Date.now() - t0;
    if (ok) {
        out.raw(`#2 EXECUTE — "${cmdId}" returned without throwing (${dt}ms).`);
        out.raw('     NOTE: "no throw" ≠ "session actually spawned". Confirm visually');
        out.raw('     whether a new chat opened. Some hosts no-op silently.');
    } else {
        out.raw(`#2 EXECUTE — "${cmdId}" threw after ${dt}ms: ${err}`);
        out.raw('     → This id is wrong / unavailable for this host+version. Pick another');
        out.raw('       from the discovered list, or update host.ts with a verified id.');
    }

    if (action.act === 'continuity') {
        vscode.window.showInformationMessage(
            `MemoryAI probe done. Marker=${marker}. Now check the server for a 2nd `
            + `bootstrap hit to confirm continuity. Details in Output > MemoryAI.`,
            'Open Output',
        ).then((c) => { if (c === 'Open Output') out.exportLogs(); });
    } else {
        vscode.window.showInformationMessage(
            `MemoryAI probe: executed "${cmdId}" → ${ok ? 'no error' : 'threw'}. See Output > MemoryAI.`,
            'Open Output',
        ).then((c) => { if (c === 'Open Output') out.exportLogs(); });
    }
    out.raw('════════════════════════════════════════════════════');
}

// ── Transcript finder (B5 feeder for Kiro) ───────────────────────────
//
// Claude Code's PreCompact hook receives `transcript_path` (a JSONL file of
// raw turns), which precompact-runner.ts reads and ships to
// /v1/ide/guard/compact as `tail_messages` → B5+ work_snapshot → 100% resume.
//
// Kiro has no such hook payload. The open question: does Kiro persist the
// conversation to a file the EXTENSION can read directly? If yes, we can write
// the same raw-tail feeder for Kiro and it reaches parity with Claude Code.
// This scans the likely locations and reports what it finds.

const TRANSCRIPT_GLOBS = [
    // role:user / role:assistant near a "content" key — the universal shape.
    /"role"\s*:\s*"(user|assistant)"/,
];

function looksLikeTranscript(sample: string): boolean {
    return TRANSCRIPT_GLOBS.some((re) => re.test(sample));
}

function safeReadHead(file: string, bytes = 4000): string {
    try {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(bytes);
        const n = fs.readSync(fd, buf, 0, bytes, 0);
        fs.closeSync(fd);
        return buf.subarray(0, n).toString('utf-8');
    } catch {
        return '';
    }
}

/** Recursively list files under dir up to a depth/"count" budget. Best-effort. */
function walk(dir: string, maxDepth: number, budget: { n: number }): string[] {
    const found: string[] = [];
    if (budget.n <= 0 || maxDepth < 0) return found;
    let entries: fs.Dirent[] = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return found;
    }
    for (const e of entries) {
        if (budget.n <= 0) break;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            // Skip obvious noise.
            if (/node_modules|Cache|GPUCache|logs?$/i.test(e.name)) continue;
            found.push(...walk(full, maxDepth - 1, budget));
        } else if (e.isFile()) {
            budget.n--;
            if (/\.(jsonl|json)$/i.test(e.name) && /chat|conversation|session|transcript|history|message|thread/i.test(full)) {
                found.push(full);
            }
        }
    }
    return found;
}

async function findTranscript(out: Logger, context: vscode.ExtensionContext): Promise<void> {
    out.reveal();
    out.raw('════════════════════════════════════════════════════');
    out.raw('TRANSCRIPT FINDER — looking for a raw conversation file (B5 feeder)');
    out.raw('────────────────────────────────────────────────────');

    const home = os.homedir();
    const roots: Array<{ label: string; dir: string; depth: number }> = [
        { label: 'extension globalStorage', dir: context.globalStorageUri.fsPath, depth: 2 },
        { label: 'extension storage (workspace)', dir: context.storageUri?.fsPath ?? '', depth: 2 },
        { label: '~/.kiro', dir: path.join(home, '.kiro'), depth: 4 },
        { label: 'Kiro globalStorage', dir: path.join(home, 'AppData', 'Roaming', 'Kiro', 'User', 'globalStorage'), depth: 3 },
        { label: 'Kiro workspaceStorage', dir: path.join(home, 'AppData', 'Roaming', 'Kiro', 'User', 'workspaceStorage'), depth: 3 },
        { label: 'Kiro globalStorage (linux)', dir: path.join(home, '.config', 'Kiro', 'User', 'globalStorage'), depth: 3 },
        { label: 'Kiro workspaceStorage (linux)', dir: path.join(home, '.config', 'Kiro', 'User', 'workspaceStorage'), depth: 3 },
        { label: 'Kiro globalStorage (mac)', dir: path.join(home, 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage'), depth: 3 },
        // Windsurf (VS Code fork). Chat/cascade state lives under the standard
        // VS Code User dirs for the "Windsurf" product, plus the Codeium home.
        { label: 'Windsurf globalStorage (win)', dir: path.join(home, 'AppData', 'Roaming', 'Windsurf', 'User', 'globalStorage'), depth: 3 },
        { label: 'Windsurf workspaceStorage (win)', dir: path.join(home, 'AppData', 'Roaming', 'Windsurf', 'User', 'workspaceStorage'), depth: 3 },
        { label: 'Windsurf globalStorage (linux)', dir: path.join(home, '.config', 'Windsurf', 'User', 'globalStorage'), depth: 3 },
        { label: 'Windsurf workspaceStorage (linux)', dir: path.join(home, '.config', 'Windsurf', 'User', 'workspaceStorage'), depth: 3 },
        { label: 'Windsurf globalStorage (mac)', dir: path.join(home, 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage'), depth: 3 },
        { label: 'Windsurf workspaceStorage (mac)', dir: path.join(home, 'Library', 'Application Support', 'Windsurf', 'User', 'workspaceStorage'), depth: 3 },
        { label: '~/.codeium', dir: path.join(home, '.codeium'), depth: 4 },
    ];

    const hits: Array<{ file: string; size: number; transcriptish: boolean }> = [];
    for (const r of roots) {
        if (!r.dir || !fs.existsSync(r.dir)) {
            out.raw(`  [skip] ${r.label}: not present (${r.dir})`);
            continue;
        }
        const budget = { n: 4000 };
        const files = walk(r.dir, r.depth, budget);
        out.raw(`  [scan] ${r.label}: ${files.length} candidate file(s) under ${r.dir}`);
        for (const f of files) {
            let size = 0;
            try { size = fs.statSync(f).size; } catch { /* ignore */ }
            const head = safeReadHead(f);
            const ish = looksLikeTranscript(head);
            hits.push({ file: f, size, transcriptish: ish });
        }
    }

    const real = hits.filter((h) => h.transcriptish).sort((a, b) => b.size - a.size);
    const others = hits.filter((h) => !h.transcriptish).sort((a, b) => b.size - a.size);

    out.raw('────────────────────────────────────────────────────');
    out.raw(`FOUND ${real.length} file(s) that look like a raw transcript (role:user/assistant):`);
    for (const h of real.slice(0, 20)) {
        out.raw(`   ✓ [${(h.size / 1024).toFixed(0)}KB] ${h.file}`);
    }
    if (real.length === 0) {
        out.raw('   (none) — Kiro may keep the conversation in SQLite (state.vscdb) or');
        out.raw('   in-memory only. Next probe step would be to inspect state.vscdb.');
    }
    out.raw(`Other name-matched json/jsonl (not obviously a transcript): ${others.length}`);
    for (const h of others.slice(0, 15)) {
        out.raw(`   · [${(h.size / 1024).toFixed(0)}KB] ${h.file}`);
    }

    // Also flag any SQLite state DB — Kiro (VS Code fork) usually stores chat
    // in state.vscdb, which is the likely real home if no JSONL turned up.
    const vscdb: string[] = [];
    try {
        const wsRoots = [
            path.join(home, 'AppData', 'Roaming', 'Kiro', 'User', 'workspaceStorage'),
            path.join(home, 'AppData', 'Roaming', 'Windsurf', 'User', 'workspaceStorage'),
            path.join(home, '.config', 'Kiro', 'User', 'workspaceStorage'),
            path.join(home, '.config', 'Windsurf', 'User', 'workspaceStorage'),
            path.join(home, 'Library', 'Application Support', 'Kiro', 'User', 'workspaceStorage'),
            path.join(home, 'Library', 'Application Support', 'Windsurf', 'User', 'workspaceStorage'),
        ];
        for (const wsRoot of wsRoots) {
            if (!fs.existsSync(wsRoot)) continue;
            for (const d of fs.readdirSync(wsRoot)) {
                const db = path.join(wsRoot, d, 'state.vscdb');
                if (fs.existsSync(db)) vscdb.push(db);
            }
        }
    } catch { /* ignore */ }
    if (vscdb.length) {
        out.raw('────────────────────────────────────────────────────');
        out.raw(`SQLite state DBs found (chat may live here as a key in ItemTable):`);
        for (const d of vscdb.slice(0, 10)) out.raw(`   ▣ ${d}`);
        out.raw('   → If no JSONL transcript exists, the feeder must query this DB.');
    }

    out.raw('════════════════════════════════════════════════════');
    vscode.window.showInformationMessage(
        `Transcript finder done: ${real.length} likely transcript file(s), ${vscdb.length} state DB(s). See Output > MemoryAI.`,
        'Open Output',
    ).then((c) => { if (c === 'Open Output') out.exportLogs(); });
}

// ── Schema dumper (reads newest Kiro session JSON, prints structure) ──
//
// Kiro stores each session as a single .json (not JSONL) under
// globalStorage/kiro.kiroagent/workspace-sessions/<workspace-b64>/<uuid>.json.
// To write the B5 feeder parser we need the exact shape: where the turns
// live, and the {role, content} layout of one turn. This reads the NEWEST
// session file for the current workspace and prints a redacted structural
// digest — never raw conversation content.

const SESSIONS_GLOB = path.join('kiro.kiroagent', 'workspace-sessions');

/** Encode a workspace fs path the way Kiro's folder name appears to (base64).
 *  We don't rely on this for selection (we use mtime), but log it for the
 *  feeder author so they know how to map workspace → folder directly. */
function encodeWorkspaceVariants(wsPath: string): string[] {
    const variants = new Set<string>();
    try {
        variants.add(Buffer.from(wsPath, 'utf-8').toString('base64'));
        variants.add(Buffer.from(wsPath.toLowerCase(), 'utf-8').toString('base64'));
        // Kiro folder names drop '=' padding and use '_' — note for the author.
    } catch { /* ignore */ }
    return [...variants];
}

/** Type of a value, with array element type when uniform-ish. */
function typeOf(v: unknown): string {
    if (v === null) return 'null';
    if (Array.isArray(v)) {
        if (v.length === 0) return 'array(empty)';
        return `array[${v.length}] of ${typeOf(v[0])}`;
    }
    if (typeof v === 'object') return 'object';
    if (typeof v === 'string') return `string(len=${(v as string).length})`;
    return typeof v;
}

/** Print the key→type map of an object, one level deep. */
function describeKeys(out: Logger, obj: Record<string, unknown>, indent: string): void {
    for (const k of Object.keys(obj)) {
        out.raw(`${indent}${k}: ${typeOf(obj[k])}`);
    }
}

/** Find the array within the parsed JSON most likely to be the turn list. */
function findTurnArray(root: any): { path: string; arr: any[] } | null {
    const candidates: Array<{ path: string; arr: any[] }> = [];
    const visit = (node: any, p: string, depth: number) => {
        if (depth > 4 || node == null) return;
        if (Array.isArray(node)) {
            // Heuristic: array of objects that have a role/content/text-ish key.
            const sample = node.find((x) => x && typeof x === 'object');
            if (sample && /role|content|text|message|sender|author|type/i.test(Object.keys(sample).join(','))) {
                candidates.push({ path: p, arr: node });
            }
            return;
        }
        if (typeof node === 'object') {
            for (const k of Object.keys(node)) visit(node[k], `${p}.${k}`, depth + 1);
        }
    };
    visit(root, '$', 0);
    // Prefer the longest array (the real conversation, not a small metadata list).
    candidates.sort((a, b) => b.arr.length - a.arr.length);
    return candidates[0] ?? null;
}

function redactContent(v: unknown): string {
    if (typeof v === 'string') {
        const len = v.length;
        const head = v.slice(0, 60).replace(/\s+/g, ' ');
        return `string(len=${len}) head="${head}${len > 60 ? '…' : ''}"`;
    }
    if (Array.isArray(v)) {
        const inner = v[0];
        return `array[${v.length}] of ${inner && typeof inner === 'object' ? `object{${Object.keys(inner).join(',')}}` : typeOf(inner)}`;
    }
    if (v && typeof v === 'object') return `object{${Object.keys(v as object).join(',')}}`;
    return typeOf(v);
}

async function dumpSchema(out: Logger): Promise<void> {
    out.reveal();
    out.raw('════════════════════════════════════════════════════');
    out.raw('SCHEMA DUMP — newest Kiro session file (redacted structure only)');
    out.raw('────────────────────────────────────────────────────');

    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    out.raw(`current workspace = ${ws || '(none)'}`);
    for (const v of encodeWorkspaceVariants(ws)) {
        out.raw(`  workspace base64 = ${v}`);
    }

    const home = os.homedir();
    const sessRoots = [
        path.join(home, 'AppData', 'Roaming', 'Kiro', 'User', 'globalStorage', SESSIONS_GLOB),
        path.join(home, '.config', 'Kiro', 'User', 'globalStorage', SESSIONS_GLOB),
        path.join(home, 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', SESSIONS_GLOB),
    ];

    // Collect every <uuid>.json under any workspace-sessions folder, pick newest.
    let newest: { file: string; mtime: number } | null = null;
    for (const root of sessRoots) {
        if (!fs.existsSync(root)) continue;
        let wsDirs: string[] = [];
        try { wsDirs = fs.readdirSync(root); } catch { continue; }
        for (const d of wsDirs) {
            const dir = path.join(root, d);
            let files: string[] = [];
            try { files = fs.readdirSync(dir); } catch { continue; }
            for (const f of files) {
                if (!/^[0-9a-f-]{8,}\.json$/i.test(f)) continue; // uuid.json only
                const full = path.join(dir, f);
                try {
                    const m = fs.statSync(full).mtimeMs;
                    if (!newest || m > newest.mtime) newest = { file: full, mtime: m };
                } catch { /* ignore */ }
            }
        }
    }

    if (!newest) {
        out.raw('No <uuid>.json session file found. Cannot dump schema.');
        out.raw('════════════════════════════════════════════════════');
        return;
    }

    out.raw(`newest session file = ${newest.file}`);
    out.raw(`  modified = ${new Date(newest.mtime).toISOString()}`);

    let parsed: any;
    try {
        const raw = fs.readFileSync(newest.file, 'utf-8');
        out.raw(`  file size = ${(raw.length / 1024).toFixed(0)}KB`);
        parsed = JSON.parse(raw);
    } catch (e) {
        out.raw(`  PARSE FAILED: ${(e as Error).message}`);
        out.raw('  (file may be JSONL or partially written — would need line-parse)');
        out.raw('════════════════════════════════════════════════════');
        return;
    }

    out.raw('────────────────────────────────────────────────────');
    out.raw(`TOP-LEVEL is ${Array.isArray(parsed) ? 'an ARRAY' : 'an OBJECT'}`);
    if (!Array.isArray(parsed) && typeof parsed === 'object') {
        out.raw('top-level keys:');
        describeKeys(out, parsed, '  ');
    }

    const turns = findTurnArray(parsed);
    if (!turns) {
        out.raw('Could not locate a turn array. Manual inspection needed.');
        out.raw('════════════════════════════════════════════════════');
        return;
    }

    out.raw('────────────────────────────────────────────────────');
    out.raw(`TURN ARRAY at JSON path: ${turns.path}  (length=${turns.arr.length})`);
    // Print shape of the first, a middle, and the last turn.
    const idxs = [0, Math.floor(turns.arr.length / 2), turns.arr.length - 1]
        .filter((v, i, a) => a.indexOf(v) === i && v >= 0);
    for (const i of idxs) {
        const t = turns.arr[i];
        out.raw(`  turn[${i}] keys + types:`);
        if (t && typeof t === 'object') {
            for (const k of Object.keys(t)) {
                out.raw(`     ${k}: ${redactContent(t[k])}`);
            }
        } else {
            out.raw(`     (non-object: ${typeOf(t)})`);
        }
    }

    // Try to surface the distinct role values so the parser knows the vocab.
    const roleKey = ['role', 'sender', 'author', 'type'].find(
        (k) => turns.arr.some((t) => t && typeof t === 'object' && k in t),
    );
    if (roleKey) {
        const roles = new Set<string>();
        for (const t of turns.arr) {
            if (t && typeof t === 'object' && t[roleKey] != null) roles.add(String(t[roleKey]));
        }
        out.raw(`  distinct "${roleKey}" values: ${[...roles].join(', ')}`);
    }

    out.raw('════════════════════════════════════════════════════');
    vscode.window.showInformationMessage(
        `Schema dump done: turn array len=${turns.arr.length} at ${turns.path}. See Output > MemoryAI.`,
        'Open Output',
    ).then((c) => { if (c === 'Open Output') out.exportLogs(); });
}

// ── B5 feeder test (parse history[] → extract tail → POST to server) ──
//
// This is the real B5 feeder for Kiro, run as a manual probe before wiring it
// into production. It mirrors claude-cli/precompact-runner.ts: read the newest
// session JSON, pull the last N user/assistant turns from history[], and POST
// them as tail_messages to /v1/ide/guard/compact (empty content = tail-save
// only). On the next bootstrap, B5+ synthesizes the work_snapshot and the new
// session resumes the in-progress job.

const FEEDER_TAIL_COUNT = 12;

/** Flatten a Kiro message.content into a plain string. content may be a string
 *  or an array of blocks ([{type:"text",text}], etc.). Skip pure tool traffic. */
function extractKiroContent(message: any): string {
    if (!message) return '';
    const c = message.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
        if (c.some((b: any) => b && (b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'toolCall'))) {
            return '';
        }
        return c
            .map((b: any) => (typeof b === 'string' ? b : (b && typeof b.text === 'string' ? b.text : '')))
            .filter(Boolean)
            .join('\n');
    }
    return '';
}

/** Find the newest <uuid>.json session file across all workspace-sessions. */
function findNewestSessionFile(): { file: string; mtime: number } | null {
    const home = os.homedir();
    const sessRoots = [
        path.join(home, 'AppData', 'Roaming', 'Kiro', 'User', 'globalStorage', SESSIONS_GLOB),
        path.join(home, '.config', 'Kiro', 'User', 'globalStorage', SESSIONS_GLOB),
        path.join(home, 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', SESSIONS_GLOB),
    ];
    let newest: { file: string; mtime: number } | null = null;
    for (const root of sessRoots) {
        if (!fs.existsSync(root)) continue;
        let wsDirs: string[] = [];
        try { wsDirs = fs.readdirSync(root); } catch { continue; }
        for (const d of wsDirs) {
            const dir = path.join(root, d);
            let files: string[] = [];
            try { files = fs.readdirSync(dir); } catch { continue; }
            for (const f of files) {
                if (!/^[0-9a-f-]{8,}\.json$/i.test(f)) continue;
                const full = path.join(dir, f);
                try {
                    const m = fs.statSync(full).mtimeMs;
                    if (!newest || m > newest.mtime) newest = { file: full, mtime: m };
                } catch { /* ignore */ }
            }
        }
    }
    return newest;
}

async function testFeeder(out: Logger, api: ApiClient): Promise<void> {
    out.reveal();
    out.raw('════════════════════════════════════════════════════');
    out.raw('B5 FEEDER TEST — read history[] → extract tail → POST tail_messages');
    out.raw('────────────────────────────────────────────────────');

    const newest = findNewestSessionFile();
    if (!newest) {
        out.raw('No session file found. Abort.');
        out.raw('════════════════════════════════════════════════════');
        return;
    }
    out.raw(`session file = ${newest.file}`);
    out.raw(`  modified = ${new Date(newest.mtime).toISOString()}`);

    let parsed: any;
    try {
        parsed = JSON.parse(fs.readFileSync(newest.file, 'utf-8'));
    } catch (e) {
        out.raw(`PARSE FAILED: ${(e as Error).message}`);
        out.raw('════════════════════════════════════════════════════');
        return;
    }

    const sessionId: string = typeof parsed?.sessionId === 'string' ? parsed.sessionId : '';
    const history: any[] = Array.isArray(parsed?.history) ? parsed.history : [];
    out.raw(`sessionId = ${sessionId || '(missing)'}`);
    out.raw(`history length = ${history.length}`);
    if (typeof parsed?.contextUsagePercentage === 'number') {
        out.raw(`contextUsagePercentage (Kiro's own number) = ${parsed.contextUsagePercentage}`);
    }

    // Extract last N user/assistant turns, newest-last (chronological).
    const tail: Array<{ role: string; content: string }> = [];
    for (let i = history.length - 1; i >= 0 && tail.length < FEEDER_TAIL_COUNT; i--) {
        const msg = history[i]?.message;
        const role = msg?.role;
        if (role !== 'user' && role !== 'assistant') continue;
        const content = extractKiroContent(msg).trim();
        if (!content) continue;
        tail.push({ role, content });
    }
    tail.reverse();

    out.raw('────────────────────────────────────────────────────');
    out.raw(`extracted ${tail.length} tail turn(s) (redacted preview):`);
    for (const t of tail) {
        const head = t.content.slice(0, 80).replace(/\s+/g, ' ');
        out.raw(`   ${t.role}: [len=${t.content.length}] "${head}${t.content.length > 80 ? '…' : ''}"`);
    }

    if (tail.length === 0) {
        out.raw('No usable tail turns (all tool traffic / empty). Abort POST.');
        out.raw('════════════════════════════════════════════════════');
        return;
    }
    if (!sessionId) {
        out.raw('No sessionId in file — server keys the tail buffer on it. Abort POST.');
        out.raw('════════════════════════════════════════════════════');
        return;
    }

    // Confirm before the real server write.
    const go = await vscode.window.showWarningMessage(
        `POST ${tail.length} tail messages to /v1/ide/guard/compact (session ${sessionId.slice(0, 8)})? This writes to the B5 buffer on the server.`,
        { modal: true },
        'POST it',
    );
    if (go !== 'POST it') {
        out.raw('User declined the POST. Tail extracted but not sent.');
        out.raw('════════════════════════════════════════════════════');
        return;
    }

    const projectId = path.basename(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '') || undefined;
    out.raw(`POSTing… project_id=${projectId ?? '(none)'}`);
    const res = await api.saveTail(sessionId, tail, projectId);
    out.raw(`server responded: ok=${res.ok} status="${res.status}"`);
    out.raw(`  raw: ${res.raw}`);
    if (res.ok && res.status === 'tail_saved') {
        out.raw('✓ SUCCESS — tail buffer saved. B5+ work_snapshot synthesizes in background.');
        out.raw('  Next: open a new session, ask about the work — bootstrap should');
        out.raw('  inject "## In-Progress Work" and resume the job.');
    } else {
        out.raw('✗ Unexpected response — inspect raw above.');
    }
    out.raw('════════════════════════════════════════════════════');
    vscode.window.showInformationMessage(
        `B5 feeder test: ${res.ok ? `OK (${res.status})` : 'failed'}. See Output > MemoryAI.`,
        'Open Output',
    ).then((c) => { if (c === 'Open Output') out.exportLogs(); });
}

// ── promptLogs.completion verifier ───────────────────────────────────
//
// The B5 feeder test revealed assistant turns in history[].message.content are
// just the "On it." streaming placeholder — the real answer is elsewhere. The
// schema showed each turn carries promptLogs[] = {modelTitle, prompt,
// completion, completionOptions}. This inspects promptLogs across turns to
// confirm whether `.completion` holds the full assistant text (so the feeder
// can switch to it). Redacted: only lengths + heads, never full content.

async function verifyPromptLogs(out: Logger): Promise<void> {
    out.reveal();
    out.raw('════════════════════════════════════════════════════');
    out.raw('PROMPTLOGS VERIFY — is the real assistant answer in promptLogs[].completion?');
    out.raw('────────────────────────────────────────────────────');

    const newest = findNewestSessionFile();
    if (!newest) {
        out.raw('No session file found. Abort.');
        out.raw('════════════════════════════════════════════════════');
        return;
    }
    out.raw(`session file = ${newest.file}`);

    let parsed: any;
    try {
        parsed = JSON.parse(fs.readFileSync(newest.file, 'utf-8'));
    } catch (e) {
        out.raw(`PARSE FAILED: ${(e as Error).message}`);
        out.raw('════════════════════════════════════════════════════');
        return;
    }

    const history: any[] = Array.isArray(parsed?.history) ? parsed.history : [];
    out.raw(`history length = ${history.length}`);
    out.raw('────────────────────────────────────────────────────');

    let withLogs = 0;
    let completionLongerThanContent = 0;

    for (let i = 0; i < history.length; i++) {
        const turn = history[i];
        const role = turn?.message?.role ?? '?';
        const msgContent = typeof turn?.message?.content === 'string'
            ? turn.message.content
            : JSON.stringify(turn?.message?.content ?? '');
        const logs = Array.isArray(turn?.promptLogs) ? turn.promptLogs : [];

        out.raw(`turn[${i}] role=${role}  message.content len=${msgContent.length}`
            + ` head="${msgContent.slice(0, 40).replace(/\s+/g, ' ')}"`);

        if (logs.length === 0) {
            out.raw('     promptLogs: (none)');
            continue;
        }
        withLogs++;
        for (let j = 0; j < logs.length; j++) {
            const lg = logs[j] ?? {};
            const keys = Object.keys(lg).join(',');
            const comp = lg.completion;
            const compStr = typeof comp === 'string' ? comp : (comp == null ? '' : JSON.stringify(comp));
            const compType = typeof comp === 'string' ? 'string' : typeOf(comp);
            out.raw(`     promptLogs[${j}] keys={${keys}}`);
            out.raw(`        completion: ${compType} len=${compStr.length}`
                + ` head="${compStr.slice(0, 80).replace(/\s+/g, ' ')}${compStr.length > 80 ? '…' : ''}"`);
            if (typeof lg.prompt === 'string') {
                out.raw(`        prompt: string len=${lg.prompt.length}`);
            } else if (lg.prompt != null) {
                out.raw(`        prompt: ${typeOf(lg.prompt)}`);
            }
            if (compStr.length > msgContent.length) completionLongerThanContent++;
        }
    }

    out.raw('────────────────────────────────────────────────────');
    out.raw(`SUMMARY: ${withLogs}/${history.length} turns have promptLogs;`
        + ` ${completionLongerThanContent} completion(s) longer than their message.content.`);
    if (completionLongerThanContent > 0) {
        out.raw('VERDICT: promptLogs[].completion DOES carry richer text than message.content.');
        out.raw('  → Feeder should prefer .completion for assistant turns.');
    } else {
        out.raw('VERDICT: completion is NOT richer here — the real answer may live in a');
        out.raw('  different key (inspect keys above) or only in the rendered chat view.');
    }
    out.raw('════════════════════════════════════════════════════');
    vscode.window.showInformationMessage(
        `promptLogs verify: ${withLogs} turns w/ logs, ${completionLongerThanContent} richer completions. See Output.`,
        'Open Output',
    ).then((c) => { if (c === 'Open Output') out.exportLogs(); });
}

// ── Deep-scan the largest session file ───────────────────────────────
//
// completion was empty in the newest (proxy) session. The largest session may
// be a native run that DOES store the assistant answer. This opens the biggest
// <uuid>.json and, for each assistant turn, dumps every turn-level key, every
// message key, and ANY string field longer than 200 chars (recursively, depth
// 4) with a redacted head — so wherever the real answer hides, it shows up.

function findLargestSessionFile(): { file: string; size: number } | null {
    const home = os.homedir();
    const sessRoots = [
        path.join(home, 'AppData', 'Roaming', 'Kiro', 'User', 'globalStorage', SESSIONS_GLOB),
        path.join(home, '.config', 'Kiro', 'User', 'globalStorage', SESSIONS_GLOB),
        path.join(home, 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', SESSIONS_GLOB),
    ];
    let biggest: { file: string; size: number } | null = null;
    for (const root of sessRoots) {
        if (!fs.existsSync(root)) continue;
        let wsDirs: string[] = [];
        try { wsDirs = fs.readdirSync(root); } catch { continue; }
        for (const d of wsDirs) {
            const dir = path.join(root, d);
            let files: string[] = [];
            try { files = fs.readdirSync(dir); } catch { continue; }
            for (const f of files) {
                if (!/^[0-9a-f-]{8,}\.json$/i.test(f)) continue;
                const full = path.join(dir, f);
                try {
                    const sz = fs.statSync(full).size;
                    if (!biggest || sz > biggest.size) biggest = { file: full, size: sz };
                } catch { /* ignore */ }
            }
        }
    }
    return biggest;
}

/** Walk an object/array up to maxDepth, emitting paths whose string value is
 *  longer than minLen. Redacted head only. */
function findLongStrings(node: any, p: string, depth: number, minLen: number, out: Logger, budget: { n: number }): void {
    if (depth < 0 || budget.n <= 0 || node == null) return;
    if (typeof node === 'string') {
        if (node.length >= minLen) {
            budget.n--;
            const head = node.slice(0, 80).replace(/\s+/g, ' ');
            out.raw(`        ${p}: string(len=${node.length}) "${head}…"`);
        }
        return;
    }
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length && budget.n > 0; i++) {
            findLongStrings(node[i], `${p}[${i}]`, depth - 1, minLen, out, budget);
        }
        return;
    }
    if (typeof node === 'object') {
        for (const k of Object.keys(node)) {
            if (budget.n <= 0) break;
            findLongStrings(node[k], `${p}.${k}`, depth - 1, minLen, out, budget);
        }
    }
}

async function deepScanLargest(out: Logger): Promise<void> {
    out.reveal();
    out.raw('════════════════════════════════════════════════════');
    out.raw('DEEP-SCAN — largest session file, locate the real assistant answer');
    out.raw('────────────────────────────────────────────────────');

    const big = findLargestSessionFile();
    if (!big) {
        out.raw('No session file found. Abort.');
        out.raw('════════════════════════════════════════════════════');
        return;
    }
    out.raw(`largest session file = ${big.file}`);
    out.raw(`  size = ${(big.size / 1024 / 1024).toFixed(2)}MB`);

    let parsed: any;
    try {
        parsed = JSON.parse(fs.readFileSync(big.file, 'utf-8'));
    } catch (e) {
        out.raw(`PARSE FAILED: ${(e as Error).message}`);
        out.raw('════════════════════════════════════════════════════');
        return;
    }

    const history: any[] = Array.isArray(parsed?.history) ? parsed.history : [];
    out.raw(`history length = ${history.length}`);

    // Inspect up to the last 6 assistant turns in detail.
    const assistantIdx = history
        .map((t, i) => ({ i, role: t?.message?.role }))
        .filter((x) => x.role === 'assistant')
        .map((x) => x.i);
    const toShow = assistantIdx.slice(-6);
    out.raw(`assistant turns: ${assistantIdx.length} total; inspecting last ${toShow.length}`);
    out.raw('────────────────────────────────────────────────────');

    for (const i of toShow) {
        const turn = history[i];
        out.raw(`turn[${i}] (assistant) — turn-level keys: ${Object.keys(turn ?? {}).join(', ')}`);
        const msg = turn?.message ?? {};
        out.raw(`   message keys: ${Object.keys(msg).join(', ')}`);
        const mc = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
        out.raw(`   message.content: len=${mc.length} head="${mc.slice(0, 60).replace(/\s+/g, ' ')}"`);
        out.raw('   long string fields (>200 chars) anywhere in this turn:');
        const budget = { n: 12 };
        findLongStrings(turn, '$', 4, 200, out, budget);
        if (budget.n === 12) out.raw('        (none found — turn carries no long text)');
    }

    out.raw('════════════════════════════════════════════════════');
    vscode.window.showInformationMessage(
        `Deep-scan done on ${(big.size / 1024 / 1024).toFixed(1)}MB file. See Output > MemoryAI.`,
        'Open Output',
    ).then((c) => { if (c === 'Open Output') out.exportLogs(); });
}

// ── Active-session resolver ──────────────────────────────────────────
//
// The feeder picked the newest-mtime file and got a STALE session (Kiro hadn't
// flushed the live chat to disk). To pick the truly active session we need a
// better signal. Each session file has: sessionId, active (bool), activeTabId,
// activeTabs[]. The workspace folder also has a sessions.json index. This dumps
// all of them so we can decide the right selector: `active===true`, or the tab
// whose id === activeTabId, or sessions.json ordering.

function workspaceFolderCandidates(wsPath: string): string[] {
    const names = new Set<string>();
    if (!wsPath) return [];
    for (const v of [wsPath, wsPath.toLowerCase()]) {
        try {
            const b64 = Buffer.from(v, 'utf-8').toString('base64');
            names.add(b64);
            names.add(b64.replace(/=+$/, ''));
            names.add(b64.replace(/=+$/, '').replace(/\//g, '_'));
        } catch { /* ignore */ }
    }
    return [...names];
}

async function inspectActiveSession(out: Logger): Promise<void> {
    out.reveal();
    out.raw('════════════════════════════════════════════════════');
    out.raw('ACTIVE SESSION — sessions.json index + per-file activeTabId/active/mtime');
    out.raw('────────────────────────────────────────────────────');

    const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    out.raw(`workspace = ${wsPath || '(none)'}`);
    const candidates = workspaceFolderCandidates(wsPath);

    const home = os.homedir();
    const roots = [
        path.join(home, 'AppData', 'Roaming', 'Kiro', 'User', 'globalStorage', SESSIONS_GLOB),
        path.join(home, '.config', 'Kiro', 'User', 'globalStorage', SESSIONS_GLOB),
        path.join(home, 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', SESSIONS_GLOB),
    ];

    // Locate the workspace folder.
    let wsDir = '';
    for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        let dirs: string[] = [];
        try { dirs = fs.readdirSync(root); } catch { continue; }
        for (const d of dirs) {
            if (candidates.includes(d)) { wsDir = path.join(root, d); break; }
        }
        if (wsDir) break;
    }
    if (!wsDir) {
        out.raw('Could not match a workspace-sessions folder for this workspace.');
        out.raw(`  tried folder names: ${candidates.join(', ')}`);
        out.raw('════════════════════════════════════════════════════');
        return;
    }
    out.raw(`workspace-sessions dir = ${wsDir}`);

    // 1) Dump sessions.json index.
    const indexPath = path.join(wsDir, 'sessions.json');
    out.raw('────────────────────────────────────────────────────');
    if (fs.existsSync(indexPath)) {
        try {
            const idx = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
            out.raw(`sessions.json: top-level is ${Array.isArray(idx) ? `array[${idx.length}]` : 'object'}`);
            const arr = Array.isArray(idx) ? idx : (Array.isArray(idx?.sessions) ? idx.sessions : []);
            out.raw(`  entries: ${arr.length}`);
            for (const e of arr.slice(0, 12)) {
                if (e && typeof e === 'object') {
                    const id = e.sessionId ?? e.id ?? '?';
                    const title = (e.title ?? '').toString().slice(0, 40);
                    const keys = Object.keys(e).join(',');
                    out.raw(`   · ${id}  title="${title}"  keys={${keys}}`);
                } else {
                    out.raw(`   · ${String(e).slice(0, 50)}`);
                }
            }
            // If the index records an order/last-active, surface any non-array keys.
            if (!Array.isArray(idx) && typeof idx === 'object') {
                out.raw(`  object keys: ${Object.keys(idx).join(', ')}`);
            }
        } catch (e) {
            out.raw(`sessions.json parse failed: ${(e as Error).message}`);
        }
    } else {
        out.raw('sessions.json: (not present)');
    }

    // 2) Per session file: sessionId / active / activeTabId / history len / mtime.
    out.raw('────────────────────────────────────────────────────');
    out.raw('session files (sorted by mtime desc):');
    let files: Array<{ f: string; mtime: number }> = [];
    try {
        files = fs.readdirSync(wsDir)
            .filter((f) => /^[0-9a-f-]{8,}\.json$/i.test(f))
            .map((f) => {
                const full = path.join(wsDir, f);
                let mtime = 0;
                try { mtime = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
                return { f: full, mtime };
            })
            .sort((a, b) => b.mtime - a.mtime);
    } catch { /* ignore */ }

    for (const { f, mtime } of files.slice(0, 10)) {
        let p: any;
        try { p = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { out.raw(`   [parse-fail] ${path.basename(f)}`); continue; }
        const sid = p?.sessionId ?? '?';
        const active = p?.active;
        const activeTabId = p?.activeTabId ?? '?';
        const tabs = Array.isArray(p?.activeTabs) ? p.activeTabs.length : 0;
        const hist = Array.isArray(p?.history) ? p.history.length : 0;
        const ctxPct = typeof p?.contextUsagePercentage === 'number' ? p.contextUsagePercentage.toFixed(1) : '?';
        const tabMatch = activeTabId === sid ? ' [activeTabId==sessionId]' : '';
        out.raw(`   ${new Date(mtime).toISOString()}  active=${active}  hist=${hist}  ctx=${ctxPct}%`);
        out.raw(`      sessionId=${sid}  activeTabId=${activeTabId}  tabs=${tabs}${tabMatch}`);
    }

    out.raw('────────────────────────────────────────────────────');
    out.raw('SELECTOR HINT: prefer a file with active===true; if several, the one whose');
    out.raw('  activeTabId matches a session in activeTabs, or highest contextUsagePercentage.');
    out.raw('════════════════════════════════════════════════════');
    vscode.window.showInformationMessage(
        `Active-session inspect done (${files.length} files). See Output > MemoryAI.`,
        'Open Output',
    ).then((c) => { if (c === 'Open Output') out.exportLogs(); });
}


