/**
 * HookInstaller — owns the host-specific glue files so the user does not
 * have to edit them manually. Writing is idempotent and reversible.
 *
 * Per host:
 *   Kiro       → .kiro/hooks/memoryai-auto-recall.kiro.hook
 *                .kiro/hooks/memoryai-auto-capture.kiro.hook
 *                ~/.kiro/settings/mcp.json (memoryai entry only — other
 *                                           servers stay untouched)
 *   Cursor     → ~/.cursor/mcp.json (memoryai entry)
 *                .cursor/rules/memoryai.mdc (per-project rules)
 *   Windsurf   → ~/.codeium/windsurf/mcp_config.json (memoryai entry)
 *                .windsurfrules (per-project rules)
 *   VS Code    → ~/.config/Code/User/mcp.json (memoryai entry)
 *
 * Files we write are owned by us — Disconnect() removes only the
 * `memoryai` keys / files we created, never touching foreign content.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import * as vscode from 'vscode';
import { HostAdapter } from './host';
import { Logger } from './logger';

interface ConnectInputs {
    endpoint: string;
    apiKey: string;
    /** The model's context window in tokens (200000 / 1000000 / custom).
     *  Single source of truth for how big "full" is. */
    contextWindow?: number;
    /** Critical fill % (force save + notice). */
    criticalPercent?: number;
    /** Soft compact fill % (silent save) = critical × 0.85. */
    compactPercent?: number;
    /** Absolute token count for the soft compact warning (window × compact%). */
    compactAtTokens?: number;
    /** Absolute token count for the forced (critical) compact (window × critical%). */
    criticalAtTokens?: number;
}

export class HookInstaller {
    constructor(
        private host: HostAdapter,
        private log: Logger,
    ) {}

    /**
     * Wire everything for the detected host. Idempotent: re-running with the
     * same inputs is a no-op except for refreshing schemas.
     *
     * NOTE v0.1.2+: only MCP server registration. No askAgent hooks —
     * those forced a reasoning round per turn and burned host credits.
     * The agent uses the registered tools on-demand instead.
     */
    async wire(inputs: ConnectInputs): Promise<{ wrote: string[]; skipped: string[] }> {
        const wrote: string[] = [];
        const skipped: string[] = [];

        try {
            const mcpFiles = this.mcpConfigPaths();
            for (const p of mcpFiles) {
                if (this.upsertMcp(p, inputs)) wrote.push(p);
                else skipped.push(p);
            }

            // Aggressively clean up any legacy hooks left behind from
            // pre-0.1.2 installs that forced askAgent on every turn.
            for (const p of this.legacyHookPaths()) {
                try {
                    if (fs.existsSync(p)) {
                        fs.unlinkSync(p);
                        this.log.info(`removed legacy hook ${p}`);
                    }
                } catch {
                    // best-effort
                }
            }

            // v0.1.3: ONE guard hook on Kiro (turn>=15 conditional). Other
            // hosts use rules files written below.
            for (const hookSpec of this.hookSpecs(inputs)) {
                if (this.writeFileIfChanged(hookSpec.path, hookSpec.content)) wrote.push(hookSpec.path);
                else skipped.push(hookSpec.path);
            }

            for (const ruleSpec of this.ruleSpecs(inputs)) {
                if (this.writeFileIfChanged(ruleSpec.path, ruleSpec.content)) wrote.push(ruleSpec.path);
                else skipped.push(ruleSpec.path);
            }
        } catch (e) {
            this.log.error(`wire failed: ${(e as Error).message}`);
            throw e;
        }

        for (const p of wrote) this.log.info(`wired ${p}`);
        return { wrote, skipped };
    }

    /** Remove only the memoryai-owned keys / files. Foreign content untouched. */
    async unwire(): Promise<{ removed: string[] }> {
        const removed: string[] = [];

        for (const p of this.mcpConfigPaths()) {
            if (this.removeMcpEntry(p)) removed.push(p);
        }
        // Wipe both current hook specs (none in v0.1.2+) and any legacy
        // ones from earlier versions that did install askAgent hooks.
        const allHookPaths = [
            ...this.hookSpecs().map((s) => s.path),
            ...this.legacyHookPaths(),
            ...this.ruleSpecs(undefined).map((s) => s.path),
        ];
        for (const p of allHookPaths) {
            try {
                if (fs.existsSync(p)) {
                    fs.unlinkSync(p);
                    removed.push(p);
                }
            } catch (e) {
                this.log.warn(`could not remove ${p}: ${(e as Error).message}`);
            }
        }
        return { removed };
    }

    // ── MCP config paths per host ──────────────────────────────────────

    private mcpConfigPaths(): string[] {
        const home = os.homedir();
        switch (this.host.id) {
            case 'kiro':
                return [path.join(home, '.kiro', 'settings', 'mcp.json')];
            case 'cursor':
                return [path.join(home, '.cursor', 'mcp.json')];
            case 'windsurf':
                return [path.join(home, '.codeium', 'windsurf', 'mcp_config.json')];
            case 'vscode':
                // VS Code stock uses settings.json mcp section since 1.94+.
                // We'll target the standalone mcp.json some forks read.
                if (process.platform === 'win32') {
                    return [path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'mcp.json')];
                }
                if (process.platform === 'darwin') {
                    return [path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')];
                }
                return [path.join(home, '.config', 'Code', 'User', 'mcp.json')];
            default:
                return [];
        }
    }

    private upsertMcp(filePath: string, inputs: ConnectInputs): boolean {
        const block = {
            command: 'npx',
            args: ['-y', 'memoryai-mcp'],
            env: {
                HM_ENDPOINT: inputs.endpoint,
                HM_API_KEY: inputs.apiKey,
                // Context-guard policy is now percent-native and fully
                // explicit — no model-name guessing, no server-side window
                // default. The extension derives an absolute compact/critical
                // token pair from contextWindow × percent and forwards all of
                // it. The runtime guard compares Kiro's own
                // contextUsagePercentage against compact/critical %, so these
                // env values are the authoritative source for any host that
                // reads them server-side too.
                ...(inputs.contextWindow ? { MEMORYAI_CONTEXT_WINDOW: String(inputs.contextWindow) } : {}),
                ...(inputs.criticalPercent ? { MEMORYAI_CRITICAL_PCT: String(inputs.criticalPercent) } : {}),
                ...(inputs.compactPercent ? { MEMORYAI_COMPACT_PCT: String(inputs.compactPercent) } : {}),
                ...(inputs.compactAtTokens ? { MEMORYAI_COMPACT_AT: String(inputs.compactAtTokens) } : {}),
                ...(inputs.criticalAtTokens ? { MEMORYAI_CRITICAL_AT: String(inputs.criticalAtTokens) } : {}),
            },
            disabled: false,
            autoApprove: [
                'memory_bootstrap',
                'memory_recall',
                'memory_store',
                'memory_pitfall_check',
                'context_guard_check',
                'context_guard_compact',
                'ide_turn_check',
                'l2_inject',
            ],
        };
        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            const cur = this.readJsonSafe(filePath);
            cur.mcpServers = cur.mcpServers || {};
            const before = JSON.stringify(cur.mcpServers.memoryai);
            cur.mcpServers.memoryai = block;
            const after = JSON.stringify(cur.mcpServers.memoryai);
            if (before === after) return false;
            fs.writeFileSync(filePath, JSON.stringify(cur, null, 2) + '\n', 'utf-8');
            return true;
        } catch (e) {
            this.log.warn(`mcp upsert failed (${filePath}): ${(e as Error).message}`);
            return false;
        }
    }

    private removeMcpEntry(filePath: string): boolean {
        if (!fs.existsSync(filePath)) return false;
        try {
            const cur = this.readJsonSafe(filePath);
            if (!cur.mcpServers || !cur.mcpServers.memoryai) return false;
            delete cur.mcpServers.memoryai;
            // If the only entry was ours, leave the empty object so the file
            // stays valid for whatever runtime watches it.
            fs.writeFileSync(filePath, JSON.stringify(cur, null, 2) + '\n', 'utf-8');
            return true;
        } catch (e) {
            this.log.warn(`mcp remove failed (${filePath}): ${(e as Error).message}`);
            return false;
        }
    }

    // ── Hook files per host ────────────────────────────────────────────
    //
    // Kiro only — and only ONE hook (Recall). It fires on promptSubmit
    // (BEFORE the answer), restores memory, and runs the context guard in
    // the same pass. Because it runs before the reply, the model finishes
    // the background work and then answers normally — no stray output.
    //
    // v0.2.4 history: there used to be a second "Guard" hook on agentStop.
    // It fired AFTER every turn, forced an askAgent reasoning pass, emitted
    // a stray "." into the chat, and burned ~1.5 credits/turn even when the
    // session was idle below turn 15. The old comment here claimed turn
    // 1-14 cost "$0.000 LLM" — that was wrong; askAgent on Kiro is never
    // free. The guard logic now lives inside Recall and is gated to
    // turn >= 15, so the expensive ide_turn_check only runs when relevant.
    //
    // Why not no-hook on Kiro? Because Kiro's MCP integration doesn't pull
    // the assistant audience-tag of a tool response — piggybacking lands
    // but the model treats it as user-visible text and may surface it.
    // The hook gives us a deterministic check the model already expects to
    // act on.

    private hookSpecs(inputs?: ConnectInputs): Array<{ path: string; content: string }> {
        if (this.host.id !== 'kiro') return [];
        const ws = this.workspaceRoot();
        if (!ws) return [];

        // maxTokens for the Kiro hook = the configured context window. The
        // hook tells ide_turn_check the real window so the guard reasons in
        // true tokens, not a hard-coded default.
        const maxTokens = inputs?.contextWindow ?? 200_000;

        return [
            {
                // ONE hook only (v0.2.4+). Recall now ALSO carries the
                // turn/context-guard check. It runs on promptSubmit — BEFORE
                // the answer — so the background work finishes first and the
                // model answers normally. The old separate Guard hook fired
                // on agentStop (AFTER each turn) and forced an askAgent pass
                // that emitted a stray "." and burned ~1.5 credits per turn
                // even when idle. Merging removes both problems.
                path: path.join(ws, '.kiro', 'hooks', 'memoryai-recall.kiro.hook'),
                content: JSON.stringify(generateKiroRecallHook(maxTokens), null, 2) + '\n',
            },
        ];
    }

    /** Legacy hook paths from older extension versions — always cleaned up. */
    private legacyHookPaths(): string[] {
        const ws = this.workspaceRoot();
        if (!ws || this.host.id !== 'kiro') return [];
        return [
            // Old auto-recall (v1) + auto-capture (every-turn askAgent, too
            // costly). The new memoryai-recall.kiro.hook replaces auto-recall.
            path.join(ws, '.kiro', 'hooks', 'memoryai-auto-recall.kiro.hook'),
            path.join(ws, '.kiro', 'hooks', 'memoryai-auto-capture.kiro.hook'),
            // v0.2.4: the standalone Guard hook (agentStop + askAgent) is
            // retired. It fired AFTER every turn and emitted a stray "." plus
            // ~1.5 credits/turn even when idle. The turn/context check now
            // lives inside the Recall hook (promptSubmit). Listed here so an
            // update wipes it from already-connected users automatically.
            path.join(ws, '.kiro', 'hooks', 'memoryai-guard.kiro.hook'),
        ];
    }

    // ── Rules files for hosts that read them as system context ────────

    private ruleSpecs(inputs?: ConnectInputs): Array<{ path: string; content: string }> {
        const ws = this.workspaceRoot();
        if (!ws) return [];

        // max_tokens for rules = the configured context window. Percent
        // thresholds (compact/critical) live on the server env; the rule only
        // needs the window so ide_turn_check reasons in real tokens.
        const maxTokens = inputs?.contextWindow ?? 200_000;

        if (this.host.id === 'cursor') {
            return [{
                path: path.join(ws, '.cursor', 'rules', 'memoryai.mdc'),
                content: '---\n'
                    + 'description: MemoryAI shared memory + 15-turn work-snapshot guard\n'
                    + 'alwaysApply: true\n'
                    + '---\n\n'
                    + this.guardRulesBody(maxTokens),
            }];
        }
        if (this.host.id === 'windsurf') {
            return [{
                path: path.join(ws, '.windsurfrules'),
                content: this.guardRulesBody(maxTokens),
            }];
        }
        if (this.host.id === 'vscode') {
            // VS Code + Copilot reads repo-level custom instructions from
            // .github/copilot-instructions.md. Same body so the 15-turn guard
            // applies here too.
            return [{
                path: path.join(ws, '.github', 'copilot-instructions.md'),
                content: this.guardRulesBody(maxTokens),
            }];
        }
        return [];
    }

    /**
     * Shared "15-turn work-snapshot guard" rules body for GUI hosts that don't
     * expose context to an extension (Windsurf, Cursor, VS Code+Copilot). The
     * agent itself runs the loop, since these IDEs hide their context window.
     *
     * Design (founder spec):
     *   • Every 15 assistant turns, save ONE work-snapshot chunk capturing the
     *     in-progress job (goal, decisions, current step, next step) so a fresh
     *     session can resume perfectly. Tagged + timestamped; newest wins.
     *   • Tell the user it's saved and they may /compact or open a new chat.
     *   • On a new session / after compact: bootstrap + recall pull the most
     *     RECENT work-snapshot first (time-ordered) so work resumes seamlessly.
     */
    private guardRulesBody(maxTokens: number): string {
        return `# MemoryAI — shared memory + 15-turn work-snapshot guard

Calls the MCP server "memoryai". Window hint for this host: ${maxTokens} tokens.

## Resume first (start of every session)
1. On the FIRST turn, call memory_bootstrap once.
2. Then call memory_recall with a query like "current work snapshot / what was
   I doing" and, when present, CONTINUE the most recent work-snapshot (they are
   time-ordered — prefer the newest). This is how a new chat opened after a
   /compact or a fresh window resumes the in-progress job seamlessly.
3. If the user references past work/decisions, recall before answering.
4. Skip recall on trivial small-talk.

## Capture as you go (silent)
- When a turn produces a decision, preference, important fact, lesson from a
  mistake (pitfall), or reusable procedure, call memory_store with the right
  memory_type. Never store secrets. This runs silently.

## Every 15 assistant turns — work snapshot + handoff
Count your assistant turns. Each time the count reaches a multiple of 15
(15, 30, 45 ...):
1. Call memory_store with ONE consolidated work-snapshot chunk:
     content_type: "todo", memory_type: "goal", importance: 0.9,
     tags: ["work-snapshot", "resume"],
     content: a compact summary of — the GOAL, key DECISIONS so far, the
     CURRENT step, and the NEXT step. Write it so a fresh session could pick up
     with zero extra context.
2. Also call ide_turn_check (turn_count, max_tokens=${maxTokens}, model if
   known) and follow its action_prompt verbatim.
3. Then surface ONE short line to the user (this is the only allowed notice):
     "Saved a work snapshot to MemoryAI (turn N). You can /compact or open a
      new chat — I'll recall it and continue exactly where we left off."

## Rules
- All saving is silent except the single handoff line above.
- The work snapshot is a fresh chunk each 15-turn mark; recall always prefers
  the newest, so resume reflects the latest state.
- Never mention the memory system otherwise.
`;
    }

    // ── helpers ────────────────────────────────────────────────────────

    private workspaceRoot(): string | null {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) return null;
        return folders[0].uri.fsPath;
    }

    private readJsonSafe(p: string): any {
        if (!fs.existsSync(p)) return {};
        try { return JSON.parse(fs.readFileSync(p, 'utf-8')) || {}; }
        catch { return {}; }
    }

    private writeFileIfChanged(p: string, content: string): boolean {
        try {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
            if (cur === content) return false;
            fs.writeFileSync(p, content, 'utf-8');
            return true;
        } catch (e) {
            this.log.warn(`write failed (${p}): ${(e as Error).message}`);
            return false;
        }
    }
}

// ── Hook bodies ────────────────────────────────────────────────────────
// Single hook for Kiro: Recall. Fires on promptSubmit (BEFORE the answer).
// Restores long-term memory and runs the context guard in the same pass.
//
// Why promptSubmit not agentStop:
//   • promptSubmit runs BEFORE the reply → the model does the background
//     work, then answers the user normally. No trailing output.
//   • agentStop (the old Guard hook) ran AFTER the reply → it forced a
//     fresh askAgent pass whose only job was "stay silent", which leaked a
//     stray "." into the chat and cost ~1.5 credits per idle turn.
//
// The agent's `ide_turn_check` tool call is itself piggyback-eligible: the
// MCP server sees the call, evaluates context pressure, and includes any
// pending directive (from RecallQueue or compact escalation) inline. Thus
// even when the hook fires, the cost is still bounded by piggybacking.

const KIRO_RECALL_HOOK_LEGACY_DELETED = null; // (kept as marker; real hook now built by generateKiroRecallHook)

function generateKiroRecallHook(maxTokens: number) {
    return {
        enabled: true,
        name: 'MemoryAI Recall',
        description:
            'Restores long-term memory at the start of a chat, pulls relevant ' +
            'context when the user references past work, and runs the context ' +
            'guard before answering. One hook, fires on promptSubmit so all ' +
            'background work finishes before the reply.',
        version: '2',
        when: { type: 'promptSubmit' },
        then: {
            type: 'askAgent',
            prompt:
                'Before answering, make sure you have the relevant long-term ' +
                'memory. Do this quietly and integrate it naturally — never dump ' +
                'raw tool output.\n\n' +
                '1. FIRST TURN of this chat (no prior assistant messages yet): ' +
                'call memory_bootstrap ONCE to load preferences, decisions, ' +
                'identity, and recent project context. This is how a freshly ' +
                'opened chat picks up where the previous one left off.\n' +
                '2. If the user references past work, decisions, preferences, or ' +
                'anything that might be stored ("what did we", "last time", "our ' +
                'approach", "why did we", or a project question), call ' +
                'memory_recall with a focused query before answering.\n' +
                '3. Trivial small-talk: skip recall.\n\n' +
                'CONTEXT GUARD (same turn, before you answer): count the ' +
                'assistant turns in this conversation. If the count is 15 or ' +
                'higher, call ide_turn_check with turn_count = (your count), ' +
                `max_tokens = ${maxTokens}, and model = (your model name if known), ` +
                'then follow its action_prompt VERBATIM. Below turn 15, skip the ' +
                'guard entirely. All saving is silent — when asked to save, call ' +
                'context_guard_compact and say nothing about it. The ONLY message ' +
                'you may ever surface is the single "context is full" notice, and ' +
                'only when the action_prompt explicitly contains it, once per ' +
                'session.\n\n' +
                'Use what you recall to answer. Do not announce that a memory ' +
                'system exists unless asked.',
        },
    };
}
