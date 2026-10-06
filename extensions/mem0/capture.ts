/**
 * Capture pipeline — buffered, gated, batched automatic memory capture.
 *
 * Turns are appended to an in-memory buffer (redacted and truncated on the
 * way in). A flush sends the whole buffer through a gate — a small decision
 * model that answers "worth remembering?" — and, when the answer is yes (or
 * the gate fails), posts the batch to mem0 as one conversation. One gate call
 * and one add call per flush, never per turn.
 *
 * The gate errs permissive: timeout, HTTP error or unparseable output all
 * count as "yes". A batch that mem0 cannot store is dropped with a log line;
 * capture never blocks a turn.
 */

import { redactMemoryText } from './privacy.ts';
import type { Mem0Provider } from './provider.ts';

export interface CaptureGateConfig {
  enabled: boolean;
  baseUrl?: string;
  model: string;
  timeoutMs: number;
  apiKey?: string;
}

export interface CaptureConfig {
  flushMessages: number;
  flushIdleMs: number;
  capMessages: number;
  maxMessageChars: number;
  maxExcerptChars: number;
  gate: CaptureGateConfig;
}

export interface CaptureConfigInput {
  flushMessages?: number;
  flushIdleMs?: number;
  capMessages?: number;
  maxMessageChars?: number;
  maxExcerptChars?: number;
  gate?: {
    enabled?: boolean;
    baseUrl?: string;
    model?: string;
    timeoutMs?: number;
    apiKey?: string;
  };
}

const DEFAULTS = {
  flushMessages: 12,
  flushIdleMs: 180_000,
  capMessages: 64,
  maxMessageChars: 1_000,
  maxExcerptChars: 12_000,
  gate: { model: 'tev1:4b', timeoutMs: 5_000 },
} as const;

const GATE_DECISION_THRESHOLD = 0.5;

/** The gate as one noul decision over the batch excerpt. */
const GATE_QUESTION = {
  type: 'noul',
  instructions:
    'Does this conversation excerpt contain durable information worth remembering: ' +
    'facts about the user, their preferences, environment, projects, decisions, ' +
    'corrections, or lasting context? Routine task chatter, tool status, ' +
    'greetings, acknowledgments, and ephemeral details are NOT durable.',
  criteria: {
    true: 'The excerpt contains durable information worth remembering.',
    false: 'The excerpt contains only routine or ephemeral content.',
  },
} as const;

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`capture.${name} must be a positive integer.`);
  }
  return resolved;
}

/** Resolve capture config with defaults; throws on invalid values. */
export function resolveCaptureConfig(input: CaptureConfigInput | undefined): CaptureConfig {
  const gate = input?.gate ?? {};
  const baseUrl = gate.baseUrl?.trim() || undefined;
  return {
    flushMessages: positiveInt(input?.flushMessages, DEFAULTS.flushMessages, 'flushMessages'),
    flushIdleMs: positiveInt(input?.flushIdleMs, DEFAULTS.flushIdleMs, 'flushIdleMs'),
    capMessages: positiveInt(input?.capMessages, DEFAULTS.capMessages, 'capMessages'),
    maxMessageChars: positiveInt(input?.maxMessageChars, DEFAULTS.maxMessageChars, 'maxMessageChars'),
    maxExcerptChars: positiveInt(input?.maxExcerptChars, DEFAULTS.maxExcerptChars, 'maxExcerptChars'),
    gate: {
      enabled: gate.enabled ?? Boolean(baseUrl),
      ...(baseUrl ? { baseUrl } : {}),
      model: gate.model?.trim() || DEFAULTS.gate.model,
      timeoutMs: positiveInt(gate.timeoutMs, DEFAULTS.gate.timeoutMs, 'gate.timeoutMs'),
      ...(gate.apiKey?.trim() ? { apiKey: gate.apiKey.trim() } : {}),
    },
  };
}

/** Parse the gate's systemone answer. `undefined` means the answer was not usable. */
export function parseGateAnswer(data: unknown): boolean | undefined {
  const noul = (data as { answers?: { remember?: { noul?: unknown } } })?.answers?.remember?.noul;
  if (typeof noul !== 'number' || Number.isNaN(noul)) return undefined;
  return noul >= GATE_DECISION_THRESHOLD;
}

interface CaptureMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CaptureOptions {
  provider: Mem0Provider;
  userId: string;
  agentId?: string;
  config: CaptureConfig;
  log?: (message: string) => void;
}

/**
 * Buffered capture for one session. `append` is cheap and never throws;
 * delivery runs on a serialized chain so flushes cannot interleave.
 */
export class Capture {
  private readonly provider: Mem0Provider;
  private readonly userId: string;
  private readonly agentId: string | undefined;
  private readonly config: CaptureConfig;
  private readonly log: (message: string) => void;
  private buffer: CaptureMessage[] = [];
  private idleTimer: NodeJS.Timeout | undefined;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(opts: CaptureOptions) {
    this.provider = opts.provider;
    this.userId = opts.userId;
    this.agentId = opts.agentId;
    this.config = opts.config;
    this.log = opts.log ?? (() => {});
  }

  /** Append a message; flushes when the size or cap threshold is reached. */
  append(role: 'user' | 'assistant', text: string): void {
    if (this.disposed) return;
    const content = redactMemoryText(text.trim()).slice(0, this.config.maxMessageChars);
    if (!content) return;
    this.buffer.push({ role, content });
    this.scheduleIdleFlush();
    if (this.buffer.length >= this.config.capMessages) {
      void this.flush('cap');
    } else if (this.buffer.length >= this.config.flushMessages) {
      void this.flush('size');
    }
  }

  /** Last `n` user messages still buffered (redacted, truncated) — recall-filter context. */
  recentUserTexts(n: number): string[] {
    return this.buffer.filter((m) => m.role === 'user').slice(-n).map((m) => m.content);
  }

  /** Send the current buffer; resolves when this flush's delivery completes. */
  flush(reason: string): Promise<void> {
    if (this.buffer.length === 0) return this.chain;
    const batch = this.buffer;
    this.buffer = [];
    this.clearIdleTimer();
    this.chain = this.chain
      .catch(() => {})
      .then(() => this.deliver(batch, reason));
    return this.chain;
  }

  /** Buffered message count (for status reporting). */
  size(): number {
    return this.buffer.length;
  }

  /** Stop accepting messages and clear timers. Flush first for a clean end. */
  dispose(): void {
    this.disposed = true;
    this.clearIdleTimer();
  }

  /** Await in-flight delivery (used by session shutdown). */
  async drain(): Promise<void> {
    await this.chain;
  }

  private scheduleIdleFlush(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.flush('idle');
    }, this.config.flushIdleMs);
    // Never keep the process alive just for a pending flush.
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private async deliver(batch: CaptureMessage[], reason: string): Promise<void> {
    try {
      const keep = await this.gate(batch);
      if (!keep) {
        this.log(`capture: gate skipped ${batch.length} messages (${reason})`);
        return;
      }
      await this.provider.add(
        batch.map((message) => ({ role: message.role, content: message.content })),
        {
          userId: this.userId,
          ...(this.agentId ? { agentId: this.agentId } : {}),
        },
      );
      this.log(`capture: stored ${batch.length} messages (${reason})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[mem0] capture failed (${reason}): ${message}`);
    }
  }

  /** One decision call over the batch; failure means "capture" (fail-open). */
  private async gate(batch: CaptureMessage[]): Promise<boolean> {
    const gate = this.config.gate;
    if (!gate.enabled || !gate.baseUrl) return true;
    const excerpt = batch
      .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
      .join('\n')
      .slice(0, this.config.maxExcerptChars);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (gate.apiKey) headers.Authorization = `Bearer ${gate.apiKey}`;
      // Decision models speak Ollama's /v1/systemone (Jev-style) endpoint;
      // Ollama builds the model's prompt from state + questions.
      const response = await fetch(`${gate.baseUrl.replace(/\/$/, '')}/systemone`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(gate.timeoutMs),
        body: JSON.stringify({
          model: gate.model,
          state: excerpt,
          questions: { remember: GATE_QUESTION },
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const answer = parseGateAnswer(await response.json());
      if (answer === undefined) {
        this.log('capture: gate answer unparseable, capturing');
        return true;
      }
      return answer;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`capture: gate failed (${message}), capturing`);
      return true;
    }
  }
}
