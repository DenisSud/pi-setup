/**
 * Mem0 provider — direct REST client for a self-hosted Mem0 OSS server.
 *
 * This build supports only "self-hosted" mode: HTTP calls to a deployed Mem0
 * server. The upstream package's Platform (mem0ai SDK) and embedded
 * (mem0ai/oss) code paths were removed to drop those heavy dependencies.
 */

import type {
  AddResult,
  Mem0ExtensionConfig,
  Mem0MemoryMode,
  Mem0Mode,
  MemoryItem,
} from './types.ts';

// ---------------------------------------------------------------------------
// Provider Interface
// ---------------------------------------------------------------------------

type Mem0ScopeOptions = { userId: string; agentId?: string; signal?: AbortSignal };
type Mem0AddOptions = Mem0ScopeOptions & { infer?: boolean; observedAt?: Date | string };
type Mem0SearchOptions = Mem0ScopeOptions & { topK?: number };
const SELF_HOSTED_DEDUP_LIMIT = 1000;

export interface Mem0Provider {
  add(
    messages: Array<{ role: string; content: string }>,
    opts: Mem0AddOptions,
  ): Promise<AddResult | null>;

  search(query: string, opts: Mem0SearchOptions): Promise<MemoryItem[]>;

  getAll(opts: Mem0ScopeOptions): Promise<MemoryItem[]>;

  /** Enumerate maintenance groups that may be deduplicated independently. */
  getDedupGroups?(opts: Mem0ScopeOptions): Promise<MemoryItem[][]>;

  delete(memoryId: string, opts?: { signal?: AbortSignal }): Promise<void>;
}

export function normalizeMem0Mode(mode: unknown): Mem0Mode {
  if (mode === undefined || mode === null || mode === '') return 'self-hosted';
  if (mode === 'self-hosted') return mode;
  throw new Error(
    `Unsupported Mem0 mode: ${String(mode)} — this build supports "self-hosted" only.`,
  );
}

export function normalizeMemoryMode(memoryMode: unknown): Mem0MemoryMode {
  if (memoryMode === undefined || memoryMode === null) return 'hybrid';
  if (memoryMode === 'hybrid' || memoryMode === 'active' || memoryMode === 'passive') {
    return memoryMode;
  }
  throw new Error(`Unsupported memory mode: ${String(memoryMode)}`);
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

function normalizeMemoryItem(raw: Record<string, unknown>): MemoryItem {
  return {
    id: String(raw.id ?? raw.memory_id ?? ''),
    memory: String(raw.memory ?? raw.text ?? raw.content ?? ''),
    score: typeof raw.score === 'number' ? raw.score : undefined,
    user_id: raw.user_id as string | undefined,
    created_at: (raw.created_at ?? raw.createdAt) as string | undefined,
    updated_at: (raw.updated_at ?? raw.updatedAt) as string | undefined,
  };
}

function normalizeResults(raw: unknown): MemoryItem[] {
  if (Array.isArray(raw))
    return raw.map((item) => normalizeMemoryItem(item as Record<string, unknown>));
  if (
    raw &&
    typeof raw === 'object' &&
    'results' in raw &&
    Array.isArray((raw as { results: unknown }).results)
  ) {
    return (raw as { results: unknown[] }).results.map((item) =>
      normalizeMemoryItem(item as Record<string, unknown>),
    );
  }
  return [];
}

function cancellationReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Mem0 request cancelled.');
}

/**
 * Stop awaiting SDK promises promptly when Pi cancels the tool call. Platform
 * and direct REST requests also propagate the signal to fetch; the embedded
 * SDK has no AbortSignal hook, so only the caller's wait can be cancelled.
 */
function waitWithCancellation<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancellationReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancellationReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

// Self-Hosted Provider
// ---------------------------------------------------------------------------

class SelfHostedProvider implements Mem0Provider {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly requestTimeoutMs: number;

  constructor(baseUrl: string, apiKey?: string, requestTimeoutMs = 30_000) {
    this.apiKey = apiKey;
    this.requestTimeoutMs = requestTimeoutMs;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new Error('Self-hosted requestTimeoutMs must be a positive number.');
    }
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Self-hosted mode requires an HTTP(S) baseUrl.');
    }
    this.baseUrl = url.toString().replace(/\/$/, '');
  }

  private async request(
    path: string,
    init: RequestInit,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...init, headers, signal });
    } catch {
      if (callerSignal?.aborted) {
        throw callerSignal.reason instanceof Error
          ? callerSignal.reason
          : new Error('Mem0 request cancelled.');
      }
      if (timeoutSignal.aborted) throw new Error('Mem0 request timed out.');
      throw new Error('Mem0 request failed.');
    }
    if (!response.ok) throw new Error(`Mem0 request failed (${response.status}).`);
    try {
      return await response.json();
    } catch {
      if (callerSignal?.aborted) throw cancellationReason(callerSignal);
      if (timeoutSignal.aborted) throw new Error('Mem0 request timed out.');
      throw new Error('Mem0 returned an invalid response.');
    }
  }

  async add(
    messages: Array<{ role: string; content: string }>,
    opts: Mem0AddOptions,
  ): Promise<AddResult | null> {
    return (await this.request(
      '/memories',
      {
        method: 'POST',
        body: JSON.stringify({
          messages,
          user_id: opts.userId,
          ...(opts.agentId ? { agent_id: opts.agentId } : {}),
          ...(opts.infer === undefined ? {} : { infer: opts.infer }),
        }),
      },
      opts.signal,
    )) as AddResult;
  }

  async search(query: string, opts: Mem0SearchOptions): Promise<MemoryItem[]> {
    const result = await this.request(
      '/search',
      {
        method: 'POST',
        body: JSON.stringify({
          query,
          filters: {
            user_id: opts.userId,
            ...(opts.agentId ? { agent_id: opts.agentId } : {}),
          },
          ...(opts.topK === undefined ? {} : { top_k: opts.topK }),
        }),
      },
      opts.signal,
    );
    return normalizeResults(result);
  }

  async getAll(opts: Mem0ScopeOptions): Promise<MemoryItem[]> {
    const params = new URLSearchParams({ user_id: opts.userId });
    if (opts.agentId) params.set('agent_id', opts.agentId);
    const result = await this.request(`/memories?${params}`, { method: 'GET' }, opts.signal);
    return normalizeResults(result);
  }

  async getDedupGroups(opts: Mem0ScopeOptions): Promise<MemoryItem[][]> {
    const params = new URLSearchParams({ user_id: opts.userId });
    if (opts.agentId) params.set('agent_id', opts.agentId);
    params.set('top_k', String(SELF_HOSTED_DEDUP_LIMIT));
    const result = await this.request(`/memories?${params}`, { method: 'GET' }, opts.signal);
    const memories = normalizeResults(result);
    if (memories.length >= SELF_HOSTED_DEDUP_LIMIT) {
      throw new Error(
        `Mem0 self-hosted dedup scope may exceed ${SELF_HOSTED_DEDUP_LIMIT - 1} memories.`,
      );
    }
    return [memories];
  }

  async delete(memoryId: string, opts?: { signal?: AbortSignal }): Promise<void> {
    await this.request(
      `/memories/${encodeURIComponent(memoryId)}`,
      { method: 'DELETE' },
      opts?.signal,
    );
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateProviderOptions {
  config: Mem0ExtensionConfig;
  /**
   * Resolved API key (e.g. via a security profile). Takes precedence over
   * config.apiKey, which itself may come from ${ENV} interpolation.
   */
  apiKey?: string;
}

export async function createMem0Provider(opts: CreateProviderOptions): Promise<Mem0Provider> {
  const { config } = opts;
  normalizeMem0Mode(config.mode); // throws unless "self-hosted"
  const baseUrl = config.baseUrl?.trim();
  if (!baseUrl) throw new Error('Mem0 self-hosted mode requires baseUrl.');
  const apiKey = (opts.apiKey ?? config.apiKey)?.trim() || undefined;
  return new SelfHostedProvider(baseUrl, apiKey, config.requestTimeoutMs);
}
