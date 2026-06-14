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
    /** Optional model hint (e.g. "claude-opus-4-8[1m]") so the server can
     *  auto-detect the context window and pick the adaptive compact trigger.
     *  Used in auto mode. Omit for the 200K default. */
    model?: string;
    /** Manual mode: absolute token count for the soft compact warning.
     *  When set (with criticalAtTokens), forwarded as MEMORYAI_COMPACT_AT
     *  and wins over the model-derived adaptive trigger. */
    compactAtTokens?: number;
    /** Manual mode: absolute token count for the forced (critical) compact. */
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
            for (const hookSpec of this.hookSpecs()) {
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
                // Server owns context-guard policy. Two modes:
                //   AUTO — set MEMORYAI_MODEL; server resolves the window and
                //          picks the adaptive trigger:
                //            window <= 200K → compact at 95%  (Claude/GPT/Sonnet)
                //            window  > 200K → compact at 30%  (1M Opus / Gemini)
                //          Blank model → 200K default.
                //   MANUAL — set MEMORYAI_COMPACT_AT + MEMORYAI_CRITICAL_AT to
                //          absolute token counts; these win over the adaptive %.
                ...(inputs.model ? { MEMORYAI_MODEL: inputs.model } : {}),
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
    // Kiro only — and only ONE hook (the "guard"). It fires on agentStop,
    // tells the agent to call ide_turn_check (a single MCP tool call), and
    // short-circuits to "do nothing" if turn_count < 15. So the cost is:
    //
    //   Turn 1-14:   one MCP tool call per turn ($0.000 LLM, just RTT)
    //   Turn 15+:    one tool call + agent follows action_prompt
    //                ≈ $0.005/turn, only when needed
    //
    // Total ~$0.03 per session (if a session runs 25+ turns).
    // Compare v0.1.1 askAgent every turn = $1.50/session.
    //
    // Why not no-hook on Kiro? Because Kiro's MCP integration doesn't pull
    // the assistant audience-tag of a tool response — piggybacking lands
    // but the model treats it as user-visible text and may surface it.
    // The guard hook gives us a deterministic check the model already
    // expects to act on.

    private hookSpecs(): Array<{ path: string; content: string }> {
        if (this.host.id !== 'kiro') return [];
        const ws = this.workspaceRoot();
        if (!ws) return [];
        return [
            {
                path: path.join(ws, '.kiro', 'hooks', 'memoryai-guard.kiro.hook'),
                content: JSON.stringify(KIRO_GUARD_HOOK, null, 2) + '\n',
            },
            {
                // Bootstrap-on-session-start. Kiro has no SessionStart event,
                // so we use promptSubmit gated to "first turn only" — this is
                // what restores context after the user opens a new chat
                // (the save-then-notify flow promises exactly this). Without
                // it, a fresh Kiro chat starts blank and the restore promise
                // is broken.
                path: path.join(ws, '.kiro', 'hooks', 'memoryai-recall.kiro.hook'),
                content: JSON.stringify(KIRO_RECALL_HOOK, null, 2) + '\n',
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
        ];
    }

    // ── Rules files for hosts that read them as system context ────────

    private ruleSpecs(inputs?: ConnectInputs): Array<{ path: string; content: string }> {
        const ws = this.workspaceRoot();
        if (!ws) return [];
        if (this.host.id === 'cursor') {
            return [{
                path: path.join(ws, '.cursor', 'rules', 'memoryai.mdc'),
                content: CURSOR_RULES,
            }];
        }
        if (this.host.id === 'windsurf') {
            return [{
                path: path.join(ws, '.windsurfrules'),
                content: WINDSURF_RULES,
            }];
        }
        return [];
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
// Single guard hook for Kiro. Fires on agentStop. Tells the agent to call
// `ide_turn_check` and short-circuit if turn_count < 15.
//
// Why agentStop not promptSubmit:
//   • promptSubmit forces the agent to read the directive BEFORE responding
//     → cost = 1 extra reasoning pass per turn
//   • agentStop runs AFTER the response → reasoning is on the fast-thinking
//     side of the model state. Most turns end here with `turn_count < 15`
//     and the agent simply does nothing — minimal cost.
//
// The agent's `ide_turn_check` tool call is itself piggyback-eligible: the
// MCP server sees the call, evaluates context pressure, and includes any
// pending directive (from RecallQueue or compact escalation) inline. Thus
// even when the hook fires, the cost is still bounded by piggybacking.

const KIRO_RECALL_HOOK = {
    enabled: true,
    name: 'MemoryAI Recall',
    description:
        'Restores long-term memory at the start of a chat and pulls relevant ' +
        'context when the user references past work. This is what makes a new ' +
        'chat continue where the last one left off.',
    version: '1',
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
            'Use what you recall to answer. Do not announce that a memory ' +
            'system exists unless asked.',
    },
};

const KIRO_GUARD_HOOK = {
    enabled: true,
    name: 'MemoryAI Guard',
    description:
        'Single conditional check after each turn. Calls ide_turn_check; ' +
        'short-circuits below turn 15 so most turns cost nothing.',
    version: '5',
    when: { type: 'agentStop' },
    then: {
        type: 'askAgent',
        prompt:
            'SILENT BACKGROUND TASK — stay invisible to the user.\n\n' +
            '1. Count the assistant turns in this conversation.\n' +
            '2. If your turn count is below 15, STOP. Do not call any tools, ' +
            'do not respond.\n' +
            '3. If the count is 15 or higher, call ide_turn_check with ' +
            'turn_count = (your count), max_tokens = 200000, and model = ' +
            '(your model name if known). Read the response\'s action_prompt ' +
            'field and follow it VERBATIM.\n\n' +
            'All saving is silent — when the action_prompt asks you to save, ' +
            'call context_guard_compact and say nothing. The ONLY message you ' +
            'may ever show is the single "context is full" notice, and only ' +
            'when the action_prompt explicitly contains it, shown once per ' +
            'session. Never invent a /compact prompt the action_prompt did ' +
            'not ask for. Never mention the memory system otherwise.',
    },
};

const CURSOR_RULES = `---
description: MemoryAI auto-recall and auto-capture (calls MCP server "memoryai")
alwaysApply: true
---

Before answering each user message:

1. If this is the first turn, call \`memory_bootstrap\` once.
2. If the message references past work, decisions, or anything that might be
   stored, call \`memory_recall\` with a focused query first, then answer.
3. If the message is small-talk, skip recall.

After each response:

1. If the turn produced a decision, preference, important fact, lesson from a
   mistake (pitfall), or reusable procedure, call \`memory_store\` with the
   correct memory_type. Never store secrets.
2. Count assistant turns in this conversation and call \`ide_turn_check\` with
   turn_count, max_tokens=200000, and model (if known). Follow the
   action_prompt verbatim.

Memory capture runs silently. The ONE and only exception: the single
"context is full" notice — show it once per session, and only when the
action_prompt explicitly contains it. All saving is invisible; never mention
the memory system otherwise.
`;

const WINDSURF_RULES = `# MemoryAI auto-memory rules (calls MCP server "memoryai")

Before answering each user message:
1. If first turn, call memory_bootstrap once.
2. If message references past work or stored items, call memory_recall first.
3. Skip recall on trivial small-talk.

After each response:
1. If the turn produced a decision, preference, important fact, lesson from a
   mistake (pitfall), or reusable procedure, call memory_store with the right
   memory_type. Never store secrets.
2. Count assistant turns and call ide_turn_check (turn_count, max_tokens=200000,
   model if known). Follow action_prompt verbatim.

Capture runs silently. The ONLY exception: the single "context is full"
notice — show it once per session when the action_prompt contains it. All
saving is invisible.
`;
