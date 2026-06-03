import * as vscode from 'vscode';

/**
 * Typed wrapper over `workspace.getConfiguration('memoryai')`.
 *
 * Slimmed down for v0.1.5 — only the settings the extension actually
 * reads remain. The dead client-side knobs (autoRecall / autoStore /
 * rotationStyle / recallDepth / etc.) lived alongside the removed
 * ChatMonitor + TurnGuard + RecallQueue and are gone.
 */
export class Settings {
    private get cfg(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('memoryai');
    }

    endpoint(): string {
        return this.cfg.get<string>('endpoint', 'https://memoryai.dev');
    }

    /** Soft warning threshold in tokens. Sent to the MCP server as
     *  HM_COMPACT_AT and as compact_at_tokens on guard requests. */
    compactAtTokens(): number {
        const v = this.cfg.get<number>('compactAtTokens');
        if (typeof v === 'number' && v > 0) return v;
        // Backward-compat for users still on the deprecated hardCap.
        const legacy = this.cfg.get<number>('hardCap');
        if (typeof legacy === 'number' && legacy > 0) return Math.round(legacy * 0.66);
        return 100_000;
    }

    /** Hard ceiling in tokens. Sent to the MCP server as HM_CRITICAL_AT
     *  and as critical_at_tokens on guard requests. */
    criticalAtTokens(): number {
        const v = this.cfg.get<number>('criticalAtTokens');
        if (typeof v === 'number' && v > 0) return v;
        const legacy = this.cfg.get<number>('hardCap');
        if (typeof legacy === 'number' && legacy > 0) return legacy;
        return 150_000;
    }

    /** @deprecated kept so existing callers compile during the migration. */
    hardCap(): number { return this.criticalAtTokens(); }

    privateMode(): boolean {
        return this.cfg.get<boolean>('privateMode', false);
    }

    statusBar(): 'off' | 'savings' | 'tokens' | 'compact' | 'full' {
        return this.cfg.get<'off' | 'savings' | 'tokens' | 'compact' | 'full'>('statusBar', 'savings');
    }

    logLevel(): 'off' | 'error' | 'warn' | 'info' | 'debug' | 'trace' {
        return this.cfg.get<'off' | 'error' | 'warn' | 'info' | 'debug' | 'trace'>('debug.logLevel', 'warn');
    }
}
