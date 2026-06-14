import * as vscode from 'vscode';

/**
 * Typed wrapper over `workspace.getConfiguration('memoryai')`.
 *
 * 0.1.13 (2026-06-15): re-introduced manual token thresholds, now gated
 * behind `memoryai.compactMode`:
 *   • auto   → server detects the window from `memoryai.model` and picks
 *              the adaptive trigger (≤200K → 95%, >200K → 30%).
 *   • manual → user supplies a single `criticalAtTokens` (the hard ceiling
 *              where a compact is forced). The soft compact threshold is
 *              derived automatically as 80% of critical — the user no
 *              longer sets it, so there is only one number to reason about.
 *              Both are forwarded to the server as absolute overrides (they
 *              win over the adaptive %). Lets a 1M-window user pick e.g.
 *              200K (→ compact at 160K) or 600K (→ compact at 480K).
 * The server honours compact_at_tokens / critical_at_tokens.
 */

/** Soft compact threshold as a fraction of the critical (hard) ceiling. */
const COMPACT_RATIO = 0.8;
export class Settings {
    private get cfg(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('memoryai');
    }

    endpoint(): string {
        return this.cfg.get<string>('endpoint', 'https://memoryai.dev');
    }

    /** 'auto' (detect window from model name) or 'manual' (use token counts). */
    compactMode(): 'auto' | 'manual' {
        return this.cfg.get<'auto' | 'manual'>('compactMode', 'auto');
    }

    /** Optional model hint for server-side context-window auto-detection.
     *  Used in auto mode. Empty string → server uses the 200K default.
     *  Set to your model (e.g. "claude-opus-4-8[1m]") for the right trigger. */
    model(): string | undefined {
        return this.cfg.get<string>('model', '') || undefined;
    }

    /** Manual-mode hard critical threshold in tokens. 0/undefined → unset. */
    criticalAtTokens(): number | undefined {
        const v = this.cfg.get<number>('criticalAtTokens', 0);
        return v && v > 0 ? v : undefined;
    }

    /** Mode-aware context-guard inputs for the MCP env block.
     *  auto   → forward the model hint only (server derives the trigger).
     *  manual → forward absolute token thresholds (they win on the server).
     *  In manual mode the user sets only the critical ceiling; the soft
     *  compact threshold is derived as 80% of critical (rounded). If
     *  critical is unset we degrade to auto so we never write an invalid
     *  pair that the server would reject. */
    guardInputs(): { model?: string; compactAtTokens?: number; criticalAtTokens?: number } {
        if (this.compactMode() === 'manual') {
            const critical = this.criticalAtTokens();
            if (critical && critical > 0) {
                const compact = Math.round(critical * COMPACT_RATIO);
                return { compactAtTokens: compact, criticalAtTokens: critical };
            }
            // No critical set → degrade to auto gracefully.
        }
        return { model: this.model() };
    }

    privateMode(): boolean {
        return this.cfg.get<boolean>('privateMode', false);
    }

    statusBar(): 'off' | 'savings' | 'tokens' | 'compact' | 'full' {
        return this.cfg.get<'off' | 'savings' | 'tokens' | 'compact' | 'full'>('statusBar', 'full');
    }

    logLevel(): 'off' | 'error' | 'warn' | 'info' | 'debug' | 'trace' {
        return this.cfg.get<'off' | 'error' | 'warn' | 'info' | 'debug' | 'trace'>('debug.logLevel', 'warn');
    }
}
