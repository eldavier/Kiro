import * as vscode from 'vscode';

const SESSION_STORAGE_KEY = 'kiro.authentication.sessions';
const DEFAULT_ACCOUNT_ID = 'kiro-user';
const DEFAULT_ACCOUNT_LABEL = 'Kiro User';

class KiroAuthenticationProvider implements vscode.AuthenticationProvider {
    public readonly id = 'kiro';
    public readonly label = 'Kiro';

    private _onDidChangeSessions = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
    private readonly _sessions = new Map<string, vscode.AuthenticationSession>();

    constructor(private readonly context: vscode.ExtensionContext) {
        this.restoreSessions();
    }

    get onDidChangeSessions(): vscode.Event<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent> {
        return this._onDidChangeSessions.event;
    }

    private restoreSessions(): void {
        const stored = this.context.globalState.get<vscode.AuthenticationSession[]>(SESSION_STORAGE_KEY, []);
        for (const session of stored) {
            this._sessions.set(session.id, session);
        }
    }

    private async persistSessions(): Promise<void> {
        await this.context.globalState.update(SESSION_STORAGE_KEY, Array.from(this._sessions.values()));
    }

    private scopesMatch(sessionScopes: readonly string[], requestedScopes: readonly string[]): boolean {
        return requestedScopes.every(scope => sessionScopes.includes(scope));
    }

    async getSessions(scopes: readonly string[] | undefined, options: vscode.AuthenticationProviderSessionOptions): Promise<vscode.AuthenticationSession[]> {
        let sessions = Array.from(this._sessions.values());

        if (options.account) {
            sessions = sessions.filter(session => session.account.id === options.account?.id);
        }

        if (scopes && scopes.length > 0) {
            sessions = sessions.filter(session => this.scopesMatch(session.scopes, scopes));
        }

        return sessions;
    }

    async createSession(scopes: readonly string[], options: vscode.AuthenticationProviderSessionOptions): Promise<vscode.AuthenticationSession> {
        const existingSessions = await this.getSessions(scopes, options);
        if (existingSessions.length > 0) {
            return existingSessions[0];
        }

        const uniqueScopes = Array.from(new Set(scopes));
        const sessionId = `kiro-session-${Date.now()}`;
        const session = {
            id: sessionId,
            accessToken: 'kiro-token',
            account: {
                label: DEFAULT_ACCOUNT_LABEL,
                id: DEFAULT_ACCOUNT_ID
            },
            scopes: uniqueScopes
        };

        this._sessions.set(session.id, session);
        await this.persistSessions();

        this._onDidChangeSessions.fire({ added: [session], removed: [], changed: [] });
        return session;
    }

    async removeSession(sessionId: string): Promise<void> {
        const session = this._sessions.get(sessionId);
        if (!session) {
            return;
        }

        this._sessions.delete(sessionId);
        await this.persistSessions();
        this._onDidChangeSessions.fire({ added: [], removed: [session], changed: [] });
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Kiro Authentication extension activated');
    context.subscriptions.push(vscode.authentication.registerAuthenticationProvider('kiro', 'Kiro', new KiroAuthenticationProvider(context), {
        supportsMultipleAccounts: false,
    }));
}

export function deactivate() {}