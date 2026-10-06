/**
 * Two-phase semantic prefetch — kicks off a background search on input,
 * consumes the result on before_agent_start with a timeout.
 */

import { truncateHead, truncateLine } from '@earendil-works/pi-coding-agent';
import { formatRecalledMemory } from './privacy.ts';
import type { RecallFilterConfig } from './relevance.ts';
import { filterRelevantEntries } from './relevance.ts';
import type { Mem0Provider } from './provider.ts';
import type { MemoryItem } from './types.ts';

/** Recalled entries land in per-turn model context — keep the block small. */
const MAX_ENTRY_CHARS = 1_000;
const MAX_BLOCK_BYTES = 8 * 1024;
const MAX_BLOCK_LINES = 50;

export interface PrefetchOptions {
  agentId?: string;
  topK: number;
  /** Minimum similarity score; entries without a score are kept. Undefined disables. */
  minScore?: number;
  /** Optional decision-model relevance pass over the minScore survivors. */
  recallFilter?: RecallFilterConfig;
  /** Prior user turns for the relevance pass (called at consume time). */
  contextTurns?: () => string[];
}

export class Prefetch {
  private readonly provider: Mem0Provider;
  private readonly userId: string;
  private readonly agentId: string | undefined;
  private readonly topK: number;
  private readonly minScore: number | undefined;
  private readonly recallFilter: RecallFilterConfig | undefined;
  private readonly contextTurns: (() => string[]) | undefined;
  private pending: Promise<MemoryItem[]> | null = null;
  private pendingQuery = '';

  constructor(provider: Mem0Provider, userId: string, opts: PrefetchOptions) {
    this.provider = provider;
    this.userId = userId;
    this.agentId = opts.agentId;
    this.topK = opts.topK;
    this.minScore = opts.minScore;
    this.recallFilter = opts.recallFilter;
    this.contextTurns = opts.contextTurns;
  }

  /** Phase 1: kick off a background search (called on input with user text). */
  queue(query: string): void {
    if (!query.trim()) return;
    this.pendingQuery = query;
    const search = this.provider.search(query, {
      userId: this.userId,
      ...(this.agentId ? { agentId: this.agentId } : {}),
      topK: this.topK,
    });
    // A replaced or never-consumed search must not surface as an unhandled rejection.
    search.catch(() => {});
    this.pending = search;
  }

  /** Phase 2: consume the result with a timeout (called on before_agent_start). */
  async consume(timeoutMs = 3000): Promise<string> {
    if (!this.pending) return '';

    const promise = this.pending;
    this.pending = null;

    try {
      const memories = await Promise.race([
        promise,
        new Promise<MemoryItem[]>((resolve) => setTimeout(() => resolve([]), timeoutMs)),
      ]);

      if (memories.length === 0) return '';

      const filtered = this.minScore
        ? memories.filter((m) => m.score === undefined || m.score >= this.minScore!)
        : memories;
      const relevant = this.recallFilter
        ? await this.applyRecallFilter(filtered)
        : filtered;
      const lines = relevant
        .filter((m) => m.memory?.trim())
        .map((m) => {
          const date = (m.updated_at ?? m.created_at)?.slice(0, 10);
          return `- ${date ? `(${date}) ` : ''}${formatRecalledMemory(truncateLine(m.memory.trim(), MAX_ENTRY_CHARS).text)}`;
        });

      if (lines.length === 0) return '';
      return truncateHead(`## Recalled Memories (Mem0)\n${lines.join('\n')}`, {
        maxBytes: MAX_BLOCK_BYTES,
        maxLines: MAX_BLOCK_LINES,
      }).content;
    } catch {
      return '';
    }
  }

  /** Relevance pass over MemoryItems; unusable decisions keep their entry. */
  private async applyRecallFilter(entries: MemoryItem[]): Promise<MemoryItem[]> {
    const recallFilter = this.recallFilter;
    if (!recallFilter) return entries;
    const candidates = entries.map((entry) => ({ id: entry.id, text: entry.memory ?? '' }));
    const kept = await filterRelevantEntries(
      candidates,
      this.pendingQuery,
      this.contextTurns?.() ?? [],
      recallFilter,
    );
    const keptIds = new Set(kept.map((candidate) => candidate.id));
    return entries.filter((entry) => keptIds.has(entry.id));
  }
}
