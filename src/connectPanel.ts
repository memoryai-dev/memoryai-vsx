import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { Logger } from './logger';
import { ApiClient } from './api';
import { HookInstaller } from './hookInstaller';

const SECRET_API_KEY = 'memoryai.apiKey';

/**
 * ConnectPanel — webview shown when the user clicks the status-bar item
 * (or runs "MemoryAI: Connect"). Replaces the plain input-box flow with a
 * proper UI: logo, key field, frequently-used settings, "Test connection"
 * button, link out to the dashboard for a free key.
 *
 * Settings here are a curated subset of the full 17 (the rest live in
 * standard VS Code Settings UI under "MemoryAI"). We only surface what a
 * user typically tweaks at first connect.
 */
export class ConnectPanel {
    private static current: vscode.WebviewPanel | undefined;

    static show(context: vscode.ExtensionContext, api: ApiClient, log: Logger, installer: HookInstaller, onConnected?: () => Promise<void>): void {
        if (ConnectPanel.current) {
            ConnectPanel.current.reveal(vscode.ViewColumn.Active);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'memoryai.connect',
            'MemoryAI — Connect',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.file(path.dirname(context.extensionPath)), context.extensionUri],
            },
        );
        ConnectPanel.current = panel;
        panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, 'icon.png'));

        const logoUri = panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(context.extensionPath, 'icon.png')),
        );

        const cfg = vscode.workspace.getConfiguration('memoryai');
        const initial = {
            endpoint: cfg.get<string>('endpoint', 'https://memoryai.dev'),
            privateMode: cfg.get<boolean>('privateMode', false),
            statusBar: cfg.get<string>('statusBar', 'savings'),
            hasKey: false,
        };
        context.secrets.get(SECRET_API_KEY).then((existing) => {
            initial.hasKey = !!existing;
            panel.webview.postMessage({ type: 'init', payload: initial });
        });

        panel.webview.html = renderHtml(logoUri.toString(), initial);

        panel.webview.onDidReceiveMessage(async (msg: { type: string; payload?: any }) => {
            try {
                if (msg.type === 'connect') {
                    const key = String(msg.payload?.apiKey ?? '').trim();
                    if (!key.startsWith('hm_sk_')) {
                        panel.webview.postMessage({ type: 'connectResult', ok: false, message: 'Key must start with hm_sk_' });
                        return;
                    }
                    await context.secrets.store(SECRET_API_KEY, key);
                    await api.setApiKey(key);
                    const ok = await api.healthcheck();
                    if (ok) {
                        try {
                            const cfg = vscode.workspace.getConfiguration('memoryai');
                            const endpoint = cfg.get<string>('endpoint', 'https://memoryai.dev');
                            const model = cfg.get<string>('model', '') || undefined;
                            const result = await installer.wire({
                                endpoint, apiKey: key, model,
                            });
                            log.info(`wired ${result.wrote.length} files: ${result.wrote.join(', ')}`);
                        } catch (e) {
                            log.warn(`wiring after connect failed: ${(e as Error).message}`);
                        }
                    }
                    panel.webview.postMessage({
                        type: 'connectResult',
                        ok,
                        message: ok ? 'Connected. Memory works automatically from the next message.' : 'Server rejected the key. Check the endpoint or generate a fresh key.',
                    });
                    if (ok) {
                        vscode.commands.executeCommand('memoryai.statusbar.refresh', 'connected');
                        if (onConnected) {
                            try { await onConnected(); } catch (e) {
                                log.debug(`onConnected hook: ${(e as Error).message}`);
                            }
                        }
                    }
                } else if (msg.type === 'disconnect') {
                    await context.secrets.delete(SECRET_API_KEY);
                    await api.setApiKey('');
                    try {
                        const { removed } = await installer.unwire();
                        for (const p of removed) log.info(`unwired ${p}`);
                    } catch (e) {
                        log.warn(`unwire after disconnect failed: ${(e as Error).message}`);
                    }
                    panel.webview.postMessage({ type: 'connectResult', ok: true, message: 'Disconnected.' });
                    vscode.commands.executeCommand('memoryai.statusbar.refresh', 'disconnected');
                } else if (msg.type === 'saveSettings') {
                    const p = msg.payload ?? {};
                    const target = vscode.ConfigurationTarget.Global;
                    const c = vscode.workspace.getConfiguration('memoryai');
                    if (typeof p.endpoint === 'string') await c.update('endpoint', p.endpoint, target);
                    if (typeof p.privateMode === 'boolean') await c.update('privateMode', p.privateMode, target);
                    if (typeof p.statusBar === 'string') await c.update('statusBar', p.statusBar, target);
                    panel.webview.postMessage({ type: 'savedSettings' });
                } else if (msg.type === 'openExternal') {
                    const url = String(msg.payload?.url ?? '');
                    if (url.startsWith('https://')) {
                        vscode.env.openExternal(vscode.Uri.parse(url));
                    }
                } else if (msg.type === 'openAdvancedSettings') {
                    vscode.commands.executeCommand('workbench.action.openSettings', '@ext:memoryai.memoryai-vsx');
                }
            } catch (e) {
                log.warn(`ConnectPanel msg ${msg.type} failed: ${(e as Error).message}`);
            }
        });

        panel.onDidDispose(() => {
            ConnectPanel.current = undefined;
        });
    }
}

function renderHtml(logoUri: string, init: Record<string, unknown>): string {
    const initJson = JSON.stringify(init).replace(/</g, '\\u003c');
    return /* html */ `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${logoUri.replace(/[^/]*$/, '')} https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>MemoryAI Connect</title>
<style>
:root { color-scheme: light dark; }
body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0; padding: 24px;
    max-width: 520px;
}
.logo-row { display: flex; align-items: center; gap: 14px; margin-bottom: 6px; }
.logo-row img { width: 48px; height: 48px; border-radius: 10px; }
.logo-row h1 { margin: 0; font-size: 22px; font-weight: 600; }
.tag { font-size: 13px; color: var(--vscode-descriptionForeground); margin-bottom: 22px; }
.section { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--vscode-panel-border); }
.section h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--vscode-descriptionForeground); margin: 0 0 10px; font-weight: 600; }
label { display: block; font-size: 13px; margin: 12px 0 4px; }
input[type=text], input[type=password], input[type=number], select {
    width: 100%; box-sizing: border-box;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px; padding: 6px 8px; font-size: 13px;
    font-family: var(--vscode-font-family);
}
input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); }
.row-toggle { display: flex; align-items: center; justify-content: space-between; padding: 6px 0; }
.row-toggle .desc { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
.btn-row { display: flex; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: 0; border-radius: 4px; padding: 8px 16px; font-size: 13px;
    cursor: pointer; font-family: inherit;
}
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
}
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
.status { margin-top: 14px; font-size: 13px; min-height: 18px; }
.status.ok { color: var(--vscode-charts-green, #28a745); }
.status.err { color: var(--vscode-errorForeground); }
a { color: var(--vscode-textLink-foreground); cursor: pointer; }
a:hover { color: var(--vscode-textLink-activeForeground); }
.connected-badge { display: inline-block; padding: 2px 8px; border-radius: 10px;
    background: var(--vscode-charts-green, #28a745); color: #fff; font-size: 11px; }
.muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
.toggle {
    position: relative; width: 36px; height: 20px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 10px; cursor: pointer;
}
.toggle::after {
    content: ''; position: absolute; top: 2px; left: 2px;
    width: 14px; height: 14px; border-radius: 50%;
    background: var(--vscode-foreground); opacity: 0.5;
    transition: left 0.15s, background 0.15s, opacity 0.15s;
}
.toggle.on { background: var(--vscode-charts-green, #28a745); border-color: transparent; }
.toggle.on::after { left: 18px; background: #fff; opacity: 1; }
</style>
</head><body>
<div class="logo-row">
    <img src="${logoUri}" alt="MemoryAI">
    <div>
        <h1>MemoryAI</h1>
        <div class="muted">One brain. Every AI you use. Forever.</div>
    </div>
</div>

<div class="section">
    <h2>Connection</h2>
    <label>API key</label>
    <input id="apiKey" type="password" placeholder="hm_sk_..." autocomplete="off">
    <div class="muted" style="margin-top:6px">
        Don't have one? <a id="getKeyLink">Get a free key from memoryai.dev</a>.
    </div>

    <label>Endpoint</label>
    <input id="endpoint" type="text" placeholder="https://memoryai.dev">

    <div class="btn-row">
        <button id="btnConnect">Connect</button>
        <button id="btnDisconnect" class="secondary">Disconnect</button>
    </div>
    <div class="status" id="status"></div>
</div>

<div class="section">
    <h2>Privacy</h2>
    <div class="row-toggle">
        <div>
            <div>Private mode (local-only, no cloud sync)</div>
            <div class="desc">Required for NDA / regulated data. Disables cross-device recall.</div>
        </div>
        <div id="privateMode" class="toggle"></div>
    </div>
</div>

<div class="section">
    <h2>Display</h2>
    <label>Status bar format</label>
    <select id="statusBar">
        <option value="savings">savings — $5.23 saved today</option>
        <option value="tokens">tokens — 47K / 150K</option>
        <option value="compact">compact — MemoryAI 31%</option>
        <option value="full">full — 31% · 47K/150K · $5.23</option>
        <option value="off">off (hide)</option>
    </select>

    <div class="btn-row">
        <button id="btnSave">Save settings</button>
        <button id="btnAdvanced" class="secondary">Open advanced settings…</button>
    </div>
    <div class="status" id="settingsStatus"></div>
</div>

<script>
const vscode = acquireVsCodeApi();
const init = ${initJson};
const $ = (id) => document.getElementById(id);

function applyInit(p) {
    $('endpoint').value = p.endpoint || '';
    setToggle($('privateMode'), !!p.privateMode);
    $('statusBar').value = p.statusBar || 'savings';
    if (p.hasKey) {
        $('apiKey').placeholder = '••••••••• (key already saved — paste new to replace)';
        $('status').className = 'status ok';
        $('status').textContent = 'Connected.';
    }
}
applyInit(init);

function setToggle(el, on) {
    el.classList.toggle('on', !!on);
    el.dataset.on = on ? '1' : '0';
}
['privateMode'].forEach((id) => {
    $(id).addEventListener('click', () => {
        const on = $(id).dataset.on !== '1';
        setToggle($(id), on);
    });
});

$('btnConnect').addEventListener('click', () => {
    const key = $('apiKey').value.trim();
    if (!key) {
        $('status').className = 'status err';
        $('status').textContent = 'Paste an API key first.';
        return;
    }
    $('status').className = 'status';
    $('status').textContent = 'Connecting…';
    vscode.postMessage({ type: 'connect', payload: { apiKey: key } });
});

$('btnDisconnect').addEventListener('click', () => {
    vscode.postMessage({ type: 'disconnect' });
});

$('btnSave').addEventListener('click', () => {
    vscode.postMessage({
        type: 'saveSettings',
        payload: {
            endpoint: $('endpoint').value.trim(),
            privateMode: $('privateMode').dataset.on === '1',
            statusBar: $('statusBar').value,
        },
    });
});

$('btnAdvanced').addEventListener('click', () => {
    vscode.postMessage({ type: 'openAdvancedSettings' });
});

$('getKeyLink').addEventListener('click', (e) => {
    e.preventDefault();
    vscode.postMessage({ type: 'openExternal', payload: { url: 'https://memoryai.dev/connect' } });
});

window.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'connectResult') {
        $('status').className = 'status ' + (msg.ok ? 'ok' : 'err');
        $('status').textContent = msg.message || (msg.ok ? 'OK' : 'Failed');
    } else if (msg.type === 'savedSettings') {
        $('settingsStatus').className = 'status ok';
        $('settingsStatus').textContent = 'Saved.';
        setTimeout(() => { $('settingsStatus').textContent = ''; }, 1500);
    } else if (msg.type === 'init') {
        applyInit(msg.payload);
    }
});
</script>
</body></html>`;
}
