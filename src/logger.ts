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
        const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
        this.channel.appendLine(line);
        this.buffer.push(line);
        if (this.buffer.length > Logger.BUFFER_MAX) {
            this.buffer.splice(0, this.buffer.length - Logger.BUFFER_MAX);
        }
    }

    error(msg: string): void { this.write('error', msg); }
    warn(msg: string): void { this.write('warn', msg); }
    info(msg: string): void { this.write('info', msg); }
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
