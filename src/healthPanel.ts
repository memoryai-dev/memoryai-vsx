/**
 * HealthPanel — webview shown when the user clicks the status bar after
 * Connect. Replaces the stub `showSavings` that just bounced to
 * ConnectPanel. Now actually shows live brain stats from /v1/stats.
 *
 * Pure read-only — every datum comes from HealthMonitor.snapshot(). No
 * polling logic here, no decisions; the panel is a presentation layer.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';

import { HealthMonitor, HealthSnapshot } from './healthMonitor';
import { Logger } from './logger';

export class HealthPanel {
    private static current: vscode.WebviewPanel | undefined;

    static show(context: vscode.ExtensionContext, monitor: HealthMonitor, log: Logger): void {
        if (HealthPanel.current) {
            HealthPanel.current.reveal(vscode.ViewColumn.Active);
            HealthPanel.refresh(monitor);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'memoryai.health',
            'MemoryAI — Brain Health',
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] },
        );
        HealthPanel.current = panel;
        panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, 'icon.png'));

        const logoUri = panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(context.extensionPath, 'icon.png')),
        );

        panel.webview.html = renderHtml(logoUri.toString(), monitor.snapshot());

        // Auto-refresh while the panel is open — let the user watch numbers
        // tick up after they ask the agent something.
        const sub = monitor.onUpdate((snap) => {
            try {
                panel.webview.postMessage({ type: 'snapshot', payload: snap });
            } catch {
                /* panel disposed mid-update */
            }
        });

        // Trigger an immediate refresh poll so the panel reflects current
        // state even if the last poll was 50 seconds ago.
        monitor.refresh().catch((e) => log.debug(`refresh on open: ${(e as Error).message}`));

        panel.webview.onDidReceiveMessage(async (msg: { type: string }) => {
            if (msg.type === 'refresh') {
                await monitor.refresh();
            } else if (msg.type === 'openSettings') {
                vscode.commands.executeCommand('workbench.action.openSettings', '@ext:memoryai.memoryai-vsx');
            } else if (msg.type === 'openDashboard') {
                vscode.env.openExternal(vscode.Uri.parse('https://memoryai.dev/dashboard'));
            }
        });

        panel.onDidDispose(() => {
            HealthPanel.current = undefined;
            sub.dispose();
        });
    }

    private static refresh(monitor: HealthMonitor): void {
        if (!HealthPanel.current) return;
        const snap = monitor.snapshot();
        if (snap) HealthPanel.current.webview.postMessage({ type: 'snapshot', payload: snap });
    }
}

function renderHtml(logoUri: string, initial: HealthSnapshot | null): string {
    const initJson = JSON.stringify(initial).replace(/</g, '\\u003c');
    return /* html */ `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${logoUri.replace(/[^/]*$/, '')} https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>MemoryAI Health</title>
<style>
:root { color-scheme: light dark; }
body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0; padding: 28px;
    max-width: 580px;
}
.head { display: flex; align-items: center; gap: 14px; margin-bottom: 6px; }
.head img { width: 44px; height: 44px; border-radius: 10px; }
.head h1 { margin: 0; font-size: 20px; font-weight: 600; }
.tag { font-size: 12.5px; color: var(--vscode-descriptionForeground); margin-bottom: 22px; }

.status-pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px;
    border-radius: 999px; font-size: 11px; font-weight: 500; letter-spacing: .05em;
    text-transform: uppercase; }
.status-pill.ok { background: rgba(40,167,69,0.15); color: var(--vscode-charts-green, #28a745); }
.status-pill.off { background: rgba(220,53,69,0.15); color: var(--vscode-errorForeground, #dc3545); }
.status-pill .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

.kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 22px 0; }
.kpi { padding: 14px 16px; border: 1px solid var(--vscode-panel-border); border-radius: 8px;
    background: var(--vscode-editor-background); }
.kpi-label { font-size: 11.5px; text-transform: uppercase; letter-spacing: .06em;
    color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
.kpi-value { font-size: 22px; font-weight: 600; color: var(--vscode-foreground); }
.kpi-sub { font-size: 11.5px; color: var(--vscode-descriptionForeground); margin-top: 2px; }

.section { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--vscode-panel-border); }
.section h2 { font-size: 12.5px; text-transform: uppercase; letter-spacing: .06em;
    color: var(--vscode-descriptionForeground); margin: 0 0 10px; font-weight: 600; }

.row { display: flex; justify-content: space-between; padding: 6px 0;
    font-size: 13px; border-bottom: 1px dashed var(--vscode-panel-border); }
.row:last-child { border-bottom: 0; }
.row .k { color: var(--vscode-descriptionForeground); }
.row .v { color: var(--vscode-foreground); font-family: var(--vscode-editor-font-family, monospace); }

.btn-row { display: flex; gap: 10px; margin-top: 18px; }
button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: 0; border-radius: 4px; padding: 7px 14px; font-size: 12.5px;
    cursor: pointer; font-family: inherit;
}
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
}
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

.muted { color: var(--vscode-descriptionForeground); font-size: 11.5px; }
</style>
</head><body>

<div class="head">
    <img src="${logoUri}" alt="MemoryAI">
    <div>
        <h1>Brain Health</h1>
        <div class="tag" id="status-line">
            <span class="status-pill off"><span class="dot"></span><span id="status-text">connecting</span></span>
            <span class="muted" id="updated"></span>
        </div>
    </div>
</div>

<div class="kpis">
    <div class="kpi">
        <div class="kpi-label">Saved today</div>
        <div class="kpi-value" id="kpi-saved-today">$0.00</div>
        <div class="kpi-sub" id="kpi-saved-month"></div>
    </div>
    <div class="kpi">
        <div class="kpi-label">Memories stored</div>
        <div class="kpi-value" id="kpi-chunks">—</div>
        <div class="kpi-sub" id="kpi-storage"></div>
    </div>
</div>

<div class="section">
    <h2>This month</h2>
    <div class="row"><span class="k">Stores</span><span class="v" id="m-stores">—</span></div>
    <div class="row"><span class="k">Recalls</span><span class="v" id="m-recalls">—</span></div>
    <div class="row"><span class="k">Plan</span><span class="v" id="m-plan">—</span></div>
</div>

<div class="section">
    <h2>Recent activity</h2>
    <div class="row"><span class="k">Last memory stored</span><span class="v" id="a-store">—</span></div>
    <div class="row"><span class="k">Last memory recall</span><span class="v" id="a-recall">—</span></div>
</div>

<div class="btn-row">
    <button id="btnRefresh">Refresh now</button>
    <button id="btnSettings" class="secondary">Open settings</button>
    <button id="btnDashboard" class="secondary">Open web dashboard</button>
</div>

<p class="muted" style="margin-top:18px">
    Numbers come from your tenant on the MemoryAI server. Updated every 60 seconds while the extension is connected.
</p>

<script>
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

function fmtAgo(secs) {
    if (secs == null) return 'no data yet';
    if (secs < 60) return Math.round(secs) + 's ago';
    if (secs < 3600) return Math.round(secs / 60) + 'm ago';
    if (secs < 86400) return Math.round(secs / 3600) + 'h ago';
    return Math.round(secs / 86400) + 'd ago';
}
function fmtMoney(n) { return '$' + (n || 0).toFixed(2); }
function fmtMB(n) { return (n || 0).toFixed(2) + ' MB'; }
function fmtNum(n) { return (n || 0).toLocaleString(); }

function applySnap(s) {
    if (!s) return;
    $('status-text').textContent = s.online ? 'connected' : 'offline';
    $('status-line').firstElementChild.classList.toggle('ok', !!s.online);
    $('status-line').firstElementChild.classList.toggle('off', !s.online);
    const ts = new Date(s.fetchedAt).toLocaleTimeString();
    $('updated').textContent = '· updated ' + ts;
    $('kpi-saved-today').textContent = fmtMoney(s.savedTodayUSD);
    $('kpi-saved-month').textContent = 'this month: ' + fmtMoney(s.savedThisMonthUSD);
    $('kpi-chunks').textContent = fmtNum(s.chunks);
    $('kpi-storage').textContent = fmtMB(s.storageMB);
    $('m-stores').textContent = fmtNum(s.storesThisMonth);
    $('m-recalls').textContent = fmtNum(s.recallsThisMonth);
    $('m-plan').textContent = s.plan;
    $('a-store').textContent = fmtAgo(s.lastStoreSecondsAgo);
    $('a-recall').textContent = fmtAgo(s.lastRecallSecondsAgo);
}

const init = ${initJson};
if (init) applySnap(init);

$('btnRefresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
$('btnSettings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
$('btnDashboard').addEventListener('click', () => vscode.postMessage({ type: 'openDashboard' }));

window.addEventListener('message', (e) => {
    const msg = e.data || {};
    if (msg.type === 'snapshot') applySnap(msg.payload);
});
</script>

</body></html>`;
}
