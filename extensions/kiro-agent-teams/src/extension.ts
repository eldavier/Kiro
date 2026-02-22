import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// ────────────────────────────────────────────────────────────────────────────
// Kiro Agent Teams — Team preset management & per-agent model selection
// ────────────────────────────────────────────────────────────────────────────

// ── Types ────────────────────────────────────────────────────────────────────

interface AgentModelConfig {
    model: string | string[];
    reason?: string;
}

interface TeamPreset {
    name: string;
    description?: string;
    icon?: string;
    agents: Record<string, AgentModelConfig>;
    /** Internal: file path the preset was loaded from */
    _filePath?: string;
    /** Internal: whether this is a built-in preset */
    _builtIn?: boolean;
}

interface ParsedAgent {
    name: string;
    filePath: string;
    models: string[];
    description?: string;
    /** Raw frontmatter text */
    rawFrontmatter: string;
    /** Full file content */
    rawContent: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const AGENT_NAMES = ['Orchestrator', 'Analyser', 'Planner', 'SkillAttributer', 'Coder'];
const AGENT_ICONS: Record<string, string> = {
    Orchestrator: 'symbol-event',
    Analyser: 'search',
    Planner: 'list-ordered',
    SkillAttributer: 'tag',
    Coder: 'code',
};
const AGENT_ROLES: Record<string, string> = {
    Orchestrator: 'Coordinates the team, delegates work',
    Analyser: 'Deep codebase analysis and architecture review',
    Planner: 'Creates step-by-step implementation plans',
    SkillAttributer: 'Decomposes tasks, assigns priority & complexity',
    Coder: 'Writes production-quality code (only coder)',
};

// ── Utility ──────────────────────────────────────────────────────────────────

function getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function getAgentsDir(): string | undefined {
    const root = getWorkspaceRoot();
    if (!root) { return undefined; }
    const dir = vscode.workspace.getConfiguration('kiro.agentTeams').get<string>('agentsDirectory') || '.github/agents';
    return path.join(root, dir);
}

function getTeamsDir(): string | undefined {
    const root = getWorkspaceRoot();
    if (!root) { return undefined; }
    const dir = vscode.workspace.getConfiguration('kiro.agentTeams').get<string>('teamsDirectory') || '.github/teams';
    return path.join(root, dir);
}

// ── Agent file parsing ───────────────────────────────────────────────────────

function parseAgentFile(filePath: string): ParsedAgent | null {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!frontmatterMatch) { return null; }

        const fm = frontmatterMatch[1];
        const nameMatch = fm.match(/^name:\s*(.+)$/m);
        const descMatch = fm.match(/^description:\s*(.+)$/m);

        // Parse model field (can be scalar or list)
        const models: string[] = [];
        const modelScalar = fm.match(/^model:\s*([^\n]+)$/m);
        if (modelScalar && modelScalar[1].trim() && !modelScalar[1].trim().startsWith('-')) {
            // Scalar: model: some-model
            models.push(modelScalar[1].trim());
        } else {
            // List: model:\n  - model1\n  - model2
            const modelSection = fm.match(/^model:\s*\n((?:\s+-\s+.+\n?)+)/m);
            if (modelSection) {
                const items = modelSection[1].matchAll(/^\s+-\s+(.+)$/gm);
                for (const item of items) {
                    models.push(item[1].trim());
                }
            }
        }

        return {
            name: nameMatch?.[1]?.trim() ?? path.basename(filePath, '.md'),
            filePath,
            models,
            description: descMatch?.[1]?.trim(),
            rawFrontmatter: fm,
            rawContent: content,
        };
    } catch {
        return null;
    }
}

function getAllAgents(): ParsedAgent[] {
    const dir = getAgentsDir();
    if (!dir || !fs.existsSync(dir)) { return []; }

    const agents: ParsedAgent[] = [];
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.md')) { continue; }
        const parsed = parseAgentFile(path.join(dir, file));
        if (parsed && AGENT_NAMES.includes(parsed.name)) {
            agents.push(parsed);
        }
    }
    // Sort by the canonical order
    agents.sort((a, b) => AGENT_NAMES.indexOf(a.name) - AGENT_NAMES.indexOf(b.name));
    return agents;
}

// ── Agent file writing (model field update) ──────────────────────────────────

function updateAgentModel(agent: ParsedAgent, newModels: string[]): void {
    const fm = agent.rawFrontmatter;

    // Build new model section
    let newModelYaml: string;
    if (newModels.length === 1) {
        newModelYaml = `model: ${newModels[0]}`;
    } else {
        newModelYaml = 'model:\n' + newModels.map(m => `  - ${m}`).join('\n');
    }

    // Replace existing model section in frontmatter
    let newFm: string;
    const hasExistingModel = /^model:/m.test(fm);
    if (hasExistingModel) {
        // Replace model scalar or list block
        newFm = fm.replace(/^model:.*(?:\n(?:\s+-\s+.+))*$/m, newModelYaml);
    } else {
        // Insert model after target: line (or after description: if no target)
        const insertAfter = /^target:.+$/m.test(fm) ? /^(target:.+)$/m : /^(description:.+)$/m;
        newFm = fm.replace(insertAfter, `$1\n${newModelYaml}`);
    }

    const newContent = agent.rawContent.replace(
        `---\n${agent.rawFrontmatter}\n---`,
        `---\n${newFm}\n---`
    );

    fs.writeFileSync(agent.filePath, newContent, 'utf8');
}

// ── Preset loading ───────────────────────────────────────────────────────────

function loadPresets(): TeamPreset[] {
    const dir = getTeamsDir();
    if (!dir || !fs.existsSync(dir)) { return []; }

    const presets: TeamPreset[] = [];
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.json') || file.endsWith('.schema.json')) { continue; }
        try {
            const content = fs.readFileSync(path.join(dir, file), 'utf8');
            const preset = JSON.parse(content) as TeamPreset;
            preset._filePath = path.join(dir, file);
            // Built-in presets are the 3 originals
            preset._builtIn = ['free-tier.json', 'best-quality.json', 'balanced.json'].includes(file);
            presets.push(preset);
        } catch { /* skip invalid */ }
    }
    return presets;
}

function savePreset(preset: TeamPreset): void {
    const dir = getTeamsDir();
    if (!dir) { return; }
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const fileName = preset.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.json';
    const filePath = path.join(dir, fileName);

    const toSave: Record<string, unknown> = { ...preset };
    delete toSave._filePath;
    delete toSave._builtIn;
    toSave.$schema = './team-preset.schema.json';

    fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2) + '\n', 'utf8');
}

// ── Apply preset to agent files ──────────────────────────────────────────────

function applyPreset(preset: TeamPreset): { applied: string[]; skipped: string[] } {
    const agents = getAllAgents();
    const applied: string[] = [];
    const skipped: string[] = [];

    for (const agent of agents) {
        const config = preset.agents[agent.name];
        if (!config) {
            skipped.push(agent.name);
            continue;
        }
        const models = Array.isArray(config.model) ? config.model : [config.model];
        updateAgentModel(agent, models);
        applied.push(agent.name);
    }

    // Store as active preset
    vscode.workspace.getConfiguration('kiro.agentTeams').update('activePreset', preset.name, vscode.ConfigurationTarget.Workspace);

    return { applied, skipped };
}

// ── Tree Data Providers ──────────────────────────────────────────────────────

// --- Presets Tree ---

interface PresetTreeItem {
    type: 'preset';
    preset: TeamPreset;
}

interface PresetAgentItem {
    type: 'presetAgent';
    agentName: string;
    models: string[];
    reason?: string;
}

type PresetNode = PresetTreeItem | PresetAgentItem;

class PresetsTreeDataProvider implements vscode.TreeDataProvider<PresetNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<PresetNode | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private presets: TeamPreset[] = [];

    refresh(): void {
        this.presets = loadPresets();
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: PresetNode): vscode.TreeItem {
        if (element.type === 'preset') {
            const active = vscode.workspace.getConfiguration('kiro.agentTeams').get<string>('activePreset');
            const isActive = active === element.preset.name;
            const item = new vscode.TreeItem(
                element.preset.name,
                vscode.TreeItemCollapsibleState.Collapsed
            );
            item.description = isActive ? '$(check) Active' : element.preset.description?.slice(0, 60);
            item.tooltip = new vscode.MarkdownString(
                `**${element.preset.name}**\n\n${element.preset.description ?? ''}\n\n` +
                Object.entries(element.preset.agents).map(([name, cfg]) => {
                    const models = Array.isArray(cfg.model) ? cfg.model : [cfg.model];
                    return `- **${name}**: \`${models[0]}\`${cfg.reason ? ` — ${cfg.reason}` : ''}`;
                }).join('\n')
            );
            item.iconPath = new vscode.ThemeIcon(element.preset.icon || 'organization');
            item.contextValue = element.preset._builtIn ? 'preset' : 'customPreset';
            return item;
        } else {
            const item = new vscode.TreeItem(element.agentName, vscode.TreeItemCollapsibleState.None);
            item.description = element.models[0] || 'not set';
            item.tooltip = element.reason
                ? `${element.agentName}: ${element.models.join(' → ')}\n\n${element.reason}`
                : `${element.agentName}: ${element.models.join(' → ')}`;
            item.iconPath = new vscode.ThemeIcon(AGENT_ICONS[element.agentName] || 'person');
            return item;
        }
    }

    getChildren(element?: PresetNode): PresetNode[] {
        if (!element) {
            if (this.presets.length === 0) { this.presets = loadPresets(); }
            return this.presets.map(preset => ({ type: 'preset' as const, preset }));
        }
        if (element.type === 'preset') {
            return Object.entries(element.preset.agents).map(([agentName, cfg]) => ({
                type: 'presetAgent' as const,
                agentName,
                models: Array.isArray(cfg.model) ? cfg.model : [cfg.model],
                reason: cfg.reason,
            }));
        }
        return [];
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}

// --- Current Team Tree ---

interface AgentModelNode {
    type: 'agentModel';
    agent: ParsedAgent;
}

class CurrentTeamTreeDataProvider implements vscode.TreeDataProvider<AgentModelNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<AgentModelNode | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: AgentModelNode): vscode.TreeItem {
        const agent = element.agent;
        const primaryModel = agent.models[0] || 'not configured';
        const fallbacks = agent.models.slice(1);

        const item = new vscode.TreeItem(agent.name, vscode.TreeItemCollapsibleState.None);
        item.description = primaryModel;
        item.iconPath = new vscode.ThemeIcon(AGENT_ICONS[agent.name] || 'person');
        item.contextValue = 'agentModel';

        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`### ${agent.name}\n\n`);
        tooltip.appendMarkdown(`${AGENT_ROLES[agent.name] || agent.description || ''}\n\n`);
        tooltip.appendMarkdown(`**Primary model:** \`${primaryModel}\`\n\n`);
        if (fallbacks.length > 0) {
            tooltip.appendMarkdown(`**Fallbacks:** ${fallbacks.map(m => `\`${m}\``).join(' → ')}\n\n`);
        }
        tooltip.appendMarkdown(`*Click the edit icon to change the model*`);
        item.tooltip = tooltip;

        return item;
    }

    getChildren(): AgentModelNode[] {
        const agents = getAllAgents();
        return agents.map(agent => ({ type: 'agentModel' as const, agent }));
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}

// ── Quick Picks ──────────────────────────────────────────────────────────────

async function pickModel(): Promise<string[] | undefined> {
    // Gather all known models from vscode.lm
    const allModels = await vscode.lm.selectChatModels({});
    const modelItems: vscode.QuickPickItem[] = allModels.map(m => ({
        label: m.id,
        description: `${m.vendor} — ${m.family}`,
        detail: `Input: ${m.maxInputTokens?.toLocaleString()} tokens, Output: ${(m as { maxOutputTokens?: number }).maxOutputTokens?.toLocaleString() ?? '?'} tokens`,
    }));

    if (modelItems.length === 0) {
        vscode.window.showWarningMessage('No models available. Make sure at least one AI provider extension is active.');
        return undefined;
    }

    const selected = await vscode.window.showQuickPick(modelItems, {
        title: 'Select primary model',
        placeHolder: 'Choose the primary model for this agent',
        canPickMany: false,
    });
    if (!selected) { return undefined; }

    // Ask if they want to add fallback models
    const addFallback = await vscode.window.showQuickPick(
        [{ label: 'No fallbacks', description: 'Use only the primary model' }, { label: 'Add fallback models', description: 'Choose backup models in order of preference' }],
        { title: 'Add fallback models?' }
    );

    if (addFallback?.label === 'Add fallback models') {
        const remaining = modelItems.filter(m => m.label !== selected.label);
        const fallbacks = await vscode.window.showQuickPick(remaining, {
            title: 'Select fallback models (will be tried in order)',
            placeHolder: 'Choose one or more fallback models',
            canPickMany: true,
        });
        if (fallbacks?.length) {
            return [selected.label, ...fallbacks.map(f => f.label)];
        }
    }

    return [selected.label];
}

// ── Extension Entry Point ────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    console.log('Kiro Agent Teams extension activated');

    // Create tree data providers
    const presetsProvider = new PresetsTreeDataProvider();
    const currentTeamProvider = new CurrentTeamTreeDataProvider();

    // Register tree views
    const presetsView = vscode.window.createTreeView('kiroAgentTeams.presetsView', {
        treeDataProvider: presetsProvider,
        showCollapseAll: true,
    });
    const currentTeamView = vscode.window.createTreeView('kiroAgentTeams.currentTeamView', {
        treeDataProvider: currentTeamProvider,
    });

    context.subscriptions.push(presetsView, currentTeamView);

    // ── Commands ──────────────────────────────────────────────────────────

    // Apply preset
    context.subscriptions.push(vscode.commands.registerCommand(
        'kiroAgentTeams.applyPreset',
        async (node?: PresetTreeItem) => {
            let preset: TeamPreset | undefined;

            if (node?.type === 'preset') {
                preset = node.preset;
            } else {
                // Show quick pick of presets
                const presets = loadPresets();
                const pick = await vscode.window.showQuickPick(
                    presets.map(p => ({
                        label: p.name,
                        description: p.description?.slice(0, 80),
                        preset: p,
                    })),
                    { title: 'Select Team Preset', placeHolder: 'Choose a preset to apply' }
                );
                if (!pick) { return; }
                preset = pick.preset;
            }

            const { applied, skipped } = applyPreset(preset);
            currentTeamProvider.refresh();
            presetsProvider.refresh();

            const msg = `Applied "${preset.name}" preset to ${applied.length} agents.`;
            if (skipped.length > 0) {
                vscode.window.showWarningMessage(`${msg} Skipped: ${skipped.join(', ')}`);
            } else {
                vscode.window.showInformationMessage(msg);
            }
        }
    ));

    // Save current config as custom preset
    context.subscriptions.push(vscode.commands.registerCommand(
        'kiroAgentTeams.saveCustomPreset',
        async () => {
            const name = await vscode.window.showInputBox({
                title: 'Preset Name',
                prompt: 'Enter a name for this team preset',
                placeHolder: 'e.g. My Custom Team',
                validateInput: (value) => {
                    if (!value?.trim()) { return 'Name is required'; }
                    if (value.length > 50) { return 'Name too long (max 50 chars)'; }
                    return null;
                },
            });
            if (!name) { return; }

            const description = await vscode.window.showInputBox({
                title: 'Description (optional)',
                prompt: 'Describe this team configuration',
                placeHolder: 'e.g. Optimised for TypeScript projects',
            });

            const agents = getAllAgents();
            const agentsConfig: Record<string, AgentModelConfig> = {};
            for (const agent of agents) {
                agentsConfig[agent.name] = { model: agent.models.length === 1 ? agent.models[0] : agent.models };
            }

            const preset: TeamPreset = {
                name: name.trim(),
                description: description?.trim() || undefined,
                icon: 'bookmark',
                agents: agentsConfig,
            };

            savePreset(preset);
            presetsProvider.refresh();
            vscode.window.showInformationMessage(`Saved preset "${preset.name}".`);
        }
    ));

    // Change individual agent model
    context.subscriptions.push(vscode.commands.registerCommand(
        'kiroAgentTeams.changeAgentModel',
        async (node?: AgentModelNode) => {
            let agent: ParsedAgent | undefined;

            if (node?.type === 'agentModel') {
                agent = node.agent;
            } else {
                // Show quick pick of agents
                const agents = getAllAgents();
                const pick = await vscode.window.showQuickPick(
                    agents.map(a => ({
                        label: a.name,
                        description: a.models[0] || 'not set',
                        detail: AGENT_ROLES[a.name],
                        agent: a,
                    })),
                    { title: 'Select Agent', placeHolder: 'Choose an agent to change its model' }
                );
                if (!pick) { return; }
                agent = pick.agent;
            }

            const models = await pickModel();
            if (!models) { return; }

            updateAgentModel(agent, models);
            currentTeamProvider.refresh();

            // Clear active preset since we've manually changed
            vscode.workspace.getConfiguration('kiro.agentTeams').update('activePreset', '', vscode.ConfigurationTarget.Workspace);
            presetsProvider.refresh();

            vscode.window.showInformationMessage(`${agent.name} → ${models[0]}${models.length > 1 ? ` (+ ${models.length - 1} fallback${models.length > 2 ? 's' : ''})` : ''}`);
        }
    ));

    // Refresh presets
    context.subscriptions.push(vscode.commands.registerCommand(
        'kiroAgentTeams.refreshPresets',
        () => {
            presetsProvider.refresh();
            currentTeamProvider.refresh();
        }
    ));

    // Open agent file
    context.subscriptions.push(vscode.commands.registerCommand(
        'kiroAgentTeams.openAgentFile',
        async (node?: AgentModelNode) => {
            if (node?.type === 'agentModel') {
                await vscode.window.showTextDocument(vscode.Uri.file(node.agent.filePath));
            }
        }
    ));

    // Delete custom preset
    context.subscriptions.push(vscode.commands.registerCommand(
        'kiroAgentTeams.deletePreset',
        async (node?: PresetTreeItem) => {
            if (!node || node.type !== 'preset' || node.preset._builtIn) { return; }
            const confirm = await vscode.window.showWarningMessage(
                `Delete preset "${node.preset.name}"?`,
                { modal: true },
                'Delete'
            );
            if (confirm !== 'Delete') { return; }
            if (node.preset._filePath) {
                fs.unlinkSync(node.preset._filePath);
            }
            presetsProvider.refresh();
            vscode.window.showInformationMessage(`Deleted preset "${node.preset.name}".`);
        }
    ));

    // ── File watcher ─────────────────────────────────────────────────────

    // Watch for changes to agent and preset files
    const agentsWatcher = vscode.workspace.createFileSystemWatcher('**/.github/agents/*.md');
    const presetsWatcher = vscode.workspace.createFileSystemWatcher('**/.github/teams/*.json');

    agentsWatcher.onDidChange(() => currentTeamProvider.refresh());
    agentsWatcher.onDidCreate(() => currentTeamProvider.refresh());
    agentsWatcher.onDidDelete(() => currentTeamProvider.refresh());

    presetsWatcher.onDidChange(() => presetsProvider.refresh());
    presetsWatcher.onDidCreate(() => presetsProvider.refresh());
    presetsWatcher.onDidDelete(() => presetsProvider.refresh());

    context.subscriptions.push(agentsWatcher, presetsWatcher);

    // ── Status bar item ──────────────────────────────────────────────────

    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusBar.command = 'kiroAgentTeams.applyPreset';
    statusBar.tooltip = 'Click to switch agent team preset';
    context.subscriptions.push(statusBar);

    function updateStatusBar() {
        const active = vscode.workspace.getConfiguration('kiro.agentTeams').get<string>('activePreset');
        if (active) {
            statusBar.text = `$(organization) ${active}`;
        } else {
            statusBar.text = '$(organization) Agent Team';
        }
        statusBar.show();
    }

    updateStatusBar();
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('kiro.agentTeams')) {
                updateStatusBar();
            }
        })
    );

    console.log('Kiro Agent Teams: tree views registered, commands ready');
}

export function deactivate() { }
