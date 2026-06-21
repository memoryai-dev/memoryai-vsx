/**
 * HealthMonitor — periodic stats poller for the status bar and health panel.
 *
 * The extension's job is to make MemoryAI's value visible. The MCP server
 * does the actual memory work (store / recall / piggyback) — we just read
 * its tenant counters every minute and surface the numbers so the user
 * always knows the brain is alive and how much it's saving them.
 *
 * Cost: 1 lightweight HTTP call per minute, no LLM. /v1/stats is cached
 * server-side per tenant, so repeated calls don't hit the database.
 */
import * as vscode from 'vscode';

import { ApiClient, StatsResponse } from './api';
import { Logger } from './logger';

type HealthHandler = (snapshot: HealthSnapshot) => void | Promise<void>;

export interface HealthSnapshot {
    /** True when /v1/stats returned within the last poll. */
    online: boolean;
    /** Total chunks the brain holds for this tenant. */
    chunks: number;
    /** Storage size in MB. */
    storageMB: number;
    /** Current month — store calls this month. */
    storesThisMonth: number;
    /** Current month — recall calls this month. */
    recallsThisMonth: number;
    /** USD saved today (server-side computation). 0 when not provided. */
    savedTodayUSD: number;
    /** USD saved this month. 0 when not provided. */
    savedThisMonthUSD: number;
    /** Seconds since last memory_store call. null = unknown / never. */
    lastStoreSecondsAgo: number | null;
    /** Seconds since last memory_recall call. null = unknown / never. */
    lastRecallSecondsAgo: number | null;
    /** Plan name (free / personal / pro / promax / team / enterprise / godfather). */
    plan: string;
    /** Tenant ID. Used for show-stats panel and bug reports. */
    tenantId: string;
    /** Wall-clock time of this snapshot. */
    fetchedAt: number;
    /** Brain identity / biological state (Wave 2.5).
     *  null when server doesn't provide them (older versions). */
    brainName: string | null;
    /** Days since brain was created. null = unknown. */
    brainAgeDays: number | null;
    /** ISO timestamp of last dream cycle. null = never dreamed yet. */
    lastDreamAt: string | null;
    /** Count of DNA-protected memories (preference/decision/identity/pitfall/procedure). */
    dnaCount: number | null;
    /** Context-pressure episode reported by the model via turn-check.
     *  null when no (or stale) critical pressure. Drives the reliable UI
     *  notice (showWarningMessage) the model can't suppress. */
    contextPressure: {
        recommendation: string;
        estimatedTokens: number;
        criticalAtTokens: number;
        usagePercent: number;
        setAt: number;
    } | null;
}

export class HealthMonitor implements vscode.Disposable {
    private timer?: NodeJS.Timeout;
    private handlers: HealthHandler[] = [];
    private last: HealthSnapshot | null = null;
    private inflight = false;

    /** First poll fires 2s after start; afterwards every 60s. */
    private static readonly FIRST_DELAY_MS = 2_000;
    private static readonly POLL_INTERVAL_MS = 60_000;

    constructor(private api: ApiClient, private log: Logger) {}

    /** Subscribe to health snapshot updates. Returns an unsubscribe function. */
    onUpdate(h: HealthHandler): vscode.Disposable {
        this.handlers.push(h);
        return {
            dispose: () => {
                const idx = this.handlers.indexOf(h);
                if (idx >= 0) this.handlers.splice(idx, 1);
            },
        };
    }

    /** Snapshot from the most recent successful poll, or null if never. */
    snapshot(): HealthSnapshot | null { return this.last; }

    /** Start polling. Idempotent. */
    start(): void {
        if (this.timer) return;
        this.timer = setTimeout(() => this.tick(), HealthMonitor.FIRST_DELAY_MS);
    }

    /** Force a poll right now (e.g. after Connect succeeds). */
    async refresh(): Promise<void> {
        await this.poll();
    }

    private async tick(): Promise<void> {
        await this.poll();
        this.timer = setTimeout(() => this.tick(), HealthMonitor.POLL_INTERVAL_MS);
    }

    private async poll(): Promise<void> {
        if (this.inflight) return;
        this.inflight = true;
        try {
            const r: StatsResponse | null = await this.api.stats();
            if (!r) {
                // Server unreachable or 401. Surface offline so the status
                // bar can switch to the "Reconnect" affordance.
                if (this.last) {
                    const offline: HealthSnapshot = { ...this.last, online: false, fetchedAt: Date.now() };
                    this.last = offline;
                    this.fire(offline);
                }
                return;
            }
            const snap: HealthSnapshot = {
                online: true,
                chunks: r.chunks ?? 0,
                storageMB: r.storage_mb ?? 0,
                storesThisMonth: r.usage_this_month?.stores ?? 0,
                recallsThisMonth: r.usage_this_month?.recalls ?? 0,
                savedTodayUSD: r.saved_today_usd ?? 0,
                savedThisMonthUSD: r.saved_this_month_usd ?? 0,
                lastStoreSecondsAgo: typeof r.last_store_seconds_ago === 'number' ? r.last_store_seconds_ago : null,
                lastRecallSecondsAgo: typeof r.last_recall_seconds_ago === 'number' ? r.last_recall_seconds_ago : null,
                plan: r.plan || 'free',
                tenantId: r.tenant_id || '',
                fetchedAt: Date.now(),
                brainName: typeof r.brain_name === 'string' && r.brain_name.length > 0 ? r.brain_name : null,
                brainAgeDays: typeof r.brain_age_days === 'number' ? r.brain_age_days : null,
                lastDreamAt: typeof r.last_dream_at === 'string' && r.last_dream_at.length > 0 ? r.last_dream_at : null,
                dnaCount: typeof r.dna_count === 'number' ? r.dna_count : null,
                contextPressure: r.context_pressure
                    ? {
                          recommendation: r.context_pressure.recommendation,
                          estimatedTokens: r.context_pressure.estimated_tokens ?? 0,
                          criticalAtTokens: r.context_pressure.critical_at_tokens ?? 0,
                          usagePercent: r.context_pressure.usage_percent ?? 0,
                          setAt: r.context_pressure.set_at ?? 0,
                      }
                    : null,
            };
            this.last = snap;
            this.fire(snap);
        } catch (e) {
            this.log.debug(`stats poll failed: ${(e as Error).message}`);
        } finally {
            this.inflight = false;
        }
    }

    private fire(snap: HealthSnapshot): void {
        for (const h of this.handlers) {
            try {
                Promise.resolve(h(snap)).catch((e) =>
                    this.log.warn(`health handler error: ${(e as Error).message}`),
                );
            } catch (e) {
                this.log.warn(`health handler error: ${(e as Error).message}`);
            }
        }
    }

    dispose(): void {
        if (this.timer) clearTimeout(this.timer);
        this.handlers = [];
    }
}
