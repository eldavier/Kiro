import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { execSync } from 'child_process';

// ────────────────────────────────────────────────────────────────────────────
// Dynamic AI provider extension — fetches available models from each API
// ────────────────────────────────────────────────────────────────────────────

interface DynamicModel {
    id: string;
    name: string;
    family: string;
    version: string;
    maxInput: number;
    maxOutput: number;
    toolCalling?: boolean;
}

interface KiroLanguageModelChatInformation extends vscode.LanguageModelChatInformation {
    readonly vendor?: string;
    readonly isUserSelectable?: boolean;
    readonly category?: { label: string; order: number };
    readonly isDefault?: boolean;
}

interface ApiToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

type ApiMsg =
    | { role: 'system' | 'user' | 'assistant'; content: string; tool_calls?: ApiToolCall[] }
    | { role: 'tool'; content: string; tool_call_id: string };

// ── SSE chunk types (structured streaming) ───────────────────────────────────

interface SseTextChunk { type: 'text'; text: string }
interface SseToolCallChunk { type: 'tool_call'; index: number; id?: string; name?: string; arguments: string }
interface SseThinkingChunk { type: 'thinking'; text: string }
type SseChunk = SseTextChunk | SseToolCallChunk | SseThinkingChunk;

interface KeyOverrides {
    apiKey?: string;
    endpoint?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    region?: string;
}

interface ProviderDef {
    vendor: string;
    displayName: string;
    /** Dynamically fetch available models from the provider API */
    fetchModels(overrides?: KeyOverrides): Promise<DynamicModel[]>;
    /** Build a fetch request for the given messages / model */
    buildRequest(modelId: string, msgs: ApiMsg[], maxTokens: number, temperature: number, overrides?: KeyOverrides): { url: string; init: RequestInit } | null | Promise<{ url: string; init: RequestInit } | null>;
    /** Extract the assistant text from a non-streamed JSON body */
    extractText(body: Record<string, unknown>): string;
    /** If true, response is SSE-streamed */
    stream?: boolean;
    /** Whether this provider uses Anthropic-style SSE events */
    anthropicStream?: boolean;
    /** If true, buildRequest creates the final signed body — streamResponse won't modify it */
    signedBody?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function cfg(k: string): string {
    return vscode.workspace.getConfiguration('kiro.ai').get<string>(k) ?? '';
}

// ── Vertex AI access token cache (OAuth2 refresh token → gcloud fallback) ──
let _vertexToken = '';
let _vertexTokenExpiry = 0;

/** Refresh an access token using an OAuth2 refresh token + client credentials */
async function refreshOAuth2Token(
    clientId: string, clientSecret: string, refreshToken: string
): Promise<{ access_token: string; expires_in: number } | null> {
    try {
        const params = new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
        });
        const resp = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
            signal: AbortSignal.timeout(15_000),
        });
        if (!resp.ok) { return null; }
        return await resp.json() as { access_token: string; expires_in: number };
    } catch {
        return null;
    }
}

/** Get a valid access token for Vertex AI.
 *  Priority: 1) OAuth2 refresh token  2) gcloud CLI  3) explicit apiKey setting */
async function getVertexAccessToken(): Promise<string> {
    // Return cached token if still valid (refresh 5 min before expiry)
    if (_vertexToken && Date.now() < _vertexTokenExpiry - 300_000) {
        return _vertexToken;
    }

    // 1) Try OAuth2 refresh token flow
    const clientId = cfg('vertexAiClientId');
    const clientSecret = cfg('vertexAiClientSecret');
    const refreshToken = cfg('vertexAiRefreshToken');
    if (clientId && clientSecret && refreshToken) {
        const result = await refreshOAuth2Token(clientId, clientSecret, refreshToken);
        if (result?.access_token) {
            _vertexToken = result.access_token;
            _vertexTokenExpiry = Date.now() + (result.expires_in * 1000);
            return _vertexToken;
        }
    }

    // 2) Fall back to gcloud CLI
    try {
        const token = execSync('gcloud auth print-access-token', {
            encoding: 'utf8',
            timeout: 15_000,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (token && token.startsWith('ya29.')) {
            _vertexToken = token;
            _vertexTokenExpiry = Date.now() + 3_600_000; // tokens last ~1 hour
            return _vertexToken;
        }
    } catch {
        // gcloud not installed or not authenticated — fall through
    }
    return '';
}

function env(k: string): string {
    return process.env[k] ?? '';
}

function key(setting: string, ...envKeys: string[]): string {
    const v = cfg(setting);
    if (v) { return v; }
    for (const k of envKeys) {
        const e = env(k);
        if (e) { return e; }
    }
    return '';
}

function toApiMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): ApiMsg[] {
    const out: ApiMsg[] = [];
    for (const m of messages) {
        // Detect system role (value 3 in proposed languageModelSystem API)
        const roleNum = m.role as number;
        if (roleNum === 3) {
            let text = '';
            for (const part of m.content) {
                if (part instanceof vscode.LanguageModelTextPart) { text += part.value; }
            }
            if (text) { out.push({ role: 'system', content: text }); }
            continue;
        }

        const role: 'user' | 'assistant' = m.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant';

        // Collect text, tool call parts, and tool result parts
        const toolCalls: ApiToolCall[] = [];
        const toolResults: Array<{ callId: string; content: string }> = [];
        let text = '';

        for (const part of m.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                text += part.value;
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                toolCalls.push({
                    id: part.callId,
                    type: 'function',
                    function: { name: part.name, arguments: JSON.stringify(part.input) },
                });
            } else if (part instanceof vscode.LanguageModelToolResultPart) {
                let resultText = '';
                for (const c of part.content) {
                    if (c instanceof vscode.LanguageModelTextPart) { resultText += c.value; }
                    else if (typeof c === 'string') { resultText += c; }
                    else { resultText += JSON.stringify(c); }
                }
                toolResults.push({ callId: part.callId, content: resultText });
            }
        }

        // Assistant message with tool calls
        if (role === 'assistant' && toolCalls.length > 0) {
            out.push({ role: 'assistant', content: text || '', tool_calls: toolCalls });
        } else if (text) {
            out.push({ role, content: text });
        }

        // Tool results become separate 'tool' role messages (OpenAI format)
        for (const tr of toolResults) {
            out.push({ role: 'tool', content: tr.content, tool_call_id: tr.callId });
        }
    }
    return out;
}

// ── Extractors ───────────────────────────────────────────────────────────────

function extractOpenAIText(body: Record<string, unknown>): string {
    const choices = body.choices as Array<{ message?: { content?: string } }> | undefined;
    return choices?.[0]?.message?.content ?? '';
}

function extractAnthropicText(body: Record<string, unknown>): string {
    const content = body.content as Array<{ type: string; text?: string }> | undefined;
    return content?.find(c => c.type === 'text')?.text ?? '';
}

function extractGeminiText(body: Record<string, unknown>): string {
    const candidates = body.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined;
    return candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

function extractOllamaText(body: Record<string, unknown>): string {
    const msg = body.message as { content?: string } | undefined;
    return msg?.content ?? '';
}

// ── SSE parsers ──────────────────────────────────────────────────────────────

function* parseSseChunks(text: string): Generator<SseChunk> {
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) { continue; }
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') { break; }
        try {
            const obj = JSON.parse(payload);
            const choice = obj.choices?.[0];
            if (!choice) { continue; }
            const delta = choice.delta;
            if (!delta) { continue; }

            // Text content
            if (typeof delta.content === 'string' && delta.content) {
                yield { type: 'text', text: delta.content };
            }

            // Thinking/reasoning content (DeepSeek R1, QwQ, etc.)
            if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                yield { type: 'thinking', text: delta.reasoning_content };
            }

            // Tool calls (OpenAI-style streaming)
            const tcArr = delta.tool_calls as Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> | undefined;
            if (tcArr) {
                for (const tc of tcArr) {
                    yield {
                        type: 'tool_call',
                        index: tc.index ?? 0,
                        id: tc.id,
                        name: tc.function?.name,
                        arguments: tc.function?.arguments ?? '',
                    };
                }
            }
        } catch { /* skip malformed */ }
    }
}

function* parseAnthropicSseChunks(text: string): Generator<SseChunk> {
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) { continue; }
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') { break; }
        try {
            const obj = JSON.parse(payload);

            // Text delta
            if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta' && obj.delta?.text) {
                yield { type: 'text', text: obj.delta.text };
            }

            // Tool use start (content_block_start with type: "tool_use")
            if (obj.type === 'content_block_start' && obj.content_block?.type === 'tool_use') {
                yield {
                    type: 'tool_call',
                    index: obj.index ?? 0,
                    id: obj.content_block.id,
                    name: obj.content_block.name,
                    arguments: '',
                };
            }

            // Tool use input delta
            if (obj.type === 'content_block_delta' && obj.delta?.type === 'input_json_delta') {
                yield {
                    type: 'tool_call',
                    index: obj.index ?? 0,
                    arguments: obj.delta.partial_json ?? '',
                };
            }

            // Thinking delta (Anthropic extended thinking)
            if (obj.type === 'content_block_delta' && obj.delta?.type === 'thinking_delta' && obj.delta?.thinking) {
                yield { type: 'thinking', text: obj.delta.thinking };
            }
        } catch { /* skip malformed */ }
    }
}

// ── Safe JSON fetcher ────────────────────────────────────────────────────────

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
    try {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) { return null; }
        return await res.json() as T;
    } catch {
        return null;
    }
}

// ── Model-list caching ──────────────────────────────────────────────────────

const modelCache = new Map<string, { models: DynamicModel[]; ts: number }>();
const CACHE_TTL = 5 * 60_000; // 5 minutes

async function cachedFetchModels(vendor: string, fetcher: () => Promise<DynamicModel[]>, groupName?: string): Promise<DynamicModel[]> {
    const cacheKey = groupName ? `${vendor}::${groupName}` : vendor;
    const cached = modelCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
        return cached.models;
    }
    try {
        const models = await fetcher();
        if (models.length > 0) {
            modelCache.set(cacheKey, { models, ts: Date.now() });
        }
        return models;
    } catch (err) {
        console.warn(`[Kiro AI] Failed to fetch models for ${cacheKey}:`, err);
        return cached?.models ?? [];
    }
}

// ── AWS SigV4 signing ────────────────────────────────────────────────────────

function sha256Hex(data: string): string {
    return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmacSha256(k: string | Buffer, data: string): Buffer {
    return crypto.createHmac('sha256', k).update(data, 'utf8').digest();
}

function awsSigV4Sign(request: {
    method: string;
    host: string;
    path: string;
    queryString?: string;
    body: string;
    region: string;
    service: string;
    accessKeyId: string;
    secretAccessKey: string;
    extraHeaders?: Record<string, string>;
}): Record<string, string> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(request.body);

    const rawHeaders: Record<string, string> = {
        ...(request.extraHeaders || {}),
        'host': request.host,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
    };

    // Build lowercase-key map for signing
    const headerMap = new Map<string, string>();
    for (const [k, v] of Object.entries(rawHeaders)) {
        headerMap.set(k.toLowerCase(), v.trim());
    }
    const sortedNames = Array.from(headerMap.keys()).sort();
    const signedHeaders = sortedNames.join(';');
    const canonicalHeaders = sortedNames.map(h => `${h}:${headerMap.get(h)}\n`).join('');

    const canonicalRequest = [
        request.method,
        request.path,
        request.queryString || '',
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${request.region}/${request.service}/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;

    const kDate = hmacSha256(`AWS4${request.secretAccessKey}`, dateStamp);
    const kRegion = hmacSha256(kDate, request.region);
    const kService = hmacSha256(kRegion, request.service);
    const kSigning = hmacSha256(kService, 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

    const authorization = `AWS4-HMAC-SHA256 Credential=${request.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
        ...rawHeaders,
        'Authorization': authorization,
    };
}

// ── GitHub Copilot token exchange ────────────────────────────────────────────

interface CopilotTokenData {
    token: string;
    apiEndpoint: string;
    expiresAt: number;
}

let copilotTokenCache: CopilotTokenData | null = null;

async function getCopilotToken(): Promise<CopilotTokenData | null> {
    // Return cached token if still valid (with 5 minute buffer)
    if (copilotTokenCache && copilotTokenCache.expiresAt > Date.now() / 1000 + 300) {
        return copilotTokenCache;
    }

    // Try to get existing GitHub auth session (don't prompt for sign-in)
    let session: vscode.AuthenticationSession | undefined;
    try {
        session = await vscode.authentication.getSession('github', ['read:user'], { createIfNone: false });
    } catch {
        // No GitHub session available
    }
    if (!session) { return null; }

    // Exchange GitHub OAuth token for Copilot API token
    try {
        const response = await fetch('https://api.github.com/copilot_internal/v2/token', {
            headers: {
                'Authorization': `token ${session.accessToken}`,
                'Accept': 'application/json',
                'Editor-Version': 'vscode/1.90.0',
                'Editor-Plugin-Version': 'kiro/1.0.0',
                'User-Agent': 'Kiro/1.0.0',
            },
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
            console.warn(`[Kiro AI] Copilot token exchange failed: ${response.status}`);
            return null;
        }
        const data = await response.json() as { token: string; expires_at: number; endpoints?: { api?: string } };
        copilotTokenCache = {
            token: data.token,
            apiEndpoint: data.endpoints?.api || 'https://api.individual.githubcopilot.com',
            expiresAt: data.expires_at,
        };
        console.log(`[Kiro AI] Copilot token acquired, endpoint: ${copilotTokenCache.apiEndpoint}`);
        return copilotTokenCache;
    } catch (err) {
        console.warn('[Kiro AI] Copilot token exchange error:', err);
        return null;
    }
}

// ── Provider definitions ─────────────────────────────────────────────────────

function buildProviders(): ProviderDef[] {
    return [
        // ─ Anthropic ─────────────────────────────────────────────────────────
        {
            vendor: 'anthropic',
            displayName: 'Anthropic',
            async fetchModels(overrides?: KeyOverrides): Promise<DynamicModel[]> {
                // Anthropic doesn't have a public list-models endpoint that returns
                // capabilities in a useful way. Use known models.
                const apiKey = overrides?.apiKey || key('anthropicApiKey', 'ANTHROPIC_API_KEY');
                if (!apiKey) { return []; }
                const baseEndpoint = overrides?.endpoint || key('anthropicEndpoint', 'ANTHROPIC_API_ENDPOINT') || 'https://api.anthropic.com';
                const modelsUrl = baseEndpoint.replace(/\/v1\/messages$/, '') + '/v1/models';
                // Known flagship models — we'll query /v1/models to discover IDs if available
                interface AnthropicModelsResponse { data: Array<{ id: string; display_name: string; type: string }> }
                const resp = await fetchJson<AnthropicModelsResponse>(
                    modelsUrl,
                    { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } }
                );
                if (resp?.data?.length) {
                    return resp.data
                        .filter(m => m.type === 'model')
                        .map(m => ({
                            id: m.id,
                            name: m.display_name || m.id,
                            family: 'claude',
                            version: m.id.replace(/^claude-/, ''),
                            maxInput: 200_000,
                            maxOutput: m.id.includes('opus') ? 32_000 : m.id.includes('haiku') ? 8_192 : 16_000,
                            toolCalling: true,
                        }));
                }
                // Fallback: hardcoded known models
                return [
                    { id: 'claude-opus-4-6-20260221', name: 'Claude Opus 4.6', family: 'claude', version: '2026-02-21', maxInput: 200_000, maxOutput: 32_000, toolCalling: true },
                    { id: 'claude-sonnet-4-6-20260221', name: 'Claude Sonnet 4.6', family: 'claude', version: '2026-02-21', maxInput: 200_000, maxOutput: 16_000, toolCalling: true },
                    { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', family: 'claude', version: '2024-10-22', maxInput: 200_000, maxOutput: 8_192, toolCalling: true },
                ];
            },
            buildRequest(modelId, msgs, maxTokens, temperature, overrides?: KeyOverrides) {
                const apiKey = overrides?.apiKey || key('anthropicApiKey', 'ANTHROPIC_API_KEY');
                if (!apiKey) { return null; }
                const endpoint = overrides?.endpoint || key('anthropicEndpoint', 'ANTHROPIC_API_ENDPOINT') || 'https://api.anthropic.com/v1/messages';
                const systemMsg = msgs.find(m => m.role === 'system');
                const chatMsgs = msgs.filter(m => m.role !== 'system');
                return {
                    url: endpoint,
                    init: {
                        method: 'POST',
                        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: modelId, max_tokens: maxTokens, temperature, stream: true,
                            ...(systemMsg ? { system: systemMsg.content } : {}),
                            messages: chatMsgs.map(m => ({ role: m.role, content: m.content })),
                        }),
                    },
                };
            },
            extractText: extractAnthropicText,
            stream: true,
            anthropicStream: true,
        },

        // ─ OpenAI ────────────────────────────────────────────────────────────
        {
            vendor: 'openai',
            displayName: 'OpenAI',
            async fetchModels(overrides?: KeyOverrides): Promise<DynamicModel[]> {
                const apiKey = overrides?.apiKey || key('openaiApiKey', 'OPENAI_API_KEY');
                if (!apiKey) { return []; }
                const base = (overrides?.endpoint || key('openaiEndpoint', 'OPENAI_API_ENDPOINT') || 'https://api.openai.com/v1/chat/completions').replace(/\/chat\/completions$/, '');
                interface OpenAIModelsResponse { data: Array<{ id: string; owned_by?: string }> }
                const resp = await fetchJson<OpenAIModelsResponse>(`${base}/models`, {
                    headers: { Authorization: `Bearer ${apiKey}` },
                });
                if (!resp?.data?.length) { return []; }
                // Filter to chat-capable models (gpt-*, o1-*, o3-*, o4-*)
                const chatModels = resp.data.filter(m =>
                    /^(gpt-|o[134]-|o[134]$|chatgpt-)/.test(m.id) && !m.id.includes('instruct') && !m.id.includes('realtime') && !m.id.includes('audio') && !m.id.includes('tts') && !m.id.includes('dall-e') && !m.id.includes('whisper') && !m.id.includes('embedding')
                );
                return chatModels.map(m => {
                    const isO = /^o[134]/.test(m.id);
                    return {
                        id: m.id,
                        name: m.id,
                        family: m.id.split('-')[0],
                        version: m.owned_by ?? '1.0',
                        maxInput: isO ? 200_000 : 128_000,
                        maxOutput: isO ? 100_000 : 16_384,
                        toolCalling: true,
                    };
                });
            },
            buildRequest(modelId, msgs, maxTokens, temperature, overrides?: KeyOverrides) {
                const apiKey = overrides?.apiKey || key('openaiApiKey', 'OPENAI_API_KEY');
                if (!apiKey) { return null; }
                const endpoint = overrides?.endpoint || key('openaiEndpoint', 'OPENAI_API_ENDPOINT') || 'https://api.openai.com/v1/chat/completions';
                return {
                    url: endpoint,
                    init: {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: modelId, stream: true, max_tokens: maxTokens, temperature,
                            messages: msgs.map(m => ({ role: m.role, content: m.content })),
                        }),
                    },
                };
            },
            extractText: extractOpenAIText,
            stream: true,
        },

        // ─ GitHub Models ─────────────────────────────────────────────────────
        {
            vendor: 'github-models',
            displayName: 'GitHub Models',
            async fetchModels(overrides?: KeyOverrides): Promise<DynamicModel[]> {
                const token = overrides?.apiKey || key('githubModelsToken', 'GITHUB_MODELS_TOKEN', 'GITHUB_TOKEN');
                if (!token) { return []; }
                // GitHub Models catalog: GET /models
                interface GHModelsCatalog { data?: Array<{ id: string; name?: string; model_name?: string; friendly_name?: string; summary?: string }> }
                const resp = await fetchJson<GHModelsCatalog | Array<{ id: string; name?: string; friendly_name?: string }>>(
                    'https://models.inference.ai.azure.com/models',
                    { headers: { Authorization: `Bearer ${token}` } }
                );
                let items: Array<{ id: string; name?: string; friendly_name?: string }> = [];
                if (Array.isArray(resp)) {
                    items = resp;
                } else if (resp && 'data' in resp && Array.isArray(resp.data)) {
                    items = resp.data;
                }
                if (!items.length) {
                    // Fallback: known GitHub Models catalogue
                    return [
                        { id: 'gpt-4o', name: 'GPT-4o', family: 'gpt-4o', version: '2024-11-20', maxInput: 128_000, maxOutput: 16_384, toolCalling: true },
                        { id: 'gpt-4o-mini', name: 'GPT-4o Mini', family: 'gpt-4o-mini', version: '2024-07-18', maxInput: 128_000, maxOutput: 16_384, toolCalling: true },
                        { id: 'o3-mini', name: 'o3-mini', family: 'o3', version: '2025-01-31', maxInput: 200_000, maxOutput: 100_000, toolCalling: true },
                        { id: 'Phi-4', name: 'Phi-4', family: 'phi', version: '4', maxInput: 16_384, maxOutput: 4_096 },
                        { id: 'Mistral-Large-2', name: 'Mistral Large 2', family: 'mistral', version: '2', maxInput: 128_000, maxOutput: 4_096, toolCalling: true },
                        { id: 'Meta-Llama-3.1-405B-Instruct', name: 'Llama 3.1 405B', family: 'llama', version: '3.1', maxInput: 128_000, maxOutput: 4_096, toolCalling: true },
                        { id: 'AI21-Jamba-1.5-Large', name: 'Jamba 1.5 Large', family: 'jamba', version: '1.5', maxInput: 256_000, maxOutput: 4_096, toolCalling: true },
                    ];
                }
                return items.map(m => ({
                    id: m.id,
                    name: m.friendly_name || m.name || m.id,
                    family: m.id.split('-')[0].toLowerCase(),
                    version: '1.0',
                    maxInput: 128_000,
                    maxOutput: 16_384,
                    toolCalling: true,
                }));
            },
            buildRequest(modelId, msgs, maxTokens, temperature, overrides?: KeyOverrides) {
                const token = overrides?.apiKey || key('githubModelsToken', 'GITHUB_MODELS_TOKEN', 'GITHUB_TOKEN');
                if (!token) { return null; }
                return {
                    url: 'https://models.inference.ai.azure.com/chat/completions',
                    init: {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: modelId, stream: true, max_tokens: maxTokens, temperature,
                            messages: msgs.map(m => ({ role: m.role, content: m.content })),
                        }),
                    },
                };
            },
            extractText: extractOpenAIText,
            stream: true,
        },

        // ─ OpenRouter ────────────────────────────────────────────────────────
        {
            vendor: 'openrouter',
            displayName: 'OpenRouter',
            async fetchModels(overrides?: KeyOverrides): Promise<DynamicModel[]> {
                const apiKey = overrides?.apiKey || key('openrouterApiKey', 'OPENROUTER_API_KEY');
                if (!apiKey) { return []; }
                interface ORModelsResponse { data: Array<{ id: string; name?: string; context_length?: number; top_provider?: { max_completion_tokens?: number }; architecture?: { tokenizer?: string } }> }
                const resp = await fetchJson<ORModelsResponse>('https://openrouter.ai/api/v1/models');
                if (!resp?.data?.length) { return []; }
                // Return all models — OpenRouter hundreds of models, user can pick
                return resp.data
                    .filter(m => !m.id.includes(':free') || resp.data.length < 500) // keep manageable
                    .slice(0, 200) // cap at 200 to avoid UI overload
                    .map(m => ({
                        id: m.id,
                        name: m.name || m.id,
                        family: m.id.split('/')[0],
                        version: '1.0',
                        maxInput: m.context_length ?? 128_000,
                        maxOutput: m.top_provider?.max_completion_tokens ?? 4_096,
                        toolCalling: true,
                    }));
            },
            buildRequest(modelId, msgs, maxTokens, temperature, overrides?: KeyOverrides) {
                const apiKey = overrides?.apiKey || key('openrouterApiKey', 'OPENROUTER_API_KEY');
                if (!apiKey) { return null; }
                return {
                    url: 'https://openrouter.ai/api/v1/chat/completions',
                    init: {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json',
                            'HTTP-Referer': 'https://kiro.dev', 'X-Title': 'Kiro',
                        },
                        body: JSON.stringify({
                            model: modelId, stream: true, max_tokens: maxTokens, temperature,
                            messages: msgs.map(m => ({ role: m.role, content: m.content })),
                        }),
                    },
                };
            },
            extractText: extractOpenAIText,
            stream: true,
        },

        // ─ Gemini ────────────────────────────────────────────────────────────
        {
            vendor: 'gemini',
            displayName: 'Google Gemini',
            async fetchModels(overrides?: KeyOverrides): Promise<DynamicModel[]> {
                const apiKey = overrides?.apiKey || key('geminiApiKey', 'GOOGLE_API_KEY', 'GEMINI_API_KEY');
                if (!apiKey) { return []; }
                interface GeminiModelsResponse { models: Array<{ name: string; displayName?: string; inputTokenLimit?: number; outputTokenLimit?: number; supportedGenerationMethods?: string[] }> }
                const resp = await fetchJson<GeminiModelsResponse>(
                    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
                );
                if (!resp?.models?.length) { return []; }
                return resp.models
                    .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
                    .map(m => {
                        const id = m.name.replace('models/', '');
                        return {
                            id,
                            name: m.displayName || id,
                            family: 'gemini',
                            version: id,
                            maxInput: m.inputTokenLimit ?? 1_000_000,
                            maxOutput: m.outputTokenLimit ?? 8_192,
                            toolCalling: true,
                        };
                    });
            },
            buildRequest(modelId, msgs, maxTokens, temperature, overrides?: KeyOverrides) {
                const apiKey = overrides?.apiKey || key('geminiApiKey', 'GOOGLE_API_KEY', 'GEMINI_API_KEY');
                if (!apiKey) { return null; }
                const systemMsg = msgs.find(m => m.role === 'system');
                const contents = msgs.filter(m => m.role !== 'system').map(m => ({
                    role: m.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: m.content }],
                }));
                return {
                    url: `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
                    init: {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents,
                            ...(systemMsg ? { systemInstruction: { parts: [{ text: systemMsg.content }] } } : {}),
                            generationConfig: { maxOutputTokens: maxTokens, temperature },
                        }),
                    },
                };
            },
            extractText: extractGeminiText,
        },

        // ─ Groq ──────────────────────────────────────────────────────────────
        {
            vendor: 'groq',
            displayName: 'Groq',
            async fetchModels(overrides?: KeyOverrides): Promise<DynamicModel[]> {
                const apiKey = overrides?.apiKey || key('groqApiKey', 'GROQ_API_KEY');
                if (!apiKey) { return []; }
                interface GroqModelsResponse { data: Array<{ id: string; owned_by?: string; context_window?: number }> }
                const resp = await fetchJson<GroqModelsResponse>('https://api.groq.com/openai/v1/models', {
                    headers: { Authorization: `Bearer ${apiKey}` },
                });
                if (!resp?.data?.length) { return []; }
                return resp.data
                    .filter(m => !m.id.includes('whisper') && !m.id.includes('tts') && !m.id.includes('guard'))
                    .map(m => ({
                        id: m.id,
                        name: m.id,
                        family: m.id.split('-')[0],
                        version: '1.0',
                        maxInput: m.context_window ?? 131_072,
                        maxOutput: Math.min(m.context_window ?? 32_768, 32_768),
                        toolCalling: true,
                    }));
            },
            buildRequest(modelId, msgs, maxTokens, temperature, overrides?: KeyOverrides) {
                const apiKey = overrides?.apiKey || key('groqApiKey', 'GROQ_API_KEY');
                if (!apiKey) { return null; }
                return {
                    url: 'https://api.groq.com/openai/v1/chat/completions',
                    init: {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: modelId, stream: true, max_tokens: maxTokens, temperature,
                            messages: msgs.map(m => ({ role: m.role, content: m.content })),
                        }),
                    },
                };
            },
            extractText: extractOpenAIText,
            stream: true,
        },

        // ─ DeepSeek ──────────────────────────────────────────────────────────
        {
            vendor: 'deepseek',
            displayName: 'DeepSeek',
            async fetchModels(overrides?: KeyOverrides): Promise<DynamicModel[]> {
                const apiKey = overrides?.apiKey || key('deepseekApiKey', 'DEEPSEEK_API_KEY');
                if (!apiKey) { return []; }
                interface DSModelsResponse { data: Array<{ id: string; owned_by?: string }> }
                const resp = await fetchJson<DSModelsResponse>('https://api.deepseek.com/models', {
                    headers: { Authorization: `Bearer ${apiKey}` },
                });
                if (!resp?.data?.length) {
                    return [
                        { id: 'deepseek-chat', name: 'DeepSeek V3', family: 'deepseek', version: '3.0', maxInput: 64_000, maxOutput: 8_192, toolCalling: true },
                        { id: 'deepseek-reasoner', name: 'DeepSeek R1', family: 'deepseek', version: 'r1', maxInput: 64_000, maxOutput: 8_192 },
                    ];
                }
                return resp.data.map(m => ({
                    id: m.id,
                    name: m.id,
                    family: 'deepseek',
                    version: '1.0',
                    maxInput: 64_000,
                    maxOutput: 8_192,
                    toolCalling: m.id.includes('chat'),
                }));
            },
            buildRequest(modelId, msgs, maxTokens, temperature, overrides?: KeyOverrides) {
                const apiKey = overrides?.apiKey || key('deepseekApiKey', 'DEEPSEEK_API_KEY');
                if (!apiKey) { return null; }
                return {
                    url: 'https://api.deepseek.com/chat/completions',
                    init: {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: modelId, stream: true, max_tokens: maxTokens, temperature,
                            messages: msgs.map(m => ({ role: m.role, content: m.content })),
                        }),
                    },
                };
            },
            extractText: extractOpenAIText,
            stream: true,
        },

        // ─ Ollama (local) ────────────────────────────────────────────────────
        {
            vendor: 'ollama',
            displayName: 'Ollama',
            async fetchModels(overrides?: KeyOverrides): Promise<DynamicModel[]> {
                const base = overrides?.endpoint || key('ollamaEndpoint', 'OLLAMA_ENDPOINT') || 'http://localhost:11434';
                interface OllamaTagsResponse { models: Array<{ name: string; model?: string; size?: number; details?: { family?: string; parameter_size?: string } }> }
                const resp = await fetchJson<OllamaTagsResponse>(`${base}/api/tags`);
                if (!resp?.models?.length) { return []; }
                return resp.models.map(m => {
                    const name = m.name || m.model || 'unknown';
                    return {
                        id: name,
                        name: name,
                        family: m.details?.family || name.split(':')[0],
                        version: name.includes(':') ? name.split(':')[1] : 'latest',
                        maxInput: 131_072,
                        maxOutput: 8_192,
                    };
                });
            },
            buildRequest(modelId, msgs, maxTokens, temperature, overrides?: KeyOverrides) {
                const base = overrides?.endpoint || key('ollamaEndpoint', 'OLLAMA_ENDPOINT') || 'http://localhost:11434';
                return {
                    url: `${base}/api/chat`,
                    init: {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: modelId, stream: false,
                            messages: msgs.map(m => ({ role: m.role, content: m.content })),
                            options: { num_predict: maxTokens, temperature },
                        }),
                    },
                };
            },
            extractText: extractOllamaText,
        },

        // ─ AWS Bedrock ───────────────────────────────────────────────────────
        {
            vendor: 'bedrock',
            displayName: 'AWS Bedrock',
            async fetchModels(overrides?: KeyOverrides): Promise<DynamicModel[]> {
                const accessKeyId = overrides?.accessKeyId || key('bedrockAccessKeyId', 'AWS_ACCESS_KEY_ID');
                const secretAccessKey = overrides?.secretAccessKey || key('bedrockSecretAccessKey', 'AWS_SECRET_ACCESS_KEY');
                const region = overrides?.region || cfg('bedrockRegion') || env('AWS_REGION') || env('AWS_DEFAULT_REGION') || 'us-east-1';
                if (!accessKeyId || !secretAccessKey) { return []; }

                const host = `bedrock.${region}.amazonaws.com`;
                const path = '/foundation-models';
                const headers = awsSigV4Sign({
                    method: 'GET', host, path, body: '', region, service: 'bedrock',
                    accessKeyId, secretAccessKey, extraHeaders: {},
                });

                interface BedrockModel {
                    modelId: string; modelName?: string; providerName?: string;
                    inputModalities?: string[]; outputModalities?: string[];
                    modelLifecycle?: { status: string }; inferenceTypesSupported?: string[];
                }

                try {
                    const resp = await fetch(`https://${host}${path}`, {
                        method: 'GET',
                        headers,
                        signal: AbortSignal.timeout(15_000),
                    });
                    if (!resp.ok) {
                        console.warn(`[Kiro AI] Bedrock ListFoundationModels failed: ${resp.status}`);
                        return [];
                    }
                    const data = await resp.json() as { modelSummaries?: BedrockModel[] };
                    if (!data?.modelSummaries?.length) { return []; }

                    return data.modelSummaries
                        .filter(m =>
                            m.modelLifecycle?.status === 'ACTIVE' &&
                            m.inputModalities?.includes('TEXT') &&
                            m.outputModalities?.includes('TEXT') &&
                            m.inferenceTypesSupported?.some(t => t === 'ON_DEMAND' || t === 'CROSS_REGION_INFERENCE')
                        )
                        .map(m => ({
                            id: m.modelId,
                            name: m.modelName || m.modelId,
                            family: m.providerName?.toLowerCase() || m.modelId.split('.')[0],
                            version: m.modelId.split(':')[0].split('-').pop() || '1.0',
                            maxInput: m.modelId.includes('claude') ? 200_000 : 128_000,
                            maxOutput: m.modelId.includes('claude') ? 16_000 : 8_192,
                            toolCalling: true,
                        }));
                } catch (err) {
                    console.warn('[Kiro AI] Bedrock model list error:', err);
                    return [];
                }
            },
            buildRequest(modelId, msgs, maxTokens, temperature, overrides?: KeyOverrides) {
                const accessKeyId = overrides?.accessKeyId || key('bedrockAccessKeyId', 'AWS_ACCESS_KEY_ID');
                const secretAccessKey = overrides?.secretAccessKey || key('bedrockSecretAccessKey', 'AWS_SECRET_ACCESS_KEY');
                const region = overrides?.region || cfg('bedrockRegion') || env('AWS_REGION') || env('AWS_DEFAULT_REGION') || 'us-east-1';
                if (!accessKeyId || !secretAccessKey) { return null; }

                const host = `bedrock-runtime.${region}.amazonaws.com`;
                const encodedModelId = encodeURIComponent(modelId);
                const path = `/model/${encodedModelId}/converse`;

                // Build Bedrock Converse API message format
                const systemParts: Array<{ text: string }> = [];
                const converseMsgs: Array<{ role: string; content: Array<{ text: string }> }> = [];
                for (const m of msgs) {
                    if (m.role === 'system') {
                        systemParts.push({ text: m.content });
                    } else {
                        converseMsgs.push({
                            role: m.role === 'assistant' ? 'assistant' : 'user',
                            content: [{ text: m.content }],
                        });
                    }
                }

                const body = JSON.stringify({
                    messages: converseMsgs,
                    ...(systemParts.length ? { system: systemParts } : {}),
                    inferenceConfig: { maxTokens, temperature },
                });

                const headers = awsSigV4Sign({
                    method: 'POST', host, path, body, region, service: 'bedrock',
                    accessKeyId, secretAccessKey, extraHeaders: { 'content-type': 'application/json', 'accept': 'application/json' },
                });

                return {
                    url: `https://${host}${path}`,
                    init: { method: 'POST', headers, body },
                };
            },
            extractText(body: Record<string, unknown>): string {
                const output = body.output as { message?: { content?: Array<{ text?: string }> } } | undefined;
                return output?.message?.content?.[0]?.text ?? '';
            },
            // Non-streaming: Bedrock Converse uses AWS event stream framing (not standard SSE)
            signedBody: true, // Body is SigV4-signed — must not be modified after buildRequest
        },

        // ─ GitHub Copilot (Premium) ──────────────────────────────────────────
        {
            vendor: 'github-copilot',
            displayName: 'GitHub Copilot',
            async fetchModels(): Promise<DynamicModel[]> {
                const tokenData = await getCopilotToken();
                if (!tokenData) { return []; }

                interface CopilotModel {
                    id: string; name?: string; version?: string;
                    capabilities?: { family?: string; type?: string };
                    model_picker_enabled?: boolean;
                }

                try {
                    const resp = await fetch(`${tokenData.apiEndpoint}/models`, {
                        headers: {
                            'Authorization': `Bearer ${tokenData.token}`,
                            'Accept': 'application/json',
                            'Editor-Version': 'vscode/1.90.0',
                            'Copilot-Integration-Id': 'vscode-chat',
                            'User-Agent': 'Kiro/1.0.0',
                        },
                        signal: AbortSignal.timeout(10_000),
                    });
                    if (!resp.ok) {
                        console.warn(`[Kiro AI] Copilot model list failed: ${resp.status}`);
                        return [];
                    }
                    const data = await resp.json() as { data?: CopilotModel[]; models?: CopilotModel[] };
                    const models = data.data || data.models || [];
                    if (!models.length) { return []; }

                    return models
                        .filter(m => !m.capabilities?.type || m.capabilities.type === 'chat')
                        .map(m => ({
                            id: m.id,
                            name: m.name || m.id,
                            family: m.capabilities?.family || m.id.split('-')[0],
                            version: m.version || '1.0',
                            maxInput: /^o[134]/.test(m.id) ? 200_000 : 128_000,
                            maxOutput: /^o[134]/.test(m.id) ? 100_000 : 16_384,
                            toolCalling: true,
                        }));
                } catch (err) {
                    console.warn('[Kiro AI] Copilot model list error:', err);
                    return [];
                }
            },
            buildRequest(modelId, msgs, maxTokens, temperature) {
                if (!copilotTokenCache) { return null; }
                return {
                    url: `${copilotTokenCache.apiEndpoint}/chat/completions`,
                    init: {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${copilotTokenCache.token}`,
                            'Content-Type': 'application/json',
                            'Editor-Version': 'vscode/1.90.0',
                            'Copilot-Integration-Id': 'vscode-chat',
                            'User-Agent': 'Kiro/1.0.0',
                        },
                        body: JSON.stringify({
                            model: modelId, stream: true, max_tokens: maxTokens, temperature,
                            messages: msgs.map(m => ({ role: m.role, content: m.content })),
                        }),
                    },
                };
            },
            extractText: extractOpenAIText,
            stream: true,
        },

        // ─ Google Vertex AI (Claude + Gemini on GCP) ─────────────────────────
        // Supports two auth modes:
        //   1) Express Mode: set vertexAiApiKey — uses global endpoint with ?key= param
        //      Endpoint: https://aiplatform.googleapis.com/v1/publishers/google/models/{model}:generateContent?key={API_KEY}
        //   2) Standard Mode: OAuth2 refresh token or gcloud CLI — uses regional endpoint with Bearer header
        //      Endpoint: https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/...
        {
            vendor: 'vertex-ai',
            displayName: 'Google Vertex AI',
            async fetchModels(overrides?: KeyOverrides): Promise<DynamicModel[]> {
                // Determine auth mode: Express Mode (API key) vs Standard (Bearer token)
                const expressKey = overrides?.apiKey || key('vertexAiApiKey', 'VERTEXAI_API_KEY', 'GOOGLE_SERVICE_API_KEY');
                const useExpressMode = !!expressKey;

                let authHeader = '';
                if (!useExpressMode) {
                    const bearerToken = await getVertexAccessToken();
                    if (!bearerToken) { return []; }
                    authHeader = `Bearer ${bearerToken}`;
                }

                const projectId = cfg('vertexAiProjectId') || env('GOOGLE_PROJECT_ID') || env('VERTEXAI_PROJECT_ID');
                const region = overrides?.region || cfg('vertexAiRegion') || env('VERTEXAI_REGION') || 'us-central1';

                // Standard mode requires project ID; Express Mode does not
                if (!useExpressMode && !projectId) { return []; }

                // Build the models list URL based on auth mode
                interface VertexModel {
                    name: string; displayName?: string; publisherModelReference?: string;
                    versionId?: string; supportedActions?: { generateContent?: object; chat?: object };
                }
                interface VertexModelsResponse { publisherModels?: VertexModel[]; models?: Array<{ name: string; displayName?: string; supportedDeploymentResourcesTypes?: string[] }> }

                const listUrl = useExpressMode
                    ? `https://aiplatform.googleapis.com/v1/publishers/*/models?filter=task%3D%22GENERATION%22&key=${expressKey}`
                    : `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/*/models?filter=task%3D%22GENERATION%22`;
                const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                if (!useExpressMode) { headers['Authorization'] = authHeader; }

                const resp = await fetchJson<VertexModelsResponse>(listUrl, { headers });

                const models: DynamicModel[] = [];
                if (resp?.publisherModels?.length) {
                    for (const m of resp.publisherModels) {
                        const id = m.name.split('/').pop() || m.name;
                        const isClaude = id.includes('claude');
                        models.push({
                            id,
                            name: m.displayName || id,
                            family: isClaude ? 'claude' : 'gemini',
                            version: m.versionId || '1.0',
                            maxInput: isClaude ? 200_000 : 1_000_000,
                            maxOutput: isClaude ? (id.includes('opus') ? 32_000 : 16_000) : 8_192,
                            toolCalling: true,
                        });
                    }
                }

                // Fallback: known Vertex AI Gemini models (Claude requires Model Garden enablement)
                if (models.length === 0) {
                    return [
                        { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro (Vertex)', family: 'gemini', version: '2.5', maxInput: 1_000_000, maxOutput: 65_536, toolCalling: true },
                        { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash (Vertex)', family: 'gemini', version: '2.5', maxInput: 1_000_000, maxOutput: 65_536, toolCalling: true },
                        { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash (Vertex)', family: 'gemini', version: '2.0', maxInput: 1_000_000, maxOutput: 8_192, toolCalling: true },
                        { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash-Lite (Vertex)', family: 'gemini', version: '2.0', maxInput: 1_000_000, maxOutput: 8_192, toolCalling: true },
                    ];
                }
                return models;
            },
            async buildRequest(modelId: string, msgs: ApiMsg[], maxTokens: number, temperature: number, overrides?: KeyOverrides) {
                // Determine auth mode: Express Mode (API key) vs Standard (Bearer token)
                const expressKey = overrides?.apiKey || key('vertexAiApiKey', 'VERTEXAI_API_KEY', 'GOOGLE_SERVICE_API_KEY');
                const useExpressMode = !!expressKey;

                let authHeader = '';
                if (!useExpressMode) {
                    const bearerToken = await getVertexAccessToken();
                    if (!bearerToken) { return null; }
                    authHeader = `Bearer ${bearerToken}`;
                }

                const projectId = cfg('vertexAiProjectId') || env('GOOGLE_PROJECT_ID') || env('VERTEXAI_PROJECT_ID');
                const region = overrides?.region || cfg('vertexAiRegion') || env('VERTEXAI_REGION') || 'us-central1';
                if (!useExpressMode && !projectId) { return null; }

                const isClaude = modelId.includes('claude');
                const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                if (!useExpressMode) { headers['Authorization'] = authHeader; }

                // Express Mode: global endpoint with ?key= param
                // Standard:     regional endpoint with Bearer header
                if (isClaude) {
                    // Claude is only available in Standard Mode (Model Garden)
                    if (useExpressMode) { return null; }
                    const baseUrl = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}`;
                    const publisherModel = `publishers/anthropic/models/${modelId}`;
                    const systemMsg = msgs.find(m => m.role === 'system');
                    const chatMsgs = msgs.filter(m => m.role !== 'system');
                    return {
                        url: `${baseUrl}/${publisherModel}:streamRawPredict`,
                        init: {
                            method: 'POST',
                            headers,
                            body: JSON.stringify({
                                anthropic_version: 'vertex-2023-10-16',
                                max_tokens: maxTokens, temperature, stream: true,
                                ...(systemMsg ? { system: systemMsg.content } : {}),
                                messages: chatMsgs.map(m => ({ role: m.role, content: m.content })),
                            }),
                        },
                    };
                } else {
                    // Gemini format — works in both Express and Standard modes
                    const systemMsg = msgs.find(m => m.role === 'system');
                    const contents = msgs.filter(m => m.role !== 'system').map(m => ({
                        role: m.role === 'assistant' ? 'model' : 'user',
                        parts: [{ text: m.content }],
                    }));
                    // Gemini 2.5+ models support thinkingConfig
                    const is25 = modelId.includes('2.5');
                    const body = JSON.stringify({
                        contents,
                        ...(systemMsg ? { systemInstruction: { parts: [{ text: systemMsg.content }] } } : {}),
                        generationConfig: {
                            maxOutputTokens: maxTokens,
                            temperature,
                            ...(is25 ? { thinkingConfig: { thinkingBudget: 8192 } } : {}),
                        },
                    });

                    const url = useExpressMode
                        ? `https://aiplatform.googleapis.com/v1/publishers/google/models/${modelId}:streamGenerateContent?alt=sse&key=${expressKey}`
                        : `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${modelId}:streamGenerateContent?alt=sse`;

                    return {
                        url,
                        init: { method: 'POST', headers, body },
                    };
                }
            },
            extractText(body: Record<string, unknown>): string {
                // Handle both Claude and Gemini response formats
                // Claude Vertex format
                const content = body.content as Array<{ type: string; text?: string }> | undefined;
                if (content) { return content.find(c => c.type === 'text')?.text ?? ''; }
                // Gemini Vertex format
                const candidates = body.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined;
                return candidates?.[0]?.content?.parts?.[0]?.text ?? '';
            },
            stream: true,
            anthropicStream: false, // Vertex Claude uses SSE but we handle both formats in parseSseChunks
        },

        // ─ Azure OpenAI ──────────────────────────────────────────────────────
        {
            vendor: 'azure-openai',
            displayName: 'Azure OpenAI',
            async fetchModels(overrides?: KeyOverrides): Promise<DynamicModel[]> {
                const apiKey = overrides?.apiKey || key('azureOpenaiApiKey', 'AZURE_OPENAI_API_KEY');
                const endpoint = overrides?.endpoint || key('azureOpenaiEndpoint', 'AZURE_OPENAI_ENDPOINT');
                if (!apiKey || !endpoint) { return []; }

                // Azure OpenAI: list deployments
                const apiVersion = '2024-10-21';
                interface AzureDeployment {
                    id: string; model: { name?: string; version?: string };
                    status?: string;
                }
                interface AzureDeploymentList { data?: AzureDeployment[] }
                const resp = await fetchJson<AzureDeploymentList>(
                    `${endpoint}/openai/deployments?api-version=${apiVersion}`,
                    { headers: { 'api-key': apiKey } }
                );

                if (resp?.data?.length) {
                    return resp.data
                        .filter(d => d.status === 'succeeded' || !d.status)
                        .map(d => ({
                            id: d.id,
                            name: d.model?.name || d.id,
                            family: (d.model?.name || d.id).split('-')[0],
                            version: d.model?.version || '1.0',
                            maxInput: 128_000,
                            maxOutput: 16_384,
                            toolCalling: true,
                        }));
                }

                // Fallback: use the configured deployment name
                const deployment = cfg('azureOpenaiDeployment') || env('AZURE_OPENAI_DEPLOYMENT');
                if (deployment) {
                    return [{ id: deployment, name: deployment, family: deployment.split('-')[0], version: '1.0', maxInput: 128_000, maxOutput: 16_384, toolCalling: true }];
                }
                return [];
            },
            buildRequest(modelId, msgs, maxTokens, temperature, overrides?: KeyOverrides) {
                const apiKey = overrides?.apiKey || key('azureOpenaiApiKey', 'AZURE_OPENAI_API_KEY');
                const endpoint = overrides?.endpoint || key('azureOpenaiEndpoint', 'AZURE_OPENAI_ENDPOINT');
                if (!apiKey || !endpoint) { return null; }
                const apiVersion = '2024-10-21';
                return {
                    url: `${endpoint}/openai/deployments/${encodeURIComponent(modelId)}/chat/completions?api-version=${apiVersion}`,
                    init: {
                        method: 'POST',
                        headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            stream: true, max_tokens: maxTokens, temperature,
                            messages: msgs.map(m => ({ role: m.role, content: m.content })),
                        }),
                    },
                };
            },
            extractText: extractOpenAIText,
            stream: true,
        },

        // ─ HuggingFace Inference API ─────────────────────────────────────────
        {
            vendor: 'huggingface',
            displayName: 'HuggingFace',
            async fetchModels(overrides?: KeyOverrides): Promise<DynamicModel[]> {
                const token = overrides?.apiKey || key('huggingfaceToken', 'HUGGINGFACE_ACCESS_TOKEN', 'HUGGINGFACE_API_KEY', 'HF_TOKEN');
                if (!token) { return []; }

                // HuggingFace Inference API: list recommended models for text-generation
                interface HFModel { id: string; pipeline_tag?: string; modelId?: string }
                const resp = await fetchJson<HFModel[]>(
                    'https://huggingface.co/api/models?pipeline_tag=text-generation&sort=trending&direction=-1&limit=50&filter=conversational',
                    { headers: { 'Authorization': `Bearer ${token}` } }
                );

                if (resp && Array.isArray(resp) && resp.length > 0) {
                    return resp
                        .filter(m => m.pipeline_tag === 'text-generation')
                        .slice(0, 30)
                        .map(m => ({
                            id: m.id || m.modelId || 'unknown',
                            name: (m.id || m.modelId || 'unknown').split('/').pop() || m.id,
                            family: (m.id || '').split('/')[0],
                            version: '1.0',
                            maxInput: 32_768,
                            maxOutput: 4_096,
                            toolCalling: false,
                        }));
                }

                // Fallback: known good free models
                return [
                    { id: 'mistralai/Mistral-7B-Instruct-v0.3', name: 'Mistral 7B Instruct', family: 'mistral', version: '0.3', maxInput: 32_768, maxOutput: 4_096 },
                    { id: 'meta-llama/Llama-3.1-8B-Instruct', name: 'Llama 3.1 8B', family: 'llama', version: '3.1', maxInput: 128_000, maxOutput: 4_096 },
                    { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen 2.5 72B', family: 'qwen', version: '2.5', maxInput: 131_072, maxOutput: 8_192, toolCalling: true },
                    { id: 'microsoft/Phi-3-mini-4k-instruct', name: 'Phi 3 Mini', family: 'phi', version: '3', maxInput: 4_096, maxOutput: 2_048 },
                ];
            },
            buildRequest(modelId, msgs, maxTokens, temperature, overrides?: KeyOverrides) {
                const token = overrides?.apiKey || key('huggingfaceToken', 'HUGGINGFACE_ACCESS_TOKEN', 'HUGGINGFACE_API_KEY', 'HF_TOKEN');
                if (!token) { return null; }
                // HuggingFace Inference API uses OpenAI-compatible chat completions
                return {
                    url: `https://api-inference.huggingface.co/models/${modelId}/v1/chat/completions`,
                    init: {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: modelId, stream: true, max_tokens: maxTokens, temperature,
                            messages: msgs.map(m => ({ role: m.role, content: m.content })),
                        }),
                    },
                };
            },
            extractText: extractOpenAIText,
            stream: true,
        },

        // ─ Perplexity ────────────────────────────────────────────────────────
        {
            vendor: 'perplexity',
            displayName: 'Perplexity',
            async fetchModels(overrides?: KeyOverrides): Promise<DynamicModel[]> {
                const apiKey = overrides?.apiKey || key('perplexityApiKey', 'PERPLEXITY_API_KEY');
                if (!apiKey) { return []; }

                // Perplexity has an OpenAI-compatible API; try listing models
                interface PPLXModelsResponse { data?: Array<{ id: string; owned_by?: string }> }
                const resp = await fetchJson<PPLXModelsResponse>('https://api.perplexity.ai/models', {
                    headers: { 'Authorization': `Bearer ${apiKey}` },
                });

                if (resp?.data?.length) {
                    return resp.data.map(m => ({
                        id: m.id,
                        name: m.id,
                        family: 'sonar',
                        version: '1.0',
                        maxInput: 128_000,
                        maxOutput: 4_096,
                        toolCalling: m.id.includes('sonar'),
                    }));
                }

                // Fallback: known Perplexity models
                return [
                    { id: 'sonar-pro', name: 'Sonar Pro', family: 'sonar', version: 'pro', maxInput: 200_000, maxOutput: 8_192, toolCalling: true },
                    { id: 'sonar', name: 'Sonar', family: 'sonar', version: '1.0', maxInput: 128_000, maxOutput: 4_096, toolCalling: true },
                    { id: 'sonar-reasoning-pro', name: 'Sonar Reasoning Pro', family: 'sonar', version: 'reasoning-pro', maxInput: 128_000, maxOutput: 8_192, toolCalling: true },
                    { id: 'sonar-reasoning', name: 'Sonar Reasoning', family: 'sonar', version: 'reasoning', maxInput: 128_000, maxOutput: 4_096 },
                    { id: 'sonar-deep-research', name: 'Sonar Deep Research', family: 'sonar', version: 'deep-research', maxInput: 128_000, maxOutput: 8_192 },
                ];
            },
            buildRequest(modelId, msgs, maxTokens, temperature, overrides?: KeyOverrides) {
                const apiKey = overrides?.apiKey || key('perplexityApiKey', 'PERPLEXITY_API_KEY');
                if (!apiKey) { return null; }
                return {
                    url: 'https://api.perplexity.ai/chat/completions',
                    init: {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: modelId, stream: true, max_tokens: maxTokens, temperature,
                            messages: msgs.map(m => ({ role: m.role, content: m.content })),
                        }),
                    },
                };
            },
            extractText: extractOpenAIText,
            stream: true,
        },

        // ─ Requesty (AI Gateway) ─────────────────────────────────────────────
        {
            vendor: 'requesty',
            displayName: 'Requesty',
            async fetchModels(overrides?: KeyOverrides): Promise<DynamicModel[]> {
                const apiKey = overrides?.apiKey || key('requestyApiKey', 'REQUESTY_API_KEY');
                if (!apiKey) { return []; }

                // Requesty is OpenAI-compatible; try listing models
                interface RQModelsResponse { data?: Array<{ id: string; owned_by?: string; context_length?: number }> }
                const resp = await fetchJson<RQModelsResponse>('https://router.requesty.ai/v1/models', {
                    headers: { 'Authorization': `Bearer ${apiKey}` },
                });

                if (resp?.data?.length) {
                    return resp.data
                        .slice(0, 100)
                        .map(m => ({
                            id: m.id,
                            name: m.id,
                            family: m.id.split('/')[0] || m.id.split('-')[0],
                            version: '1.0',
                            maxInput: m.context_length ?? 128_000,
                            maxOutput: 16_384,
                            toolCalling: true,
                        }));
                }
                return [];
            },
            buildRequest(modelId, msgs, maxTokens, temperature, overrides?: KeyOverrides) {
                const apiKey = overrides?.apiKey || key('requestyApiKey', 'REQUESTY_API_KEY');
                if (!apiKey) { return null; }
                return {
                    url: 'https://router.requesty.ai/v1/chat/completions',
                    init: {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: modelId, stream: true, max_tokens: maxTokens, temperature,
                            messages: msgs.map(m => ({ role: m.role, content: m.content })),
                        }),
                    },
                };
            },
            extractText: extractOpenAIText,
            stream: true,
        },

        // ─ Vercel AI Gateway ─────────────────────────────────────────────────
        {
            vendor: 'vercel-ai',
            displayName: 'Vercel AI',
            async fetchModels(overrides?: KeyOverrides): Promise<DynamicModel[]> {
                const apiKey = overrides?.apiKey || key('vercelAiApiKey', 'VERCEL_AI_API_KEY');
                if (!apiKey) { return []; }

                // Vercel AI SDK gateway — OpenAI-compatible
                interface VercelModelsResponse { data?: Array<{ id: string; owned_by?: string }> }
                const resp = await fetchJson<VercelModelsResponse>('https://api.vercel.ai/v1/models', {
                    headers: { 'Authorization': `Bearer ${apiKey}` },
                });

                if (resp?.data?.length) {
                    return resp.data
                        .slice(0, 100)
                        .map(m => ({
                            id: m.id,
                            name: m.id,
                            family: m.id.split('-')[0],
                            version: '1.0',
                            maxInput: 128_000,
                            maxOutput: 16_384,
                            toolCalling: true,
                        }));
                }
                return [];
            },
            buildRequest(modelId, msgs, maxTokens, temperature, overrides?: KeyOverrides) {
                const apiKey = overrides?.apiKey || key('vercelAiApiKey', 'VERCEL_AI_API_KEY');
                if (!apiKey) { return null; }
                return {
                    url: 'https://api.vercel.ai/v1/chat/completions',
                    init: {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: modelId, stream: true, max_tokens: maxTokens, temperature,
                            messages: msgs.map(m => ({ role: m.role, content: m.content })),
                        }),
                    },
                };
            },
            extractText: extractOpenAIText,
            stream: true,
        },

        // ─ You.com Pro (Search-Augmented AI) ─────────────────────────────────
        {
            vendor: 'youpro',
            displayName: 'You.com Pro',
            async fetchModels(overrides?: KeyOverrides): Promise<DynamicModel[]> {
                const apiKey = overrides?.apiKey || key('youproApiKey', 'YOUPRO_API_KEY', 'YOU_API_KEY');
                if (!apiKey) { return []; }

                // You.com provides a research/chat API — known models
                return [
                    { id: 'youchat', name: 'YouChat', family: 'you', version: '1.0', maxInput: 128_000, maxOutput: 4_096, toolCalling: true },
                    { id: 'research', name: 'You Research', family: 'you', version: '1.0', maxInput: 128_000, maxOutput: 8_192 },
                    { id: 'smart', name: 'You Smart (GPT-4 class)', family: 'you', version: '1.0', maxInput: 128_000, maxOutput: 8_192, toolCalling: true },
                ];
            },
            buildRequest(modelId, msgs, _maxTokens, _temperature, overrides?: KeyOverrides) {
                const apiKey = overrides?.apiKey || key('youproApiKey', 'YOUPRO_API_KEY', 'YOU_API_KEY');
                if (!apiKey) { return null; }
                // You.com chat API
                const lastMsg = msgs.filter(m => m.role === 'user').pop();
                const query = lastMsg?.content || '';
                const chatHistory = msgs.filter(m => m.role !== 'system').map(m => ({
                    role: m.role, content: m.content,
                }));
                return {
                    url: 'https://chat-api.you.com/smart',
                    init: {
                        method: 'POST',
                        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            query,
                            chat_mode: modelId === 'research' ? 'research' : modelId === 'smart' ? 'smart' : 'default',
                            chat_history: chatHistory,
                        }),
                    },
                };
            },
            extractText(body: Record<string, unknown>): string {
                // You.com returns { answer: string, ... }
                return (body.answer as string) ?? (body.text as string) ?? '';
            },
            // You.com doesn't support SSE streaming
        },
    ];
}

// ── Anthropic message transformer (converts OpenAI-format tool messages) ─────

function toAnthropicMessages(apiMsgs: ApiMsg[]): unknown[] {
    const out: unknown[] = [];
    for (const m of apiMsgs) {
        if (m.role === 'system') { continue; } // system handled separately
        if ('tool_call_id' in m && m.role === 'tool') {
            // Tool result → Anthropic user message with tool_result content block
            out.push({
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }],
            });
        } else if (m.role === 'assistant' && m.tool_calls?.length) {
            // Assistant with tool calls → content array with text + tool_use blocks
            const content: unknown[] = [];
            if (m.content) { content.push({ type: 'text', text: m.content }); }
            for (const tc of m.tool_calls) {
                let input = {};
                try { input = JSON.parse(tc.function.arguments); } catch { /* empty */ }
                content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
            }
            out.push({ role: 'assistant', content });
        } else {
            out.push({ role: m.role, content: m.content });
        }
    }
    return out;
}

// ── Streaming response handler ───────────────────────────────────────────────

async function streamResponse(
    providerDef: ProviderDef,
    modelId: string,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart>,
    token: vscode.CancellationToken,
    keyOverrides?: KeyOverrides,
): Promise<void> {
    try {
        const apiMsgs = toApiMessages(messages);
        const maxTokens = 16_384;
        const temperature = 0.3;

        const req = await providerDef.buildRequest(modelId, apiMsgs, maxTokens, temperature, keyOverrides);
        if (!req) {
            progress.report(new vscode.LanguageModelTextPart(
                `[${providerDef.displayName}] Not configured. Set your API key in Settings → Kiro AI or via environment variables.`
            ));
            return;
        }

        // Post-process request body: inject tool definitions + transform messages for provider format
        // Skip for signedBody providers (e.g. Bedrock) where body is SigV4-signed
        const tools = options.tools;
        if (req.init.body && !providerDef.signedBody) {
            try {
                const body = JSON.parse(req.init.body as string);

                // Inject tool definitions
                if (tools?.length) {
                    if (providerDef.anthropicStream) {
                        body.tools = tools.map(t => ({
                            name: t.name,
                            description: t.description,
                            input_schema: t.inputSchema ?? { type: 'object', properties: {} },
                        }));
                    } else {
                        body.tools = tools.map(t => ({
                            type: 'function' as const,
                            function: { name: t.name, description: t.description, parameters: t.inputSchema },
                        }));
                        if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
                            body.tool_choice = 'required';
                        }
                    }
                }

                // Transform messages for Anthropic-specific tool format
                const hasToolMsgs = apiMsgs.some(m => ('tool_call_id' in m) || ('tool_calls' in m && (m.tool_calls?.length ?? 0) > 0));
                if (providerDef.anthropicStream && hasToolMsgs) {
                    body.messages = toAnthropicMessages(apiMsgs);
                }

                req.init.body = JSON.stringify(body);
            } catch { /* skip if body parsing fails */ }
        }

        const abortController = new AbortController();
        token.onCancellationRequested(() => abortController.abort());

        const response = await fetch(req.url, { ...req.init, signal: abortController.signal });
        if (!response.ok) {
            const errText = await response.text();
            progress.report(new vscode.LanguageModelTextPart(
                `[${providerDef.displayName}] API error ${response.status}: ${errText.slice(0, 500)}`
            ));
            return;
        }

        if (providerDef.stream && response.body) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            const parseChunks = providerDef.anthropicStream ? parseAnthropicSseChunks : parseSseChunks;

            // Accumulate streamed tool call chunks by index
            const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

            while (true) {
                if (token.isCancellationRequested) { reader.cancel(); break; }
                const { done, value } = await reader.read();
                if (done) { break; }
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop() ?? '';
                const chunk = lines.join('\n');

                for (const part of parseChunks(chunk)) {
                    if (part.type === 'text') {
                        progress.report(new vscode.LanguageModelTextPart(part.text));
                    } else if (part.type === 'tool_call') {
                        let pending = pendingToolCalls.get(part.index);
                        if (!pending) {
                            pending = { id: part.id ?? '', name: part.name ?? '', arguments: '' };
                            pendingToolCalls.set(part.index, pending);
                        }
                        if (part.id) { pending.id = part.id; }
                        if (part.name) { pending.name = part.name; }
                        pending.arguments += part.arguments;
                    } else if (part.type === 'thinking') {
                        // Emit thinking parts if the ThinkingPart proposed API is available
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
                        if (typeof ThinkingPart === 'function') {
                            (progress as vscode.Progress<unknown>).report(
                                new ThinkingPart(part.text)
                            );
                        }
                    }
                }
            }

            // Emit accumulated tool calls as complete LanguageModelToolCallPart objects
            for (const [, tc] of pendingToolCalls) {
                if (tc.name && tc.id) {
                    let input: object = {};
                    try { input = JSON.parse(tc.arguments); } catch { /* empty args */ }
                    progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.name, input));
                }
            }
        } else {
            const body = await response.json() as Record<string, unknown>;
            const text = providerDef.extractText(body);
            if (text) {
                progress.report(new vscode.LanguageModelTextPart(text));
            } else {
                progress.report(new vscode.LanguageModelTextPart(
                    `[${providerDef.displayName}] Empty response from model ${modelId}.`
                ));
            }
        }
    } catch (err: unknown) {
        if (token.isCancellationRequested) {
            return; // User cancelled — swallow the abort error
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Kiro AI] streamResponse error for ${providerDef.vendor}/${modelId}:`, err);
        progress.report(new vscode.LanguageModelTextPart(
            `[${providerDef.displayName}] Stream error: ${message.slice(0, 500)}`
        ));
    }
}

// ── Extension entry point ────────────────────────────────────────────────────

// Track whether any provider has already claimed the default model slot
let hasDefaultModel = false;

export function activate(context: vscode.ExtensionContext) {
    console.log('Kiro AI Providers extension activated');

    const providers = buildProviders();

    // Fire a refresh after a short delay so models populate quickly
    // Then fire the change emitter so the model picker refreshes immediately
    const modelChangeEmitters = new Map<string, vscode.EventEmitter<void>>();

    for (const [providerIndex, providerDef] of providers.entries()) {
        // Event emitter to signal when the model list changes
        const modelChangeEmitter = new vscode.EventEmitter<void>();
        modelChangeEmitters.set(providerDef.vendor, modelChangeEmitter);

        // Periodically refresh models (re-fetch on config change)
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('kiro.ai')) {
                    // Invalidate cache for this vendor so next provideLanguageModelChatInformation re-fetches
                    modelCache.delete(providerDef.vendor);
                    modelChangeEmitter.fire();
                }
            })
        );

        const registration = vscode.lm.registerLanguageModelChatProvider(providerDef.vendor, {
            onDidChangeLanguageModelChatInformation: modelChangeEmitter.event,

            provideLanguageModelChatInformation: async (options, _token) => {
                // Extract per-group overrides from configuration (provider groups feature)
                const config = (options as { configuration?: Record<string, unknown>; group?: string }).configuration;
                const groupName = (options as { group?: string }).group;
                const overrides: KeyOverrides | undefined = config ? {
                    apiKey: config.apiKey as string | undefined,
                    endpoint: config.endpoint as string | undefined,
                    accessKeyId: config.accessKeyId as string | undefined,
                    secretAccessKey: config.secretAccessKey as string | undefined,
                    region: config.region as string | undefined,
                } : undefined;

                const models = await cachedFetchModels(
                    providerDef.vendor,
                    () => providerDef.fetchModels(overrides),
                    groupName
                );
                return models.map((m, modelIndex) => {
                    const displayName = groupName ? `${m.name} (${groupName})` : m.name;
                    // Mark first model of first configured provider as default
                    const isDefault = !hasDefaultModel && modelIndex === 0 && !groupName;
                    if (isDefault) { hasDefaultModel = true; }
                    const modelInfo: KiroLanguageModelChatInformation = {
                        id: m.id,
                        name: displayName,
                        vendor: providerDef.vendor,
                        version: m.version,
                        family: m.family,
                        maxInputTokens: m.maxInput,
                        maxOutputTokens: m.maxOutput,
                        isUserSelectable: true,
                        isDefault,
                        category: {
                            label: groupName ? `${providerDef.displayName} (${groupName})` : providerDef.displayName,
                            order: providerIndex + 1,
                        },
                        capabilities: {
                            toolCalling: m.toolCalling ?? false,
                        },
                    };
                    return modelInfo as vscode.LanguageModelChatInformation;
                });
            },

            provideLanguageModelChatResponse: async (model, messages, options, progress, token) => {
                // Extract per-group overrides from options.configuration
                const config = (options as { configuration?: Record<string, unknown> }).configuration;
                const overrides: KeyOverrides | undefined = config ? {
                    apiKey: config.apiKey as string | undefined,
                    endpoint: config.endpoint as string | undefined,
                    accessKeyId: config.accessKeyId as string | undefined,
                    secretAccessKey: config.secretAccessKey as string | undefined,
                    region: config.region as string | undefined,
                } : undefined;
                await streamResponse(providerDef, model.id, messages, options, progress, token, overrides);
            },

            provideTokenCount: async (_model, text, _token) => {
                if (typeof text === 'string') {
                    return Math.ceil(text.length / 4);
                }
                let len = 0;
                for (const part of (text as vscode.LanguageModelChatRequestMessage).content) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        len += part.value.length;
                    }
                }
                return Math.ceil(len / 4) || 10;
            },
        });
        context.subscriptions.push(registration);
        context.subscriptions.push(modelChangeEmitter);
        console.log(`Registered dynamic provider for vendor '${providerDef.vendor}'`);
    }

    // Pre-fetch models immediately and fire change emitters to populate the picker
    setTimeout(() => {
        for (const providerDef of providers) {
            cachedFetchModels(providerDef.vendor, () => providerDef.fetchModels())
                .then(models => {
                    console.log(`[Kiro AI] ${providerDef.vendor}: ${models.length} models discovered`);
                    // Fire the change emitter so the model picker picks up new models
                    const emitter = modelChangeEmitters.get(providerDef.vendor);
                    if (emitter && models.length > 0) {
                        emitter.fire();
                    }
                })
                .catch(() => { /* silent */ });
        }
    }, 500); // Reduced from 2000ms for faster first-run model display

    console.log(`Kiro AI Providers: ${providers.length} vendors registered (dynamic model fetching enabled)`);
}

export function deactivate() {
    modelCache.clear();
    copilotTokenCache = null;
}