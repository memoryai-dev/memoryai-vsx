import * as vscode from 'vscode';

/**
 * Typed wrapper over `workspace.getConfiguration('memoryai')`.
 *
 * 0.5.0 (2026-06-21): context-guard config collapsed to TWO numbers, both
 * percent-native — no more auto/manual modes, no model-name guessing.
 *
 *   • contextWindow   — the model's window in tokens (200000 / 1000000 /
 *                       any exact number). The single source of truth for
 *                       how big "full" is.
 *   • criticalPercent — the fill level (% of the window) at which the guard
 *                       FORCES a save + shows the "context is full" notice.
 *                       Default follows the window: ≤200K → 95, >200K → 30.
 *                       User-overridable (e.g. raise a 1M model 30 → 40).
 *
 * The soft "compact" point where SILENT saving begins is derived as
 * criticalPercent × 0.85 — one knob (criticalPercent) moves both. This
 * matches what Kiro reports as `contextUsagePercentage`, so the guard
 * compares like-for-like with no token estimation or turn-count guessing.
 */

/** Soft compact point as a fraction of the critical percent. */
export const COMPACT_RATIO = 0.85;

/** Window above which the adaptive default critical % flips to the 1M value. */
const LARGE_WINDOW_TOKENS = 200_000;

/** Adaptive default critical %: small windows save late (95%), 1M windows
 *  save early (30%) because 30% of 1M is already a big, expensive context. */
export function defaultCriticalPercent(windowTokens: number): number {
    return windowTokens > LARGE_WINDOW_TOKENS ? 30 : 95;
}

export class Settings {
    private get cfg(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('memoryai');
    }

    endpoint(): string {
        return this.cfg.get<string>('endpoint', 'https://memoryai.dev');
    }

    /** The model's context window in tokens. Default 200K. */
    contextWindow(): number {
        const v = this.cfg.get<number>('contextWindow', 200_000);
        return v && v >= 8_000 ? Math.round(v) : 200_000;
    }

    /** Critical fill % (force save). If unset, derive from the window. */
    criticalPercent(): number {
        const w = this.contextWindow();
        const v = this.cfg.get<number>('criticalPercent', 0);
        const pct = v && v > 0 ? v : defaultCriticalPercent(w);
        return Math.min(99, Math.max(5, Math.round(pct)));
    }

    /** Soft compact fill % (silent save) = critical × 0.85. */
    compactPercent(): number {
        return Math.round(this.criticalPercent() * COMPACT_RATIO);
    }

    /**
     * Mode-aware context-guard inputs for the MCP env block. Both thresholds
     * are now expressed as absolute token counts derived from window × %, so
     * the server receives a concrete compact/critical pair regardless of how
     * it estimates usage. window itself is forwarded so the server can stop
     * defaulting to its own hard-coded ceiling.
     */
    guardInputs(): {
        contextWindow: number;
        criticalPercent: number;
        compactPercent: number;
        compactAtTokens: number;
        criticalAtTokens: number;
    } {
        const window = this.contextWindow();
        const criticalPct = this.criticalPercent();
        const compactPct = this.compactPercent();
        return {
            contextWindow: window,
            criticalPercent: criticalPct,
            compactPercent: compactPct,
            compactAtTokens: Math.round((window * compactPct) / 100),
            criticalAtTokens: Math.round((window * criticalPct) / 100),
        };
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
