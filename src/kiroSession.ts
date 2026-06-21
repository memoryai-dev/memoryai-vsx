/**
 * kiroSession — read the ACTIVE Kiro chat session from disk and surface the
 * two things the context guard needs:
 *
 *   1. contextUsagePercentage — Kiro's own, exact fill level (0–100). This is
 *      the truth the guard compares against compact/critical %, so we never
 *      estimate tokens or guess from turn counts.
 *   2. the tail of user/assistant turns — for the B5 feeder (save-before-spawn
 *      so the next session resumes the in-progress job).
 *
 * Kiro stores each session as a single <uuid>.json under
 *   globalStorage/kiro.kiroagent/workspace-sessions/<workspace-b64>/<uuid>.json
 *
 * Selecting the ACTIVE session matters: the newest-mtime file can be stale
 * (Kiro flushes lazily). We prefer `active === true`, then the file whose
 * activeTabId matches its sessionId, then highest contextUsagePercentage, then
 * newest mtime — mirroring what the probe's inspectActiveSession established.
 *
 * All disk reads are best-effort and never throw into the caller.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const SESSIONS_GLOB = path.join('kiro.kiroagent', 'workspace-sessions');

export interface KiroSessionInfo {
    file: string;
    sessionId: string;
    /** Kiro's own fill level, 0–100. -1 when the file doesn't carry it. */
    contextUsagePercentage: number;
    active: boolean;
    activeTabId: string;
    historyLength: number;
    mtime: number;
    /** Role of the last user/assistant message in history ('' if none). When
     *  this is 'assistant' the agent has produced its answer. */
    lastRole: string;
    /** True when the agent is mid-work (gathering context / awaiting a
     *  clarification). Used to detect the idle turn boundary for auto-spawn. */
    busy: boolean;
}

export interface TailMessage {
    role: string;
    content: string;
}

/** All globalStorage roots Kiro may use across platforms. */
function sessionRoots(): string[] {
    const home = os.homedir();
    return [
        path.join(home, 'AppData', 'Roaming', 'Kiro', 'User', 'globalStorage', SESSIONS_GLOB),
        path.join(home, '.config', 'Kiro', 'User', 'globalStorage', SESSIONS_GLOB),
        path.join(home, 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', SESSIONS_GLOB),
    ];
}

/** Candidate folder names a workspace path may hash to (base64 variants). */
function workspaceFolderCandidates(wsPath: string): string[] {
    const names = new Set<string>();
    if (!wsPath) return [];
    for (const v of [wsPath, wsPath.toLowerCase()]) {
        try {
            const b64 = Buffer.from(v, 'utf-8').toString('base64');
            names.add(b64);
            names.add(b64.replace(/=+$/, ''));
            names.add(b64.replace(/=+$/, '').replace(/\//g, '_'));
        } catch {
            /* ignore */
        }
    }
    return [...names];
}

/** Locate the workspace-sessions directory for this workspace, if any. */
function findWorkspaceDir(wsPath: string): string | null {
    const candidates = workspaceFolderCandidates(wsPath);
    for (const root of sessionRoots()) {
        if (!fs.existsSync(root)) continue;
        let dirs: string[] = [];
        try {
            dirs = fs.readdirSync(root);
        } catch {
            continue;
        }
        // Exact base64 match first.
        for (const d of dirs) {
            if (candidates.includes(d)) return path.join(root, d);
        }
    }
    return null;
}

function readSessionInfo(file: string): KiroSessionInfo | null {
    let parsed: any;
    let mtime = 0;
    try {
        mtime = fs.statSync(file).mtimeMs;
        parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return null;
    }
    const pct = typeof parsed?.contextUsagePercentage === 'number'
        ? parsed.contextUsagePercentage
        : -1;
    // Last user/assistant role in history — 'assistant' means the agent has
    // finished its answer (turn boundary). Tool-only trailing entries are
    // skipped so we read the real conversational role.
    let lastRole = '';
    const history: any[] = Array.isArray(parsed?.history) ? parsed.history : [];
    for (let i = history.length - 1; i >= 0; i--) {
        const r = history[i]?.message?.role;
        if (r === 'user' || r === 'assistant') { lastRole = r; break; }
    }
    const busy = parsed?.isGatheringContext === true
        || parsed?.hasPendingIntentClarification === true
        || parsed?.ttsActive === true;
    return {
        file,
        sessionId: typeof parsed?.sessionId === 'string' ? parsed.sessionId : '',
        contextUsagePercentage: pct,
        active: parsed?.active === true,
        activeTabId: typeof parsed?.activeTabId === 'string' ? parsed.activeTabId : '',
        historyLength: history.length,
        mtime,
        lastRole,
        busy,
    };
}

/**
 * Pick the ACTIVE session for the given workspace. Returns null when no
 * session file is found (e.g. host isn't Kiro, or nothing persisted yet).
 *
 * Selection priority:
 *   1. active === true
 *   2. activeTabId === sessionId
 *   3. highest contextUsagePercentage
 *   4. newest mtime
 */
export function findActiveSession(wsPath: string): KiroSessionInfo | null {
    const wsDir = findWorkspaceDir(wsPath);
    if (!wsDir) return null;

    let files: string[] = [];
    try {
        files = fs.readdirSync(wsDir).filter((f) => /^[0-9a-f-]{8,}\.json$/i.test(f));
    } catch {
        return null;
    }

    const infos: KiroSessionInfo[] = [];
    for (const f of files) {
        const info = readSessionInfo(path.join(wsDir, f));
        if (info) infos.push(info);
    }
    if (infos.length === 0) return null;

    infos.sort((a, b) => {
        // Primary signal: newest mtime — the file Kiro is actively writing is
        // the session the user is in right now. On-disk `active` is unreliable
        // (often false for every file) and the old "highest ctx" tiebreaker
        // actively chose WRONG: it stuck to whichever session was fullest,
        // which after an auto-spawn is the OLD, abandoned session (already at
        // its ceiling) rather than the fresh one the user moved to.
        if (b.mtime !== a.mtime) return b.mtime - a.mtime;
        // Same mtime (rare): prefer the one whose tab is focused, then fuller.
        const aTab = a.activeTabId && a.activeTabId === a.sessionId ? 1 : 0;
        const bTab = b.activeTabId && b.activeTabId === b.sessionId ? 1 : 0;
        if (aTab !== bTab) return bTab - aTab;
        return b.contextUsagePercentage - a.contextUsagePercentage;
    });

    return infos[0];
}

/** Flatten a Kiro message.content (string or block array) to plain text.
 *  Returns '' for pure tool traffic so the tail stays human-readable. */
function extractContent(message: any): string {
    if (!message) return '';
    const c = message.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
        if (c.some((b: any) => b && (b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'toolCall'))) {
            return '';
        }
        return c
            .map((b: any) => (typeof b === 'string' ? b : b && typeof b.text === 'string' ? b.text : ''))
            .filter(Boolean)
            .join('\n');
    }
    return '';
}

/**
 * Read the last `count` user/assistant turns from a session file, newest-last.
 * Best-effort; returns [] when nothing usable is found.
 */
export function readTail(file: string, count = 12): TailMessage[] {
    let parsed: any;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return [];
    }
    const history: any[] = Array.isArray(parsed?.history) ? parsed.history : [];
    const tail: TailMessage[] = [];
    for (let i = history.length - 1; i >= 0 && tail.length < count; i--) {
        const msg = history[i]?.message;
        const role = msg?.role;
        if (role !== 'user' && role !== 'assistant') continue;
        const content = extractContent(msg).trim();
        if (!content) continue;
        tail.push({ role, content });
    }
    tail.reverse();
    return tail;
}
