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

let logger: Logger;
let api: ApiClient;
let host: HostAdapter;
let statusBar: StatusBar;
let installer: HookInstaller;
let health: HealthMonitor;

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
    }, logger);

    statusBar = new StatusBar(settings, logger);
    statusBar.show('disconnected');

    installer = new HookInstaller(host, logger);
    health = new HealthMonitor(api, logger);

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
        });
        if (snap.online) {
            statusBar.show('connected');
        } else {
            statusBar.show('error');
        }
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('memoryai.connect',
            () => ConnectPanel.show(context, api, logger, installer, () => health.refresh())),
        vscode.commands.registerCommand('memoryai.disconnect', () => disconnectFlow(context)),
        vscode.commands.registerCommand('memoryai.showHealth',
            () => HealthPanel.show(context, health, logger)),
        // Legacy aliases — keep so users who memorised them still land somewhere useful.
        vscode.commands.registerCommand('memoryai.showSavings',
            () => HealthPanel.show(context, health, logger)),
        vscode.commands.registerCommand('memoryai.openSettings', () =>
            vscode.commands.executeCommand('workbench.action.openSettings', '@ext:memoryai.memoryai-vsx'),
        ),
        vscode.commands.registerCommand('memoryai.exportLogs', () => logger.exportLogs()),
        // Internal — used by ConnectPanel after key save to refresh status bar.
        vscode.commands.registerCommand('memoryai.statusbar.refresh', (state: 'connected' | 'disconnected' | 'error') => {
            statusBar.show(state);
        }),
        statusBar,
        health,
    );

    // First-run experience: if no key, open Connect panel directly.
    const existing = await context.secrets.get(SECRET_API_KEY);
    if (!existing) {
        ConnectPanel.show(context, api, logger, installer, () => health.refresh());
    } else {
        await api.setApiKey(existing);
        statusBar.show('connected');
        // Re-run wiring on activation so any host-config drift gets healed.
        try {
            await installer.wire({
                endpoint: settings.endpoint(),
                apiKey: existing,
                compactAtTokens: settings.compactAtTokens(),
                criticalAtTokens: settings.criticalAtTokens(),
            });
        } catch (e) {
            logger.warn(`Re-wire on activation failed: ${(e as Error).message}`);
        }
        // Start polling once we have a key.
        health.start();
        logger.info('API key restored from SecretStorage; extension ready.');
    }

    logger.info(`MemoryAI v${context.extension.packageJSON.version} active.`);
}

export function deactivate(): void {
    logger?.info('MemoryAI deactivating.');
}

async function disconnectFlow(context: vscode.ExtensionContext): Promise<void> {
    await context.secrets.delete(SECRET_API_KEY);
    await api.setApiKey('');
    statusBar.show('disconnected');
    try {
        const { removed } = await installer.unwire();
        for (const p of removed) logger.info(`unwired ${p}`);
    } catch (e) {
        logger.warn(`unwire failed: ${(e as Error).message}`);
    }
    vscode.window.showInformationMessage('MemoryAI disconnected. Memory persistence paused.');
}
