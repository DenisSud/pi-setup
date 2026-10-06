/**
 * Recall relevance filter — an optional decision-model pass over the
 * minScore survivors of the vector-search recall.
 *
 * One POST to the decision model's /v1/systemone endpoint (Ollama 0.35+,
 * Jev-style typed API): the state carries the current message, prior user
 * turns and the candidate memories; each candidate gets its own `noul`
 * question answered with the probability that it is relevant. A candidate
 * is kept at noul >= 0.5. Like the capture gate, the filter fails open:
 * timeout, HTTP error, or a missing/unusable answer all keep the entry,
 * so a misbehaving or cold filter never silently starves recall.
 */

const DEFAULTS = {
  model: 'tev1:4b',
  timeoutMs: 1_500,
  maxContextTurns: 2,
  maxQueryChars: 2_000,
  maxTurnChars: 1_000,
  maxEntryChars: 2_000,
  keepThreshold: 0.5,
} as const;

const CRITERIA = {
  true: 'The memory contains information useful as context for the current message.',
  false: 'The memory is unrelated to the current message.',
} as const;

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`recallFilter.${name} must be a positive integer.`);
  }
  return resolved;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

export interface RecallFilterConfig {
  enabled: boolean;
  baseUrl?: string;
  model: string;
  timeoutMs: number;
  maxContextTurns: number;
}

export interface RecallFilterInput {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxContextTurns?: number;
}

/** Resolve recall-filter config; `gateBaseUrl` is the capture gate's endpoint fallback. */
export function resolveRecallFilterConfig(
  input: RecallFilterInput | undefined,
  gateBaseUrl: string | undefined,
): RecallFilterConfig {
  const enabled = input?.enabled ?? false;
  const baseUrl = input?.baseUrl?.trim() || gateBaseUrl?.trim() || undefined;
  return {
    enabled,
    ...(baseUrl ? { baseUrl } : {}),
    model: input?.model?.trim() || DEFAULTS.model,
    timeoutMs: positiveInt(input?.timeoutMs, DEFAULTS.timeoutMs, 'timeoutMs'),
    maxContextTurns: positiveInt(input?.maxContextTurns, DEFAULTS.maxContextTurns, 'maxContextTurns'),
  };
}

export interface RelevanceCandidate {
  id?: string;
  text: string;
}

/** Parse a systemone response into per-question keep decisions (missing → undefined). */
export function parseRelevanceAnswers(data: unknown): Record<string, boolean | undefined> {
  const answers = (data as { answers?: Record<string, { noul?: unknown }> })?.answers;
  if (!answers || typeof answers !== 'object') return {};
  const out: Record<string, boolean | undefined> = {};
  for (const [key, answer] of Object.entries(answers)) {
    const noul = (answer as { noul?: unknown } | undefined)?.noul;
    out[key] = typeof noul === 'number' && !Number.isNaN(noul) ? noul >= DEFAULTS.keepThreshold : undefined;
  }
  return out;
}

/**
 * Keep the candidates the decision model marks relevant. Runs only with an
 * enabled config and a baseUrl; every unusable decision keeps its entry.
 */
export async function filterRelevantEntries(
  candidates: RelevanceCandidate[],
  query: string,
  contextTurns: string[],
  config: RecallFilterConfig,
): Promise<RelevanceCandidate[]> {
  if (!config.enabled || !config.baseUrl || candidates.length === 0) return candidates;

  const names = candidates.map((_, i) => `memory_${i}`);
  const state = {
    current_message: truncate(query, DEFAULTS.maxQueryChars),
    prior_user_messages: contextTurns
      .slice(0, config.maxContextTurns)
      .map((text) => truncate(text, DEFAULTS.maxTurnChars)),
    memories: Object.fromEntries(
      candidates.map((candidate, i) => [names[i], truncate(candidate.text, DEFAULTS.maxEntryChars)]),
    ),
  };
  const questions = Object.fromEntries(
    names.map((name) => [
      name,
      {
        type: 'noul',
        instructions: `Is memory ${name} relevant to the user's current message?`,
        criteria: CRITERIA,
      },
    ]),
  );

  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/systemone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(config.timeoutMs),
      body: JSON.stringify({ model: config.model, state, questions }),
    });
    if (!response.ok) return candidates;
    const decisions = parseRelevanceAnswers(await response.json());
    return candidates.filter((_, i) => decisions[names[i]!] !== false);
  } catch {
    return candidates;
  }
}
