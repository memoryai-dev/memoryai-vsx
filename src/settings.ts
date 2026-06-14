import * as vscode from 'vscode';

/**
 * Typed wrapper over `workspace.getConfiguration('memoryai')`.
 *
 * 0.1.13 (2026-06-15): re-introduced manual token thresholds, now gated
 * behind `memoryai.compactMode`:
 *   • auto   → server detects the window from `memoryai.model` and picks
 *              the adaptive trigger (≤200K → 95%, >200K → 30%).
 *   • manual → user-supplied `compactAtTokens` / `criticalAtTokens` are
 *              forwarded to the server as absolute overrides (they win
 *              over the adaptive %). Lets a 1M-window user pick e.g.
 *              150K/200K or 500K/600K explicitly.
 * Unlike the pre-0.1.9 fields, these are no longer silently ignored —
 * the server honours compact_at_tokens / critical_at_tokens.
 */
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

    /** Manual-mode soft compact threshold in tokens. 0/undefined → unset. */
    compactAtTokens(): number | undefined {
        const v = this.cfg.get<number>('compactAtTokens', 0);
        return v && v > 0 ? v : undefined;
    }

    /** Manual-mode hard critical threshold in tokens. 0/undefined → unset. */
    criticalAtTokens(): number | undefined {
        const v = this.cfg.get<number>('criticalAtTokens', 0);
        return v && v > 0 ? v : undefined;
    }

    /** Mode-aware context-guard inputs for the MCP env block.
     *  auto   → forward the model hint only (server derives the trigger).
     *  manual → forward absolute token thresholds (they win on the server).
     *  Manual thresholds are only forwarded when BOTH are set and compact <
     *  critical; otherwise we fall back to auto so we never write an invalid
     *  pair that the server would reject. */
    guardInputs(): { model?: string; compactAtTokens?: number; criticalAtTokens?: number } {
        if (this.compactMode() === 'manual') {
            const compact = this.compactAtTokens();
            const critical = this.criticalAtTokens();
            if (compact && critical && compact < critical) {
                return { compactAtTokens: compact, criticalAtTokens: critical };
            }
            // Incomplete/invalid manual config → degrade to auto gracefully.
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
