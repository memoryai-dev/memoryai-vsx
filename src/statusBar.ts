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
    private chunks = 0;
    private storageMB = 0;
    private storesMonth = 0;
    private recallsMonth = 0;
    private savedToday = 0;
    private plan = 'free';

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

    update(opts: {
        chunks?: number;
        storageMB?: number;
        storesMonth?: number;
        recallsMonth?: number;
        savedToday?: number;
        plan?: string;
    }): void {
        if (opts.chunks !== undefined) this.chunks = opts.chunks;
        if (opts.storageMB !== undefined) this.storageMB = opts.storageMB;
        if (opts.storesMonth !== undefined) this.storesMonth = opts.storesMonth;
        if (opts.recallsMonth !== undefined) this.recallsMonth = opts.recallsMonth;
        if (opts.savedToday !== undefined) this.savedToday = opts.savedToday;
        if (opts.plan !== undefined) this.plan = opts.plan;
        this.render();
    }

    private render(): void {
        const style = this.settings.statusBar();
        if (style === 'off') {
            this.item.hide();
            return;
        }
        const dollar = this.savedToday.toFixed(2);
        const ICON = '$(database)';
        let text = '';
        switch (this.current) {
            case 'disconnected':
                text = `${ICON} MemoryAI · Connect`;
                this.item.tooltip = 'Click to connect MemoryAI.';
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
                if (style === 'savings') {
                    text = `${ICON} MemoryAI · saved $${dollar}`;
                } else if (style === 'tokens') {
                    // Repurposed: shows brain volume (chunks + storage).
                    text = `${ICON} ${formatK(this.chunks)} mem · ${this.storageMB.toFixed(1)}MB`;
                } else if (style === 'compact') {
                    // Repurposed: shows month's activity.
                    text = `${ICON} ${formatK(this.storesMonth)}↑ ${formatK(this.recallsMonth)}↓`;
                } else {
                    // full — every signal in one glance.
                    text = `${ICON} ${formatK(this.chunks)} · ${formatK(this.storesMonth)}↑ ${formatK(this.recallsMonth)}↓ · $${dollar}`;
                }
                this.item.tooltip = [
                    `MemoryAI — ${this.plan} plan`,
                    `Brain: ${formatK(this.chunks)} memories · ${this.storageMB.toFixed(1)}MB`,
                    `This month: ${this.storesMonth} stores · ${this.recallsMonth} recalls`,
                    `Saved today: $${dollar}`,
                    '',
                    'Click to open Brain Health.',
                ].join('\n');
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
