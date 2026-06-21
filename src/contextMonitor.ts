/**
 * ContextMonitor — the real fix for "context lerror": a background loop that
 * reads Kiro's OWN contextUsagePercentage from the active session file and
 * compares it against the user's compact/critical thresholds. No turn-count
 * guessing, no server-side token estimate — the number Kiro renders in its UI
 * is the number we act on.
 *
 * Two thresholds, both percent-native (see settings.ts):
 *   • compact  (= critical × 0.85): cross it → save SILENTLY to the brain.
 *   • critical (window-adaptive or user override): cross it → force a save and
 *     raise the single "context is full" notice via the status bar overlay.
 *
 * Host gating: only Kiro persists workspace-sessions JSON, so on Cursor /
 * Windsurf / VS Code findActiveSession() returns null and the loop is a no-op.
 * Those hosts keep the server-snapshot pressure path in extension.ts.
 *
 * De-dup: an episode is keyed on the session id + the threshold crossed, so we
 * save/notify once per crossing, not every poll. A drop back below compact
 * re-arms the episode (e.g. after the user starts a fresh chat).
 */
import * as vscode from 'vscode';

import { Logger } from './logger';
import { ApiClient } from './api';
import { Settings } from './settings';
import { StatusBar } from './statusBar';
import { findActiveSession, readTail, KiroSessionInfo } from './kiroSession';

const POLL_MS = 8_000;

type Level = 'safe' | 'compact' | 'critical';

export class ContextMonitor implements vscode.Disposable {
    private timer?: NodeJS.Timeout;
    private busy = false;

    // De-dup state, keyed on the active session id.
    private armedSessionId = '';
    private savedAtCompact = false;
    private notifiedAtCritical = false;

    constructor(
        private api: ApiClient,
        private settings: Settings,
        private statusBar: StatusBar,
        private log: Logger,
        private isKiro: boolean,
    ) {}

    start(): void {
        if (this.timer || !this.isKiro) return;
        this.log.info('ContextMonitor: started (Kiro contextUsagePercentage watch).');
        this.timer = setInterval(() => void this.tick(), POLL_MS);
        // Kick once immediately so we don't wait a full interval on launch.
        void this.tick();
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    dispose(): void {
        this.stop();
    }

    private workspacePath(): string {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    }

    private async tick(): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        try {
            const ws = this.workspacePath();
            if (!ws) return;

            const session = findActiveSession(ws);
            if (!session || session.contextUsagePercentage < 0) {
                // No session or this build of Kiro doesn't expose the number —
                // stay silent; the server-snapshot path still covers pressure.
                return;
            }

            this.rearmIfNewSession(session);

            const compactPct = this.settings.compactPercent();
            const criticalPct = this.settings.criticalPercent();
            const usage = session.contextUsagePercentage;
            const level = this.classify(usage, compactPct, criticalPct);

            this.log.debug(
                `ContextMonitor: session=${session.sessionId.slice(0, 8)} ` +
                    `usage=${usage.toFixed(1)}% compact=${compactPct}% critical=${criticalPct}% → ${level}`,
            );

            if (level === 'safe') {
                // Recovered below compact → drop overlay + re-arm for next climb.
                if (this.savedAtCompact || this.notifiedAtCritical) {
                    this.statusBar.setPressure(false);
                }
                this.savedAtCompact = false;
                this.notifiedAtCritical = false;
                return;
            }

            if (level === 'compact' && !this.savedAtCompact) {
                await this.saveSilently(session, usage);
                this.savedAtCompact = true;
                return;
            }

            if (level === 'critical') {
                // Make sure the brain has the latest tail even if compact was
                // skipped (fast climb straight past the soft point).
                if (!this.savedAtCompact) {
                    await this.saveSilently(session, usage);
                    this.savedAtCompact = true;
                }
                if (!this.notifiedAtCritical) {
                    this.notifyFull(usage);
                    this.notifiedAtCritical = true;
                }
            }
        } catch (e) {
            this.log.debug(`ContextMonitor tick failed: ${(e as Error).message}`);
        } finally {
            this.busy = false;
        }
    }

    private classify(usage: number, compactPct: number, criticalPct: number): Level {
        if (usage >= criticalPct) return 'critical';
        if (usage >= compactPct) return 'compact';
        return 'safe';
    }

    private rearmIfNewSession(session: KiroSessionInfo): void {
        if (session.sessionId && session.sessionId !== this.armedSessionId) {
            this.armedSessionId = session.sessionId;
            this.savedAtCompact = false;
            this.notifiedAtCritical = false;
            this.statusBar.setPressure(false);
        }
    }

    /** Silent save: ship the conversation tail to the B5 buffer. No user-visible
     *  output. Mirrors the probe's feeder but fully automatic. */
    private async saveSilently(session: KiroSessionInfo, usage: number): Promise<void> {
        const tail = readTail(session.file, 12);
        if (tail.length === 0 || !session.sessionId) {
            this.log.debug('ContextMonitor: nothing usable to save (empty tail / no sessionId).');
            return;
        }
        const projectId = this.projectId();
        const res = await this.api.saveTail(session.sessionId, tail, projectId);
        this.log.info(
            `ContextMonitor: silent save at ${usage.toFixed(1)}% → ${res.ok ? res.status || 'ok' : 'FAILED'} ` +
                `(${tail.length} tail turns, session ${session.sessionId.slice(0, 8)}).`,
        );
    }

    /** Raise the single "context is full" cue through the status-bar overlay.
     *  The model can't suppress this — VS Code renders it. */
    private notifyFull(usage: number): void {
        this.statusBar.setPressure(true, usage);
        this.log.info(`ContextMonitor: critical at ${usage.toFixed(1)}% — surfaced context-full notice.`);
        vscode.window
            .showWarningMessage(
                `MemoryAI: Context is full (${Math.round(usage)}%). Everything is saved to your brain — ` +
                    `open a new chat and I'll restore the full context automatically and continue where we left off.`,
                'Got it',
            )
            .then(undefined, () => {
                /* dismissed */
            });
    }

    private projectId(): string | undefined {
        const ws = this.workspacePath();
        if (!ws) return undefined;
        const base = ws.split(/[\\/]/).filter(Boolean).pop();
        return base || undefined;
    }
}
