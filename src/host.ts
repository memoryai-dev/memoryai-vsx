import * as vscode from 'vscode';

/**
 * HostAdapter — host-specific glue. Same extension runs across multiple
 * IDE families; each adapter knows the local command surface.
 */
export interface HostAdapter {
    readonly id: 'kiro' | 'cursor' | 'windsurf' | 'vscode' | 'unknown';
    readonly displayName: string;

    newSessionCommand(): string | null;
    closeTabCommand(): string | null;
    focusInputCommand(): string | null;
}

class KiroAdapter implements HostAdapter {
    readonly id = 'kiro' as const;
    readonly displayName = 'Kiro';
    newSessionCommand(): string { return 'kiroAgent.newSession'; }
    closeTabCommand(): string { return 'kiroAgent.chat.closeSessionTab'; }
    focusInputCommand(): string { return 'kiroAgent.focusChatInput'; }
}

class CursorAdapter implements HostAdapter {
    readonly id = 'cursor' as const;
    readonly displayName = 'Cursor';
    // Cursor exposes `composer.newConversation` via its agent extension; if
    // a future build renames this, the user can override it via
    // `memoryai.host.commandOverride`.
    newSessionCommand(): string { return 'composer.newConversation'; }
    closeTabCommand(): string { return 'workbench.action.closeActiveEditor'; }
    focusInputCommand(): string { return 'composer.focus'; }
}

class WindsurfAdapter implements HostAdapter {
    readonly id = 'windsurf' as const;
    readonly displayName = 'Windsurf';
    newSessionCommand(): string { return 'cascade.newConversation'; }
    closeTabCommand(): string { return 'workbench.action.closeActiveEditor'; }
    focusInputCommand(): string { return 'cascade.focus'; }
}

class VSCodeAdapter implements HostAdapter {
    readonly id = 'vscode' as const;
    readonly displayName = 'Visual Studio Code';
    newSessionCommand(): string { return 'workbench.action.chat.newChat'; }
    closeTabCommand(): string { return 'workbench.action.closeActiveEditor'; }
    focusInputCommand(): string { return 'workbench.action.chat.focusInput'; }
}

class UnknownAdapter implements HostAdapter {
    readonly id = 'unknown' as const;
    readonly displayName: string;
    constructor(name: string) { this.displayName = name; }
    newSessionCommand(): string | null { return null; }
    closeTabCommand(): string | null { return null; }
    focusInputCommand(): string | null { return null; }
}

export function detectHost(): HostAdapter {
    const name = (vscode.env.appName || '').toLowerCase();
    if (name.includes('kiro')) return new KiroAdapter();
    if (name.includes('cursor')) return new CursorAdapter();
    if (name.includes('windsurf')) return new WindsurfAdapter();
    if (name.includes('visual studio code') || name === 'code') return new VSCodeAdapter();
    return new UnknownAdapter(vscode.env.appName || 'unknown');
}

/**
 * Thin layer that runs an IDE command, applying user overrides from
 * `memoryai.host.commandOverride`. Returns true if the command ran.
 */
export async function runHostCommand(
    adapter: HostAdapter,
    kind: 'newSession' | 'closeTab' | 'focusInput',
    override: Record<string, string>,
): Promise<boolean> {
    const builtin = kind === 'newSession' ? adapter.newSessionCommand()
        : kind === 'closeTab' ? adapter.closeTabCommand()
        : adapter.focusInputCommand();
    const cmd = override[kind] ?? builtin;
    if (!cmd) return false;
    try {
        await vscode.commands.executeCommand(cmd);
        return true;
    } catch {
        return false;
    }
}
