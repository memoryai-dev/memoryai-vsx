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
    // Brain identity (Wave 2.5) — surfaces "who" the brain is in the tooltip.
    private brainName: string | null = null;
    private brainAgeDays: number | null = null;
    private dnaCount: number | null = null;
    private lastDreamAt: string | null = null;
    private renderTimeout?: NodeJS.Timeout;
    // Context-pressure overlay — when active, the bar shows a warning regardless
    // of style/state so the "compact now" signal stays visible after the modal
    // is dismissed. Cleared when pressure subsides.
    private pressureActive = false;
    private pressurePct = 0;

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
        // Immediate render for state changes (connected/disconnected/error)
        if (this.renderTimeout) {
            clearTimeout(this.renderTimeout);
            this.renderTimeout = undefined;
        }
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
        brainName?: string | null;
        brainAgeDays?: number | null;
        dnaCount?: number | null;
        lastDreamAt?: string | null;
    }): void {
        if (opts.chunks !== undefined) this.chunks = opts.chunks;
        if (opts.storageMB !== undefined) this.storageMB = opts.storageMB;
        if (opts.storesMonth !== undefined) this.storesMonth = opts.storesMonth;
        if (opts.recallsMonth !== undefined) this.recallsMonth = opts.recallsMonth;
        if (opts.savedToday !== undefined) this.savedToday = opts.savedToday;
        if (opts.plan !== undefined) this.plan = opts.plan;
        if (opts.brainName !== undefined) this.brainName = opts.brainName;
        if (opts.brainAgeDays !== undefined) this.brainAgeDays = opts.brainAgeDays;
        if (opts.dnaCount !== undefined) this.dnaCount = opts.dnaCount;
        if (opts.lastDreamAt !== undefined) this.lastDreamAt = opts.lastDreamAt;

        // Throttle render to 500ms — prevent UI thrash if healthMonitor bursts updates
        if (this.renderTimeout) {
            clearTimeout(this.renderTimeout);
        }
        this.renderTimeout = setTimeout(() => {
            this.render();
            this.renderTimeout = undefined;
        }, 500);
    }

    /** Set/clear the context-pressure overlay. When active the bar turns into
     *  a warning the user keeps seeing until they compact. Click → showSavings
     *  (Brain Health) as usual; the warning text is the cue to /compact. */
    setPressure(active: boolean, usagePercent = 0): void {
        this.pressureActive = active;
        this.pressurePct = usagePercent;
        if (this.renderTimeout) {
            clearTimeout(this.renderTimeout);
            this.renderTimeout = undefined;
        }
        this.render();
        this.item.show();
    }

    private render(): void {
        const style = this.settings.statusBar();
        if (style === 'off' && !this.pressureActive) {
            this.item.hide();
            return;
        }
        // Pressure overlay wins over normal rendering (but not over
        // disconnected/error which the user must fix first).
        if (this.pressureActive && (this.current === 'connected' || this.current === 'rotating')) {
            const pct = this.pressurePct > 0 ? ` (${Math.round(this.pressurePct)}%)` : '';
            this.item.text = `$(warning) MemoryAI · Context full${pct} — /compact`;
            this.item.tooltip =
                'Context is full and saved to your brain.\n' +
                'Run /compact or open a new chat — MemoryAI restores the full context automatically.';
            this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            return;
        }
        // Not under pressure — clear any warning background we may have set.
        this.item.backgroundColor = undefined;
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
                this.item.tooltip = this.buildTooltip();
                break;
        }
        this.item.text = text;
    }

    /** Build the multi-line tooltip. Surfaces brain identity when known. */
    private buildTooltip(): string {
        const dollar = this.savedToday.toFixed(2);
        const lines: string[] = [];

        // Header — "Brain 'Mnemo' · 47d old · pro plan" when identity is known,
        // falls back to "MemoryAI — pro plan" for older servers.
        if (this.brainName) {
            const ageBit = this.brainAgeDays !== null
                ? ` · ${this.brainAgeDays}d old`
                : '';
            lines.push(`Brain "${this.brainName}"${ageBit} · ${this.plan} plan`);
        } else {
            lines.push(`MemoryAI — ${this.plan} plan`);
        }

        lines.push(`Memories: ${formatK(this.chunks)} · ${this.storageMB.toFixed(1)}MB`);
        if (this.dnaCount !== null && this.dnaCount > 0) {
            lines.push(`DNA-protected: ${this.dnaCount}`);
        }
        if (this.lastDreamAt) {
            const phrase = relativeTime(this.lastDreamAt);
            if (phrase) lines.push(`Last dream: ${phrase}`);
        }
        lines.push(`This month: ${this.storesMonth} stores · ${this.recallsMonth} recalls`);
        lines.push(`Saved today: $${dollar}`);
        lines.push('');
        lines.push('Click to open Brain Health.');
        return lines.join('\n');
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

/** Convert ISO timestamp to a short relative phrase ("3h ago", "2d ago").
 *  Returns empty string when the input can't be parsed. */
function relativeTime(iso: string): string {
    const t = Date.parse(iso);
    if (isNaN(t)) return '';
    const ms = Date.now() - t;
    if (ms < 0) return 'in the future';
    const minutes = Math.round(ms / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
}
