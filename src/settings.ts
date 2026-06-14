import * as vscode from 'vscode';

/**
 * Typed wrapper over `workspace.getConfiguration('memoryai')`.
 *
 * 0.1.9 cleanup (2026-06-09): removed compactAtTokens / criticalAtTokens /
 * compactPct / criticalPct / hardCap. All threshold logic now lives on the
 * server side — the guard fires at a fixed 150K compact / 200K critical
 * for all models (DNA #2 "predictable cost regardless of host model
 * window"). Client-side overrides were silently ignored after the
 * server-side fix anyway.
 */
export class Settings {
    private get cfg(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('memoryai');
    }

    endpoint(): string {
        return this.cfg.get<string>('endpoint', 'https://memoryai.dev');
    }

    /** Optional model hint for server-side context-window auto-detection.
     *  Empty string → server uses the 200K default. Set to your model
     *  (e.g. "claude-opus-4-6[1m]") to get the right adaptive trigger. */
    model(): string | undefined {
        return this.cfg.get<string>('model', '') || undefined;
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
