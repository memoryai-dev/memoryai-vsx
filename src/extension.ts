/**
 * MemoryAI VS Code-family extension.
 *
 * What this extension does (honest scope):
 *   1. Configuration writer — paste API key, the extension wires the
 *      MCP server config + per-host rules files for Kiro, Cursor,
 *      Windsurf, VS Code, Claude Desktop. Disconnect cleans up.
 *   2. Status bar widget — every 60s polls `/v1/stats` and shows the
 *      live "$ saved", "memories stored", "online/offline" indicator.
 *   3. Brain Health webview — click the status bar to see live KPIs
 *      and recent activity.
 *
 * What it does NOT do (and we won't pretend otherwise):
 *   - It does not observe the host's chat panel. The MCP server +
 *     rules files do all of that work. VS Code-family hosts don't
 *     expose chat events to extensions, so trying to "track turns"
 *     from here is dead-on-arrival. v0.1.5 removed the dead code
 *     that pretended to.
 */
import * as vscode from 'vscode';

import { Logger } from './logger';
import { Settings } from './settings';
import { ApiClient } from './api';
import { detectHost, HostAdapter } from './host';
import { StatusBar } from './statusBar';
import { ConnectPanel } from './connectPanel';
import { HookInstaller } from './hookInstaller';
import { HealthMonitor, HealthSnapshot } from './healthMonitor';
import { HealthPanel } from './healthPanel';
import { ContextMonitor } from './contextMonitor';
import { runSpawnProbe } from './probe';

let logger: Logger;
let api: ApiClient;
let host: HostAdapter;
let statusBar: StatusBar;
let installer: HookInstaller;
let health: HealthMonitor;
let contextMonitor: ContextMonitor;

// Context-pressure dedup: remember the `setAt` of the last episode we already
// notified, so the same episode doesn't re-warn across the 60s polls. A new
// episode (different setAt) re-arms. Resets naturally on extension reload —
// the correct "once per session" boundary.
let lastNotifiedPressureSetAt = 0;

const SECRET_API_KEY = 'memoryai.apiKey';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    logger = new Logger('MemoryAI');
    const settings = new Settings();
    logger.setLevel(settings.logLevel());

    host = detectHost();
    logger.info(`Host detected: ${host.id} (${host.displayName})`);

    api = new ApiClient(settings, async () => {
        const k = await context.secrets.get(SECRET_API_KEY);
        return k ?? '';
    }, logger, context.extension.packageJSON.version);

    statusBar = new StatusBar(settings, logger);
    statusBar.show('disconnected');

    installer = new HookInstaller(host, logger);
    health = new HealthMonitor(api, logger);
    contextMonitor = new ContextMonitor(api, settings, statusBar, logger, host.id === 'kiro');

    health.onUpdate((snap: HealthSnapshot) => {
        // Drive status bar from the live health snapshot. All numbers come
        // from /v1/stats and are real measurements — no fakes.
        statusBar.update({
            chunks: snap.chunks,
            storageMB: snap.storageMB,
            storesMonth: snap.storesThisMonth,
            recallsMonth: snap.recallsThisMonth,
            savedToday: snap.savedTodayUSD,
            plan: snap.plan,
            brainName: snap.brainName,
            brainAgeDays: snap.brainAgeDays,
            dnaCount: snap.dnaCount,
            lastDreamAt: snap.lastDreamAt,
        });
        if (snap.online) {
            statusBar.show('connected');
        } else {
            statusBar.show('error');
        }
        // Context-pressure bridge: the model reported critical pressure via
        // turn-check; surface it through real IDE UI (the model can't suppress
        // this). On Kiro the local ContextMonitor owns this (it reads Kiro's
        // exact contextUsagePercentage), so skip the server-snapshot path there
        // to avoid a double notice. Other hosts still use this bridge.
        if (host.id !== 'kiro') {
            handleContextPressure(snap, statusBar, logger);
        }
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('memoryai.connect',
            () => ConnectPanel.show(context, api, logger, installer, async () => { contextMonitor.start(); await health.refresh(); })),
        vscode.commands.registerCommand('memoryai.disconnect', () => disconnectFlow(context)),
        vscode.commands.registerCommand('memoryai.showHealth',
            () => HealthPanel.show(context, health, logger)),
        // Legacy aliases — keep so users who memorised them still land somewhere useful.
        vscode.commands.registerCommand('memoryai.showSavings',
            () => HealthPanel.show(context, health, logger)),
        vscode.commands.registerCommand('memoryai.openSettings', () =>
            vscode.commands.executeCommand('workbench.action.openSettings', '@ext:memoryai.memoryai-vsx'),
        ),
        vscode.commands.registerCommand('memoryai.configureCompactThreshold',
            () => configureCompactThreshold(api, logger)),
        vscode.commands.registerCommand('memoryai.exportLogs', () => logger.exportLogs()),
        // Self-test probe (dark command, not in package.json menus). Verifies
        // whether this host exposes a working "new chat session" command-id and
        // whether continuity survives a spawn. Manual only — no production flow.
        vscode.commands.registerCommand('memoryai.debug.probeContext',
            () => runSpawnProbe(host, api, logger, context)),
        // Internal — used by ConnectPanel after key save to refresh status bar.
        vscode.commands.registerCommand('memoryai.statusbar.refresh', (state: 'connected' | 'disconnected' | 'error') => {
            statusBar.show(state);
        }),
        statusBar,
        health,
        contextMonitor,
    );

    // First-run experience: if no key, open Connect panel directly.
    const existing = await context.secrets.get(SECRET_API_KEY);
    if (!existing) {
        ConnectPanel.show(context, api, logger, installer, async () => { contextMonitor.start(); await health.refresh(); });
    } else {
        await api.setApiKey(existing);
        // Status bar stays "disconnected" until the first health snapshot
        // confirms the server actually accepts this key. Without this, an
        // expired/revoked key shows "connected" for a few seconds before the
        // first poll completes — first-impression lie. The onUpdate handler
        // (above) flips to "connected" / "error" based on snap.online.

        // Re-run wiring on activation so any host-config drift gets healed.
        // Defer to next tick so wire's disk I/O doesn't block activation.
        setImmediate(() => {
            installer.wire({
                endpoint: settings.endpoint(),
                apiKey: existing,
                ...settings.guardInputs(),
            }).catch((e: unknown) => {
                const msg = `Re-wire on activation failed: ${(e as Error).message}`;
                logger.warn(msg);
                vscode.window.showWarningMessage(
                    `MemoryAI: Failed to update config files. Check Output > MemoryAI for details. You may need to reconnect.`,
                    'Open Output'
                ).then(action => {
                    if (action === 'Open Output') {
                        vscode.commands.executeCommand('memoryai.exportLogs');
                    }
                });
            });
        });
        // Start polling once we have a key.
        health.start();
        contextMonitor.start();
        logger.info('API key restored from SecretStorage; extension ready.');
    }

    logger.info(`MemoryAI v${context.extension.packageJSON.version} active.`);
}

export function deactivate(): void {
    logger?.info('MemoryAI deactivating.');
}

/**
 * Surface a critical context-pressure episode through real IDE UI.
 *
 * This is the reliable replacement for the model-mediated `action_prompt`
 * notice: a `showWarningMessage` modal + a persistent warning status-bar item.
 * The model cannot suppress either — they are rendered by VS Code, not echoed
 * by the agent.
 *
 * Dedup: fire the modal at most once per pressure episode (keyed on the
 * server's `setAt`). The status-bar overlay stays up for the whole episode so
 * the cue persists after the modal is dismissed; it clears when pressure ends.
 *
 * Host gating is automatic: only AI assistant/Cursor/Windsurf run this extension.
 * Claude Code (CLI, auto-compacts) has no extension polling /v1/stats, so it
 * never shows this — exactly as intended.
 */
function handleContextPressure(snap: HealthSnapshot, bar: StatusBar, log: Logger): void {
    const p = snap.contextPressure;
    if (!p || (p.recommendation !== 'compact_now' && p.recommendation !== 'spawn_now')) {
        // No (or no longer) critical pressure — drop any overlay.
        bar.setPressure(false);
        return;
    }

    // Keep the persistent overlay visible for the whole episode.
    bar.setPressure(true, p.usagePercent);

    // Modal: once per episode only.
    if (p.setAt && p.setAt === lastNotifiedPressureSetAt) {
        return;
    }
    lastNotifiedPressureSetAt = p.setAt;

    const pct = p.usagePercent > 0 ? ` (${Math.round(p.usagePercent)}%)` : '';
    log.info(`context-pressure ${p.recommendation}${pct} — surfacing notice`);
    vscode.window
        .showWarningMessage(
            `MemoryAI: Context is full${pct}. Everything is saved to your brain — ` +
                `run /compact or open a new chat and I'll restore the full context automatically.`,
            'Got it',
        )
        .then(undefined, (e: unknown) => log.debug(`pressure notice dismissed/failed: ${(e as Error).message}`));
}

async function disconnectFlow(context: vscode.ExtensionContext): Promise<void> {
    // Try unwire first — if it fails, don't delete API key (avoid zombie state)
    try {
        const { removed } = await installer.unwire();
        for (const p of removed) logger.info(`unwired ${p}`);
    } catch (e) {
        const msg = `unwire failed: ${(e as Error).message}`;
        logger.warn(msg);
        vscode.window.showErrorMessage(
            `MemoryAI: Failed to remove config files. Check Output > MemoryAI. Disconnect cancelled to avoid orphan state.`,
            'Open Output'
        ).then(action => {
            if (action === 'Open Output') {
                vscode.commands.executeCommand('memoryai.exportLogs');
            }
        });
        return; // Abort disconnect — don't delete key if unwire failed
    }

    // Unwire succeeded → safe to delete API key
    await context.secrets.delete(SECRET_API_KEY);
    await api.setApiKey('');
    contextMonitor.stop();
    statusBar.show('disconnected');
    vscode.window.showInformationMessage('MemoryAI disconnected. Memory persistence paused.');
}

/**
 * MemoryAI: Configure Compact Threshold — quick-pick + input flow.
 *
 * The thresholds live on the SERVER, per tenant. This command:
 *   1. Fetches current effective settings via GET /v1/context/guard/settings.
 *   2. Asks the user for new compact_at_tokens / critical_at_tokens (with the
 *      current effective values pre-filled as defaults).
 *   3. POSTs the update; surfaces server-side validation errors verbatim.
 *
 * No client-side fallback storage — the source of truth is the server, so
 * the same thresholds apply across every IDE/host the user connects from.
 */
async function configureCompactThreshold(api: ApiClient, log: Logger): Promise<void> {
    const current = await api.getGuardSettings();
    if (!current) {
        const choice = await vscode.window.showWarningMessage(
            'Could not reach MemoryAI server. Are you connected and online?',
            'Open Connect', 'Cancel',
        );
        if (choice === 'Open Connect') {
            vscode.commands.executeCommand('memoryai.connect');
        }
        return;
    }

    const eff = current.effective;
    const compactStr = await vscode.window.showInputBox({
        title: 'MemoryAI · Compact threshold (tokens)',
        prompt: 'Server starts piggybacking compact directives at this token count. Defaults to 150,000.',
        value: String(eff.compact_at_tokens),
        validateInput: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n) || n < 1_000) return 'Must be at least 1,000.';
            if (n > 10_000_000) return 'Must be at most 10,000,000.';
            return null;
        },
    });
    if (compactStr === undefined) return;
    const compactAt = Number(compactStr);

    const criticalStr = await vscode.window.showInputBox({
        title: 'MemoryAI · Critical threshold (tokens)',
        prompt: `Server forces a compact at this token count. Must be greater than ${compactAt.toLocaleString()}.`,
        value: String(Math.max(eff.critical_at_tokens, compactAt + 1)),
        validateInput: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n) || n < 2_000) return 'Must be at least 2,000.';
            if (n > 10_000_000) return 'Must be at most 10,000,000.';
            if (n <= compactAt) return `Must be strictly greater than compact (${compactAt.toLocaleString()}).`;
            return null;
        },
    });
    if (criticalStr === undefined) return;
    const criticalAt = Number(criticalStr);

    const result = await api.updateGuardSettings({
        compactAtTokens: compactAt,
        criticalAtTokens: criticalAt,
    });

    if (!result.ok) {
        const detail = (result.errors || ['unknown']).join('; ');
        log.warn(`updateGuardSettings rejected: ${detail}`);
        vscode.window.showErrorMessage(`MemoryAI: ${detail}`);
        return;
    }

    const e = result.settings!.effective;
    vscode.window.showInformationMessage(
        `MemoryAI thresholds updated. Compact at ${e.compact_at_tokens.toLocaleString()} / ` +
        `Critical at ${e.critical_at_tokens.toLocaleString()} tokens. Applies across every IDE you connect.`,
    );
}
