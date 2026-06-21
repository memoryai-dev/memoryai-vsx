import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const ORDER: LogLevel[] = ['off', 'error', 'warn', 'info', 'debug', 'trace'];

/**
 * Minimal output-channel logger. Buffers last N lines for export.
 * No external deps; safe in offline / restricted environments.
 */
export class Logger {
    private channel: vscode.OutputChannel;
    private buffer: string[] = [];
    private level: LogLevel = 'warn';
    private static readonly BUFFER_MAX = 5000;

    constructor(name: string) {
        this.channel = vscode.window.createOutputChannel(name);
    }

    setLevel(level: LogLevel): void {
        this.level = level;
    }

    private should(level: LogLevel): boolean {
        return ORDER.indexOf(level) <= ORDER.indexOf(this.level);
    }

    private write(level: LogLevel, msg: string): void {
        if (!this.should(level)) return;
        // Redact sensitive data before logging (API keys, tokens)
        const redacted = this.redactSecrets(msg);
        const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${redacted}`;
        this.channel.appendLine(line);
        this.buffer.push(line);
        if (this.buffer.length > Logger.BUFFER_MAX) {
            this.buffer.splice(0, this.buffer.length - Logger.BUFFER_MAX);
        }
    }

    private redactSecrets(msg: string): string {
        // Redact MemoryAI API keys (hm_sk_...)
        let result = msg.replace(/hm_sk_[A-Za-z0-9_-]+/g, 'hm_sk_***');
        // Redact Bearer tokens
        result = result.replace(/Bearer\s+[A-Za-z0-9_-]+/gi, 'Bearer ***');
        // Redact Authorization header values
        result = result.replace(/(Authorization[:\s]+)([^\s,}]+)/gi, '$1***');
        return result;
    }

    error(msg: string): void { this.write('error', msg); }
    warn(msg: string): void { this.write('warn', msg); }
    info(msg: string): void { this.write('info', msg); }

    /** Write straight to the channel regardless of level. For self-test/probe
     *  output that must always be visible even when logLevel=warn (the default).
     *  Still redacted + buffered like normal lines, and reveals the panel so the
     *  tester doesn't have to hunt for it. */
    raw(msg: string): void {
        const redacted = this.redactSecrets(msg);
        const line = `[${new Date().toISOString()}] [PROBE] ${redacted}`;
        this.channel.appendLine(line);
        this.buffer.push(line);
        if (this.buffer.length > Logger.BUFFER_MAX) {
            this.buffer.splice(0, this.buffer.length - Logger.BUFFER_MAX);
        }
    }

    /** Force the Output panel visible on the MemoryAI channel. */
    reveal(): void {
        this.channel.show(true);
    }
    debug(msg: string): void { this.write('debug', msg); }
    trace(msg: string): void { this.write('trace', msg); }

    async exportLogs(): Promise<void> {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', 'Desktop', `memoryai-logs-${stamp}.txt`);
        try {
            fs.writeFileSync(file, this.buffer.join('\n'), 'utf-8');
            const action = await vscode.window.showInformationMessage(`Logs exported: ${file}`, 'Open');
            if (action === 'Open') {
                await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
            }
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to export logs: ${(e as Error).message}`);
        }
    }
}
