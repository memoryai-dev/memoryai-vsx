import { Settings } from './settings';
import { Logger } from './logger';

/**
 * Thin client over the MemoryAI HTTP API.
 *
 * No business logic. Every endpoint is a 1:1 wrapper around what the server
 * already exposes. The server decides. The client transports.
 */
export interface TurnCheckRequest {
    turn_count: number;
    avg_tokens_per_turn?: number;
    max_tokens?: number;
    model?: string | null;
    skip_below_turns?: number;
    // Threshold knobs are intentionally not part of the request shape.
    // The server enforces 150K compact / 200K critical for all models.
}

export interface TurnCheckResponse {
    skipped: boolean;
    estimated_tokens: number;
    usage_percent: number;
    recommendation: 'safe' | 'compact_soon' | 'compact_now' | 'spawn_now' | 'anti_loop' | 'rate_limited';
    urgency: 'low' | 'medium' | 'high' | 'critical';
    compact_at_tokens: number;
    critical_at_tokens: number;
    should_compact: boolean;
    action_prompt: string;
    dna_memories: number;
    last_compact_minutes_ago: number | null;
}

export interface RecallResult {
    id: number;
    content: string;
    score: number;
    memory_type?: string;
    tags?: string[];
    confidence_label?: string;
}

/** /v1/stats response (subset we use). */
export interface StatsResponse {
    tenant_id: string;
    plan: string;
    chunks: number;
    storage_mb: number;
    usage_this_month?: { stores?: number; recalls?: number };
    /** Optional savings field — server may not always return; null-safe. */
    saved_today_usd?: number;
    saved_this_month_usd?: number;
    last_store_seconds_ago?: number;
    last_recall_seconds_ago?: number;
    /** Brain identity / biological state — Wave 2.5. Older servers don't
     *  return these; the extension renders without them gracefully. */
    brain_name?: string | null;
    brain_age_days?: number | null;
    last_dream_at?: string | null;
    dna_count?: number | null;
}

/** /v1/context/guard/settings — server-owned per-tenant overrides. */
export interface GuardSettings {
    plan: string;
    defaults: { compact_at_tokens: number; critical_at_tokens: number };
    user_overrides: { compact_at_tokens: number | null; critical_at_tokens: number | null };
    effective: { compact_at_tokens: number; critical_at_tokens: number };
    explanation?: Record<string, string>;
}

export class ApiClient {
    private apiKey = '';
    constructor(
        private settings: Settings,
        private keyProvider: () => Promise<string>,
        private log: Logger,
    ) {}

    async setApiKey(key: string): Promise<void> {
        this.apiKey = key.trim();
    }

    /** Best-effort GET /v1/health-style ping; returns true if 2xx. */
    async healthcheck(): Promise<boolean> {
        try {
            const r = await this.request('GET', '/v1/stats', null);
            return r.ok;
        } catch (e) {
            this.log.warn(`healthcheck failed: ${(e as Error).message}`);
            return false;
        }
    }

    /** Fetch tenant stats — chunk count, storage, monthly activity, savings. */
    async stats(): Promise<StatsResponse | null> {
        const r = await this.request('GET', '/v1/stats', null);
        if (!r.ok) {
            this.log.debug(`stats ${r.status}: ${r.body.slice(0, 200)}`);
            return null;
        }
        try {
            return JSON.parse(r.body) as StatsResponse;
        } catch (e) {
            this.log.warn(`stats parse: ${(e as Error).message}`);
            return null;
        }
    }

    async turnCheck(req: TurnCheckRequest): Promise<TurnCheckResponse | null> {
        const r = await this.request('POST', '/v1/ide/guard/turn-check', req);
        if (!r.ok) {
            this.log.warn(`turn-check ${r.status}: ${r.body.slice(0, 200)}`);
            return null;
        }
        try {
            return JSON.parse(r.body) as TurnCheckResponse;
        } catch (e) {
            this.log.warn(`turn-check parse: ${(e as Error).message}`);
            return null;
        }
    }

    async compact(content: string, taskContext?: string): Promise<boolean> {
        const r = await this.request('POST', '/v1/context/guard/compact', {
            content,
            task_context: taskContext ?? null,
            blocking: false,
        });
        if (!r.ok) this.log.warn(`compact ${r.status}: ${r.body.slice(0, 200)}`);
        return r.ok;
    }

    async bootstrap(task: string, limit = 10): Promise<{ context_block: string; tokens_used: number; memories_restored: number } | null> {
        const r = await this.request('POST', '/v1/ide/guard/bootstrap', { task, limit });
        if (!r.ok) {
            this.log.warn(`bootstrap ${r.status}: ${r.body.slice(0, 200)}`);
            return null;
        }
        try {
            return JSON.parse(r.body);
        } catch (e) {
            this.log.warn(`bootstrap parse: ${(e as Error).message}`);
            return null;
        }
    }

    async recall(query: string, depth: string, limit: number, tokenBudget: number, projectId: string | null): Promise<RecallResult[]> {
        const body: Record<string, unknown> = {
            query,
            depth,
            limit,
            max_tokens: tokenBudget,
        };
        if (projectId) body.project_id = projectId;
        const r = await this.request('POST', '/v1/recall', body);
        if (!r.ok) {
            this.log.debug(`recall ${r.status}: ${r.body.slice(0, 200)}`);
            return [];
        }
        try {
            const data = JSON.parse(r.body) as { results?: RecallResult[] };
            return data.results ?? [];
        } catch (e) {
            this.log.warn(`recall parse: ${(e as Error).message}`);
            return [];
        }
    }

    async store(content: string, memoryType: string, tags: string[], projectId: string | null): Promise<boolean> {
        const body: Record<string, unknown> = {
            content,
            memory_type: memoryType,
            tags,
        };
        if (projectId) body.project_id = projectId;
        const r = await this.request('POST', '/v1/store', body);
        if (!r.ok) this.log.debug(`store ${r.status}: ${r.body.slice(0, 200)}`);
        return r.ok;
    }

    async l2Inject(query: string, budget: number): Promise<string> {
        const r = await this.request('POST', '/v1/l2/inject', {
            query,
            context_budget_tokens: budget,
        });
        if (!r.ok) return '';
        try {
            const data = JSON.parse(r.body) as { context_block?: string };
            return data.context_block ?? '';
        } catch (e) {
            this.log.warn(`l2Inject parse: ${(e as Error).message}`);
            return '';
        }
    }

    /** GET /v1/context/guard/settings — fetch the effective tenant overrides. */
    async getGuardSettings(): Promise<GuardSettings | null> {
        try {
            const r = await this.request('GET', '/v1/context/guard/settings', null);
            if (!r.ok) {
                this.log.warn(`getGuardSettings ${r.status}: ${r.body.slice(0, 200)}`);
                return null;
            }
            return JSON.parse(r.body) as GuardSettings;
        } catch (e) {
            this.log.warn(`getGuardSettings parse: ${(e as Error).message}`);
            return null;
        }
    }

    /** POST /v1/context/guard/settings — set per-tenant token thresholds.
     *  Pass null to leave a field unchanged. Server validates compact <
     *  critical and rejects 400 on conflict. */
    async updateGuardSettings(args: {
        compactAtTokens?: number | null;
        criticalAtTokens?: number | null;
    }): Promise<{ ok: boolean; settings: GuardSettings | null; errors?: string[] }> {
        const payload: Record<string, number> = {};
        if (typeof args.compactAtTokens === 'number') payload.compact_at_tokens = args.compactAtTokens;
        if (typeof args.criticalAtTokens === 'number') payload.critical_at_tokens = args.criticalAtTokens;
        const r = await this.request('POST', '/v1/context/guard/settings', payload);
        if (!r.ok) {
            try {
                const err = JSON.parse(r.body) as { errors?: string[]; error?: string };
                return { ok: false, settings: null, errors: err.errors || (err.error ? [err.error] : ['unknown_error']) };
            } catch {
                return { ok: false, settings: null, errors: [`HTTP ${r.status}`] };
            }
        }
        try {
            return { ok: true, settings: JSON.parse(r.body) as GuardSettings };
        } catch (e) {
            this.log.warn(`updateGuardSettings parse: ${(e as Error).message}`);
            return { ok: false, settings: null, errors: ['parse_error'] };
        }
    }

    /**
     * Generic HTTP wrapper. Pure fetch — no client-side caching, no retry
     * logic beyond a single attempt. Server decides everything else.
     */
    private async request(method: string, pathName: string, body: unknown): Promise<{ ok: boolean; status: number; body: string }> {
        if (!this.apiKey) {
            this.apiKey = await this.keyProvider();
        }
        const url = `${this.settings.endpoint().replace(/\/+$/, '')}${pathName}`;
        const init: RequestInit = {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
                'User-Agent': 'memoryai-vsx/0.1.0',
            },
            signal: AbortSignal.timeout(20_000),
        };
        if (body !== null && body !== undefined && method !== 'GET') {
            init.body = JSON.stringify(body);
        }
        try {
            const resp = await fetch(url, init);
            const text = await resp.text();
            return { ok: resp.ok, status: resp.status, body: text };
        } catch (e) {
            this.log.warn(`HTTP ${method} ${pathName} failed: ${(e as Error).message}`);
            return { ok: false, status: 0, body: '' };
        }
    }
}
