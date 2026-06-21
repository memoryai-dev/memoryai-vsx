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
import { HostAdapter, runHostCommand } from './host';
import { findActiveSession, readTail, KiroSessionInfo } from './kiroSession';

const POLL_MS = 8_000;

type Level = 'safe' | 'compact' | 'critical';

export class ContextMonitor implements vscode.Disposable {
    private timer?: NodeJS.Timeout;
    private busy = false;

    // De-dup state, keyed on the active session id.
    private armedSessionId = '';
    private savedAtCompact = false;
    private savedAtCritical = false;
    private notifiedAtCritical = false;
    private spawnedForSession = false;
    // Layer-2 flush safety: the last mtime we saw for the active session. The
    // spawn only fires once the file is STABLE (same mtime across two polls),
    // proving Kiro has flushed the final turn to disk — otherwise saveTail
    // could ship a tail missing the most recent (and most important) turn.
    private lastSeenMtime = 0;

    constructor(
        private api: ApiClient,
        private settings: Settings,
        private statusBar: StatusBar,
        private log: Logger,
        private host: HostAdapter,
    ) {}

    private get isKiro(): boolean {
        return this.host.id === 'kiro';
    }

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
            const stable = this.isStable(session);

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
                this.savedAtCritical = false;
                this.notifiedAtCritical = false;
                return;
            }

            if (level === 'compact' && !this.savedAtCompact) {
                await this.saveSilently(session, usage);
                this.savedAtCompact = true;
                return;
            }

            if (level === 'critical') {
                if (!this.notifiedAtCritical) {
                    this.notifyFull(usage);
                    this.notifiedAtCritical = true;
                }
                // Save a FRESH tail at critical — distinct from the compact save,
                // which is now stale (turns between compact% and critical% would
                // otherwise be lost). Gate on stability so the tail includes the
                // final flushed turn. Re-uses savedAtCritical so we save once.
                if (!this.savedAtCritical) {
                    if (!stable) {
                        this.log.debug('ContextMonitor: critical but file not yet stable — defer save one poll.');
                    } else {
                        await this.saveSilently(session, usage);
                        this.savedAtCritical = true;
                    }
                }
                // Auto-spawn (design B): only at the IDLE turn boundary AND once
                // the FRESH critical tail is saved (so the new session resumes
                // from the true latest turn, not the stale compact snapshot).
                if (this.savedAtCritical) {
                    await this.maybeSpawn(session, usage);
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
            this.savedAtCritical = false;
            this.notifiedAtCritical = false;
            this.spawnedForSession = false;
            this.lastSeenMtime = 0;
            this.statusBar.setPressure(false);
        }
    }

    /** Layer-2 flush check: the file is "stable" when its mtime hasn't changed
     *  since the previous poll, i.e. Kiro finished writing the latest turn.
     *  Updates the tracked mtime as a side effect. */
    private isStable(session: KiroSessionInfo): boolean {
        const stable = this.lastSeenMtime !== 0 && session.mtime === this.lastSeenMtime;
        this.lastSeenMtime = session.mtime;
        return stable;
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
     *  The model can't suppress this — VS Code renders it. Wording depends on
     *  whether auto-spawn will take over: with auto-spawn on, the fresh chat
     *  opens by itself at the idle boundary, so we say so rather than telling
     *  the user to act. */
    private notifyFull(usage: number): void {
        this.statusBar.setPressure(true, usage);
        const auto = this.settings.autoSpawn();
        this.log.info(`ContextMonitor: critical at ${usage.toFixed(1)}% — surfaced context-full notice (autoSpawn=${auto}).`);
        const msg = auto
            ? `MemoryAI: Context is full (${Math.round(usage)}%). Everything is saved — ` +
              `I'll open a fresh chat as soon as the current turn finishes and continue where we left off.`
            : `MemoryAI: Context is full (${Math.round(usage)}%). Everything is saved to your brain — ` +
              `open a new chat and I'll restore the full context automatically and continue where we left off.`;
        vscode.window.showWarningMessage(msg, 'Got it').then(undefined, () => {
            /* dismissed */
        });
    }

    private projectId(): string | undefined {
        const ws = this.workspacePath();
        if (!ws) return undefined;
        const base = ws.split(/[\\/]/).filter(Boolean).pop();
        return base || undefined;
    }

    /**
     * Auto-spawn a fresh session at the idle turn boundary (design B).
     *
     * Guards, all required:
     *   • auto-spawn enabled in settings,
     *   • not already spawned for this session,
     *   • agent is idle: it just finished answering (lastRole === 'assistant')
     *     and isn't gathering context / awaiting clarification (busy === false).
     *
     * The tail is already saved (critical branch saved it), so the new
     * session's recall + bootstrap hook resumes the in-progress work. We run
     * the host's verified `newSession` command; on success the old session
     * stops being active and the next poll re-arms on the new session id.
     */
    private async maybeSpawn(session: KiroSessionInfo, usage: number): Promise<void> {
        if (!this.settings.autoSpawn()) return;
        if (this.spawnedForSession) return;
        if (session.busy || session.lastRole !== 'assistant') {
            this.log.debug(
                `ContextMonitor: critical but not idle (lastRole=${session.lastRole || '∅'} ` +
                    `busy=${session.busy}) — defer spawn to the turn boundary.`,
            );
            return;
        }
        this.spawnedForSession = true;
        const ok = await runHostCommand(this.host, 'newSession', {});
        this.log.info(
            `ContextMonitor: auto-spawn at ${usage.toFixed(1)}% (idle boundary) → ${ok ? 'spawned' : 'command failed'}.`,
        );
        if (ok) {
            // Clear the pressure overlay — the new session starts clean.
            this.statusBar.setPressure(false);
        }
    }
}
