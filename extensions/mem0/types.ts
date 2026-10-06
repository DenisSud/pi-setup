/**
 * Configuration types for pi-memory-mem0.
 */

/** This build supports only "self-hosted" — direct REST to a deployed Mem0 OSS server. */
export type Mem0Mode = 'self-hosted';
export type Mem0MemoryMode = 'hybrid' | 'active' | 'passive';
export type Mem0RecallFrequency = 'user-input' | 'session';
export type MemoryUserIdScope = 'project' | 'exact';

export interface Mem0GateConfig {
  /** Enable the capture gate. Defaults to true when a gate baseUrl is set. */
  enabled?: boolean;
  /** OpenAI-compatible endpoint root (…/v1), e.g. http://192.168.1.20:11434/v1. */
  baseUrl?: string;
  /** Gate model. Default: "tev1:4b". */
  model?: string;
  /** Gate request timeout in milliseconds. Default: 5000. */
  timeoutMs?: number;
  /** Optional bearer token for the gate endpoint. */
  apiKey?: string;
}

export interface Mem0CaptureConfig {
  /** Flush when the buffer holds this many messages. Default: 12. */
  flushMessages?: number;
  /** Flush this long after the last append (ms). Default: 180000. */
  flushIdleMs?: number;
  /** Hard buffer cap; forces a flush, bounds process memory. Default: 64. */
  capMessages?: number;
  /** Per-message truncation before buffering. Default: 1000. */
  maxMessageChars?: number;
  /** Gate prompt excerpt cap in characters. Default: 12000. */
  maxExcerptChars?: number;
  /** The capture gate (a small decision model over Ollama). */
  gate?: Mem0GateConfig;
}

export interface Mem0ExtensionConfig {
  /** Only "self-hosted" is supported (and is the default). */
  mode?: Mem0Mode;

  /**
   * Memory behavior: "passive" = automatic capture + recall injection only,
   * "active" = LLM-callable mem0_memory tool only, "hybrid" = both.
   * Default: "hybrid".
   */
  memoryMode?: Mem0MemoryMode;

  /** Override automatic turn capture from memoryMode. */
  autoCapture?: boolean;
  /** Override automatic recall injection from memoryMode. */
  autoRecall?: boolean;
  /** Override mem0_memory tool registration from memoryMode. */
  toolEnabled?: boolean;
  /** Automatic recall cadence. Default: "user-input". */
  recallFrequency?: Mem0RecallFrequency;

  // ── Self-hosted server ──────────────────────────────────────────────────
  /** API key sent as X-API-Key. Supports ${MEM0_API_KEY}. */
  apiKey?: string;
  /**
   * Name of a `security` extension profile (security.json) providing the API
   * key through rbw. Takes precedence over apiKey.
   */
  apiKeyProfile?: string;
  /** Env var name read from the profile's resolved vars. Default: "MEM0_ADMIN_API_KEY". */
  apiKeyVar?: string;
  /** Required self-hosted Mem0 server URL. */
  baseUrl?: string;
  /** Request timeout in milliseconds. Default: 30000. */
  requestTimeoutMs?: number;

  // ── Shared ──────────────────────────────────────────────────────────────
  /** User identifier for memory scoping. Supports ${USER}. */
  userId?: string;
  /** Optional agent identifier for memory scoping. Supports environment interpolation. */
  agentId?: string;
  /** Append a cwd hash (default) or use userId verbatim. */
  userIdScope?: MemoryUserIdScope;
  /** Max results for automatic recall and mem0_memory search. Must be an integer greater than 0. Default: 5 */
  topK?: number;
  /** Minimum similarity score for automatic recall entries; entries without a score are kept. 0 disables. Default: 0.3 */
  minScore?: number;
  /** Automatic capture pipeline: buffer → gate → batch. */
  capture?: Mem0CaptureConfig;
  /** Optional decision-model relevance pass over recalled entries (default off). */
  recallFilter?: Mem0RecallFilterConfig;
}

export interface Mem0RecallFilterConfig {
  /** Enable the relevance pass over minScore survivors. Default: false. */
  enabled?: boolean;
  /** OpenAI-compatible chat endpoint. Default: capture.gate.baseUrl (same Ollama host). */
  baseUrl?: string;
  /** Decision model name. Default: "tev1:4b". */
  model?: string;
  /** Per-decision timeout in milliseconds. Default: 1500. */
  timeoutMs?: number;
}

export interface MemoryItem {
  id: string;
  memory: string;
  score?: number | undefined;
  user_id?: string | undefined;
  created_at?: string | undefined;
  updated_at?: string | undefined;
}

export interface AddResult {
  results?: Array<{ id: string; memory: string; event: string }>;
}
