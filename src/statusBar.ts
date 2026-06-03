import * as vscode from 'vscode';

import { Settings } from './settings';
import { Logger } from './logger';

export type StatusBarState = 'disconnected' | 'connected' | 'rotating' | 'error';

/**
 * Status bar widget. Lives in the bottom bar; click opens cost dashboard.
 * State is rendered according to user setting `memoryai.statusBar`.
 */
export class StatusBar implements vscode.Disposable {
    private item: vscode.StatusBarItem;
    private current: StatusBarState = 'disconnected';
    private tokens = 0;
    private cap = 150_000;
    private savedToday = 0;

    constructor(private settings: Settings, private log: Logger) {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        // command is set per-state in show() — disconnected → connect, connected → savings.
    }

    show(state: StatusBarState): void {
        this.current = state;
        // Click action depends on state — disconnected → run connect flow,
        // connected/rotating → open savings dashboard.
        this.item.command = state === 'disconnected' || state === 'error'
            ? 'memoryai.connect'
            : 'memoryai.showSavings';
        this.render();
        this.item.show();
    }

    update(opts: { tokens?: number; cap?: number; savedToday?: number }): void {
        if (opts.tokens !== undefined) this.tokens = opts.tokens;
        if (opts.cap !== undefined) this.cap = opts.cap;
        if (opts.savedToday !== undefined) this.savedToday = opts.savedToday;
        this.render();
    }

    private render(): void {
        const style = this.settings.statusBar();
        if (style === 'off') {
            this.item.hide();
            return;
        }
        const pct = this.cap > 0 ? Math.round((this.tokens / this.cap) * 100) : 0;
        const dollar = this.savedToday.toFixed(2);
        // VS Code Status Bar API does NOT support custom PNG icons — we can
        // only use codicons or text. $(database) was chosen as the closest
        // semantic match for a memory product. The actual MemoryAI logo
        // shows up in the Connect panel and on the Marketplace listing.
        const ICON = '$(database)';
        let text = '';
        switch (this.current) {
            case 'disconnected':
                text = `${ICON} MemoryAI · Connect`;
                this.item.tooltip = 'Click to connect MemoryAI and enable cost cap.';
                break;
            case 'error':
                text = `$(error) MemoryAI · Reconnect`;
                this.item.tooltip = 'Server unreachable or key invalid. Click to fix.';
                break;
            case 'rotating':
                text = `$(sync~spin) MemoryAI · rotating…`;
                this.item.tooltip = 'Persisting current session and starting a fresh one.';
                break;
            case 'connected':
            default:
                if (style === 'savings') text = `${ICON} MemoryAI · saved $${dollar}`;
                else if (style === 'tokens') text = `${ICON} MemoryAI · ${formatK(this.tokens)}/${formatK(this.cap)}`;
                else if (style === 'compact') text = `${ICON} MemoryAI ${pct}%`;
                else text = `${ICON} MemoryAI ${pct}% · ${formatK(this.tokens)}/${formatK(this.cap)} · $${dollar}`;
                this.item.tooltip = `Click to open dashboard. Cap: ${formatK(this.cap)} tokens. Saved today: $${dollar}.`;
                break;
        }
        this.item.text = text;
    }

    dispose(): void {
        this.item.dispose();
    }
}

function formatK(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return String(n);
}
