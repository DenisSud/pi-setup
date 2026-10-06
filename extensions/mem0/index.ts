/**
 * pi-memory-mem0 — Semantic memory extension powered by Mem0.
 *
 * Backend: **self-hosted** — direct REST calls to a deployed Mem0 OSS server.
 *
 * Memory modes (config "memoryMode"):
 * - **passive**: automatic capture + recall injection only
 * - **active**: LLM-callable mem0_memory tool only
 * - **hybrid** (default): both
 *
 * autoCapture, autoRecall, and toolEnabled independently override the selected
 * mode's defaults. recallFrequency controls whether automatic recall runs for
 * every user input or only the first user input in a session.
 *
 * Capture side: user and assistant text is buffered per session (redacted,
 * truncated), flushed through a small decision-model gate and posted to Mem0
 * as one batched conversation (see capture.ts). Recalled memories are injected
 * as a custom message (delivered to the model on the user channel, never the
 * system prompt) and wrapped as untrusted data. Active side: the mem0_memory
 * tool lets the agent search, add, list, and delete memories on its own
 * initiative, under the same redaction and untrusted-data boundaries.
 *
 * Configuration via settings.json key "pi-memory-mem0" in the agent dir
 * ("${ENV_VAR}" and "${ENV_VAR:-fallback}" interpolation supported), with
 * environment fallbacks for deployments without per-agent settings:
 * MEM0_BASE_URL, MEM0_API_KEY, MEM0_GATE_BASE_URL, MEM0_GATE_MODEL. The API
 * key can come from a `security` extension profile (apiKeyProfile), so the
 * credential never touches settings.json or the environment.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadConfig as loadSecurityConfig } from '../security/config.ts';
import { resolveProfile } from '../security/rbw.ts';
import { Capture, resolveCaptureConfig, type CaptureConfig } from './capture.ts';
import { dedupProviderMemories } from './dedup.ts';
import { Prefetch } from './prefetch.ts';
import { formatRecalledMemory, redactMemoryText, scopeMemoryUserId } from './privacy.ts';
import { resolveRecallFilterConfig } from './relevance.ts';
import {
  createMem0Provider,
  type Mem0Provider,
  normalizeMem0Mode,
  normalizeMemoryMode,
} from './provider.ts';
import { createMem0MemoryTool } from './tools.ts';
import type { Mem0ExtensionConfig, Mem0RecallFrequency, MemoryUserIdScope } from './types.ts';

const SETTINGS_KEY = 'pi-memory-mem0';
const STATUS_KEY = 'mem0';
const MEMORY_TOOL_NAME = 'mem0_memory';
const SESSION_RECALL_ENTRY = 'mem0-session-recall';

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
}

function debugLog(message: string): void {
  if (process.env.DEBUG?.includes('mem0')) console.error(`[mem0] ${message}`);
}

/** Expand ${VAR} and ${VAR:-fallback} in config strings. */
function expandEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
      (_match, name: string, fallback: string | undefined) => process.env[name] ?? fallback ?? '',
    );
  }
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, expandEnv(v)]),
    );
  }
  return value;
}

/**
 * Read the "pi-memory-mem0" block from the agent settings.json, then fill
 * gaps from the environment (fleet deployments carry no per-bot settings).
 */
function loadConfig(): Mem0ExtensionConfig {
  let config: Mem0ExtensionConfig = {};
  try {
    const raw = JSON.parse(readFileSync(join(agentDir(), 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const section = raw[SETTINGS_KEY];
    if (section && typeof section === 'object' && !Array.isArray(section)) {
      config = expandEnv(section) as Mem0ExtensionConfig;
    }
  } catch {
    config = {};
  }
  if (!config.baseUrl?.trim() && process.env.MEM0_BASE_URL) {
    config.baseUrl = process.env.MEM0_BASE_URL;
  }
  if (!config.apiKey?.trim() && process.env.MEM0_API_KEY) {
    config.apiKey = process.env.MEM0_API_KEY;
  }
  const gate = (config.capture ??= {}).gate ??= {};
  if (!gate.baseUrl?.trim() && process.env.MEM0_GATE_BASE_URL) {
    gate.baseUrl = process.env.MEM0_GATE_BASE_URL;
  }
  if (!gate.model?.trim() && process.env.MEM0_GATE_MODEL) {
    gate.model = process.env.MEM0_GATE_MODEL;
  }
  const recallFilter = (config.recallFilter ??= {});
  if (!recallFilter.baseUrl?.trim() && process.env.MEM0_FILTER_BASE_URL) {
    recallFilter.baseUrl = process.env.MEM0_FILTER_BASE_URL;
  }
  if (!recallFilter.model?.trim() && process.env.MEM0_FILTER_MODEL) {
    recallFilter.model = process.env.MEM0_FILTER_MODEL;
  }
  // Deployment-level switch: an explicit env value wins over settings (used
  // to silence capture for bulk runs, e.g. a migration).
  if (process.env.MEM0_AUTO_CAPTURE === 'true' || process.env.MEM0_AUTO_CAPTURE === 'false') {
    config.autoCapture = process.env.MEM0_AUTO_CAPTURE === 'true';
  }
  return config;
}

let cachedApiKey: { profile: string; varName: string; value: string } | undefined;

/**
 * Resolve the API key through the security extension's rbw machinery
 * (security.json profile named by config.apiKeyProfile). Cached per process;
 * the value stays in memory only.
 */
async function resolveApiKey(config: Mem0ExtensionConfig): Promise<string | undefined> {
  const profile = config.apiKeyProfile?.trim();
  if (!profile) return undefined;
  const varName = config.apiKeyVar?.trim() || 'MEM0_ADMIN_API_KEY';
  if (cachedApiKey?.profile === profile && cachedApiKey.varName === varName) {
    return cachedApiKey.value;
  }
  const env = await resolveProfile(loadSecurityConfig(), profile);
  const value = env[varName]?.trim();
  if (!value) throw new Error(`Security profile "${profile}" did not provide ${varName}.`);
  cachedApiKey = { profile, varName, value };
  return value;
}

/**
 * Namespace when the config carries no userId: fleet bots get `bot:<name>`
 * from the launcher's PI_BOT_NAME; anything else falls back to the OS user.
 */
function derivedUserId(): string {
  const bot = process.env.PI_BOT_NAME?.trim();
  if (bot) return `bot:${bot}`;
  if (process.env.USER) return process.env.USER;
  if (process.env.USERNAME) return process.env.USERNAME;
  return 'default-user';
}

export default function mem0Extension(pi: ExtensionAPI): void {
  let provider: Mem0Provider | undefined;
  let prefetch: Prefetch | undefined;
  let capture: Capture | undefined;
  let captureConfig: CaptureConfig | undefined;
  let userId = '';
  let agentId: string | undefined;
  let activeMode = '';
  let activeMemoryMode = '';
  let activeAutoCapture = false;
  let activeToolEnabled = false;
  let activeRecallFrequency: Mem0RecallFrequency = 'user-input';
  let recallQueuedThisSession = false;
  let sessionEpoch = 0;
  let activeUi: { setStatus(key: string, text: string | undefined): void } | undefined;

  /** Refresh the footer indicator: "mem0: N memories" (or "unreachable"). */
  async function refreshMemoryStatus(): Promise<void> {
    const ui = activeUi;
    const activeProvider = provider;
    if (!ui || !activeProvider) return;
    try {
      const all = await activeProvider.getAll({
        userId,
        ...(agentId ? { agentId } : {}),
      });
      const n = all.length;
      ui.setStatus(STATUS_KEY, `mem0: ${n} ${n === 1 ? 'memory' : 'memories'}`);
    } catch {
      ui.setStatus(STATUS_KEY, 'mem0: unreachable');
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    // A newer session_start (or shutdown) can run while this handler is still
    // awaiting provider init. The epoch check after the await keeps the
    // superseded handler from clobbering the live session's state.
    const epoch = ++sessionEpoch;
    activeUi = ctx.ui;
    if (capture) {
      void capture.flush('session-switch');
      capture.dispose();
    }
    capture = undefined;
    captureConfig = undefined;
    provider = undefined;
    prefetch = undefined;
    agentId = undefined;
    activeAutoCapture = false;
    activeToolEnabled = false;
    activeRecallFrequency = 'user-input';
    recallQueuedThisSession = false;
    pi.setActiveTools(pi.getActiveTools().filter((name) => name !== MEMORY_TOOL_NAME));
    const config = loadConfig();
    try {
      const mode = normalizeMem0Mode(config.mode);
      const memoryMode = normalizeMemoryMode(config.memoryMode);
      const recallFrequency = config.recallFrequency ?? 'user-input';
      if (recallFrequency !== 'user-input' && recallFrequency !== 'session') {
        throw new Error(`Unsupported recall frequency: ${String(recallFrequency)}`);
      }
      const topK = config.topK ?? 5;
      if (!Number.isInteger(topK) || topK <= 0) {
        throw new Error(
          'topK must be an integer greater than 0. Use autoRecall: false to disable automatic recall.',
        );
      }
      if (
        config.minScore !== undefined &&
        (typeof config.minScore !== 'number' ||
          Number.isNaN(config.minScore) ||
          config.minScore < 0 ||
          config.minScore > 1)
      ) {
        throw new Error('minScore must be a number between 0 and 1.');
      }
      if (config.recallFilter !== undefined && typeof config.recallFilter !== 'object') {
        throw new Error('recallFilter must be an object.');
      }
      for (const key of ['autoCapture', 'autoRecall', 'toolEnabled'] as const) {
        if (config[key] !== undefined && typeof config[key] !== 'boolean') {
          throw new Error(`${key} must be a boolean.`);
        }
      }
      const resolvedAgentId = config.agentId?.trim() || undefined;
      const resolvedApiKey = await resolveApiKey(config);
      if (!resolvedApiKey && !config.apiKey?.trim()) {
        throw new Error(
          'Mem0 needs an API key: set apiKeyProfile (rbw) or apiKey / MEM0_API_KEY.',
        );
      }
      const newProvider = await createMem0Provider({
        config,
        ...(resolvedApiKey ? { apiKey: resolvedApiKey } : {}),
      });
      if (epoch !== sessionEpoch) return;
      provider = newProvider;
      userId = config.userId?.trim()
        ? scopeMemoryUserId(config.userId.trim(), ctx.cwd, config.userIdScope)
        : derivedUserId();
      agentId = resolvedAgentId;
      activeMode = mode;
      activeMemoryMode = memoryMode;
      activeAutoCapture = config.autoCapture ?? memoryMode !== 'active';
      const autoRecall = config.autoRecall ?? memoryMode !== 'active';
      activeToolEnabled = config.toolEnabled ?? memoryMode !== 'passive';
      activeRecallFrequency = recallFrequency;
      const sessionId = ctx.sessionManager.getSessionId();
      recallQueuedThisSession = ctx.sessionManager
        .getEntries()
        .some(
          (entry) =>
            entry.type === 'custom' &&
            entry.customType === SESSION_RECALL_ENTRY &&
            entry.data === sessionId,
        );
      if (autoRecall) {
        // Recall relevance: vector-search minScore floor, then an optional
        // decision-model relevance pass (same endpoint as the capture gate by
        // default). Both fail toward keeping entries.
        const recallFilter = resolveRecallFilterConfig(
          config.recallFilter,
          config.capture?.gate?.baseUrl,
        );
        prefetch = new Prefetch(provider, userId, {
          ...(agentId ? { agentId } : {}),
          topK,
          minScore: config.minScore,
          ...(recallFilter.enabled && recallFilter.baseUrl ? { recallFilter } : {}),
          // Read at consume time; the capture buffer holds redacted user turns.
          contextTurns: () => capture?.recentUserTexts(2) ?? [],
        });
      }
      if (activeAutoCapture) {
        captureConfig = resolveCaptureConfig(config.capture);
        capture = new Capture({
          provider,
          userId,
          ...(agentId ? { agentId } : {}),
          config: captureConfig,
          log: debugLog,
        });
      }
      if (activeToolEnabled) {
        pi.registerTool(
          createMem0MemoryTool({
            getProvider: () => provider,
            getUserId: () => userId,
            getAgentId: () => agentId,
            isEnabled: () => activeToolEnabled,
            topK,
            onMemoryChanged: () => {
              void refreshMemoryStatus();
            },
          }),
        );
        pi.setActiveTools([
          ...pi.getActiveTools().filter((name) => name !== MEMORY_TOOL_NAME),
          MEMORY_TOOL_NAME,
        ]);
      }
    } catch (err) {
      if (epoch !== sessionEpoch) return;
      provider = undefined;
      prefetch = undefined;
      capture = undefined;
      captureConfig = undefined;
      activeToolEnabled = false;
      ctx.ui.setStatus(STATUS_KEY, 'mem0: init failed');
      ctx.ui.notify(
        `Mem0 init failed: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, 'mem0: on');
    void refreshMemoryStatus();
  });

  pi.on('input', async (event, ctx) => {
    const text = event.text ?? '';
    if (!text.trim()) return;

    capture?.append('user', text);

    if (!prefetch) return;

    if (activeRecallFrequency === 'session' && recallQueuedThisSession) {
      return;
    }

    prefetch.queue(redactMemoryText(text));

    if (activeRecallFrequency === 'session') {
      recallQueuedThisSession = true;
      pi.appendEntry(SESSION_RECALL_ENTRY, ctx.sessionManager.getSessionId());
    }
  });

  pi.on('turn_end', async (event) => {
    if (!capture) return;
    const msg = event.message as { role?: string; content?: unknown };
    if (msg.role !== 'assistant') return;
    const text = extractText(msg);
    if (text) capture.append('assistant', text);
  });

  pi.on('before_agent_start', async () => {
    if (!prefetch) return;

    const recalled = await prefetch.consume();
    if (!recalled) return;

    return {
      message: {
        customType: 'mem0-recall',
        content: recalled,
        display: true,
      },
    };
  });

  pi.on('session_shutdown', async () => {
    sessionEpoch++;
    const activeCapture = capture;
    capture = undefined;
    if (activeCapture) {
      await activeCapture.flush('shutdown');
      activeCapture.dispose();
    }
    captureConfig = undefined;
    activeUi = undefined;
    provider = undefined;
    prefetch = undefined;
    agentId = undefined;
    activeAutoCapture = false;
    activeToolEnabled = false;
    activeRecallFrequency = 'user-input';
    recallQueuedThisSession = false;
  });

  pi.registerCommand('mem0', {
    description:
      'Mem0 memory commands. Subcommands: status, search <query>, profile, add <text>, dedup [--apply], delete <id>.',
    handler: async (args, ctx) => {
      if (!provider) {
        ctx.ui.notify('Mem0 is not active.', 'warning');
        return;
      }
      const scope = { userId, ...(agentId ? { agentId } : {}) };

      const parts = args.trim().split(/\s+/).filter(Boolean);
      const subcommand = parts[0]?.toLowerCase() ?? 'status';
      const rest = parts.slice(1).join(' ').trim();

      switch (subcommand) {
        case 'status': {
          const captureState = activeAutoCapture
            ? `on (buffered ${capture?.size() ?? 0})`
            : 'off';
          const gateState =
            captureConfig && captureConfig.gate.enabled
              ? `on (${captureConfig.gate.model})`
              : 'off';
          ctx.ui.notify(
            `Mem0: active (backend: ${activeMode}, preset: ${activeMemoryMode}, capture: ${captureState}, gate: ${gateState}, recall: ${prefetch ? 'on' : 'off'}, tool: ${activeToolEnabled ? 'on' : 'off'}, recall frequency: ${prefetch ? activeRecallFrequency : 'disabled'})`,
            'info',
          );
          break;
        }
        case 'search': {
          if (!rest) {
            ctx.ui.notify('Usage: /mem0 search <query>', 'warning');
            break;
          }
          const results = await provider.search(rest, {
            ...scope,
            topK: 10,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          if (results.length === 0) {
            ctx.ui.notify('No relevant memories found.', 'info');
          } else {
            const lines = results.map((r, i) => `${i + 1}. ${formatRecalledMemory(r.memory)}`);
            ctx.ui.notify(`Mem0 search results:\n${lines.join('\n')}`, 'info');
          }
          break;
        }
        case 'profile': {
          const all = await provider.getAll({
            ...scope,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          if (all.length === 0) {
            ctx.ui.notify('No memories stored yet.', 'info');
          } else {
            const lines = all.map((m, i) => `${i + 1}. ${formatRecalledMemory(m.memory)}`);
            ctx.ui.notify(`Mem0 memories (${all.length}):\n${lines.join('\n')}`, 'info');
          }
          break;
        }
        case 'add': {
          if (!rest) {
            ctx.ui.notify('Usage: /mem0 add <text>', 'warning');
            break;
          }
          const result = await provider.add([{ role: 'user', content: redactMemoryText(rest) }], {
            ...scope,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          const created = result?.results ?? [];
          if (created.length === 0) {
            ctx.ui.notify('No memory was extracted from the provided text.', 'info');
          } else {
            const lines = created.map((m, i) => `${i + 1}. ${formatRecalledMemory(m.memory)}`);
            ctx.ui.notify(`Mem0 saved ${created.length}:\n${lines.join('\n')}`, 'info');
          }
          void refreshMemoryStatus();
          break;
        }
        case 'dedup': {
          if (rest && rest !== '--apply') {
            ctx.ui.notify('Usage: /mem0 dedup [--apply]', 'warning');
            break;
          }
          if (rest !== '--apply') {
            const preview = await dedupProviderMemories(provider, {
              ...scope,
              dryRun: true,
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            });
            if (preview.duplicatesFound === 0) {
              ctx.ui.notify(
                `Mem0 dedup preview: scanned ${preview.total} memories; no exact duplicates found.`,
                'info',
              );
              break;
            }
            const noun = preview.duplicatesFound === 1 ? 'duplicate' : 'duplicates';
            const pronoun = preview.duplicatesFound === 1 ? 'it' : 'them';
            ctx.ui.notify(
              `Mem0 dedup preview: scanned ${preview.total} memories and found ${preview.duplicatesFound} exact ${noun}. Run /mem0 dedup --apply to remove ${pronoun}.`,
              'info',
            );
            break;
          }
          if (!ctx.hasUI) {
            ctx.ui.notify('Mem0 dedup --apply requires an interactive confirmation.', 'warning');
            break;
          }
          let preview: Awaited<ReturnType<typeof dedupProviderMemories>> | undefined;
          let approved = false;
          const result = await dedupProviderMemories(provider, {
            ...scope,
            dryRun: false,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            approve: async (candidate) => {
              preview = candidate;
              if (candidate.duplicatesFound === 0) return false;
              const noun = candidate.duplicatesFound === 1 ? 'duplicate' : 'duplicates';
              approved = await ctx.ui.confirm(
                'Remove exact duplicate memories?',
                `${candidate.duplicatesFound} ${noun} will be permanently deleted.`,
              );
              return approved;
            },
          });
          if (preview?.duplicatesFound === 0) {
            ctx.ui.notify('Mem0 dedup complete: no exact duplicates found.', 'info');
            break;
          }
          if (!approved) {
            ctx.ui.notify('Mem0 dedup cancelled.', 'info');
            break;
          }
          const removedNoun = result.duplicatesRemoved === 1 ? 'duplicate' : 'duplicates';
          ctx.ui.notify(
            `Mem0 dedup complete: removed ${result.duplicatesRemoved} ${removedNoun}; ${result.deleteFailures} deletions failed.`,
            result.deleteFailures ? 'warning' : 'info',
          );
          void refreshMemoryStatus();
          break;
        }
        case 'delete': {
          if (!rest) {
            ctx.ui.notify('Usage: /mem0 delete <memory-id>', 'warning');
            break;
          }
          await provider.delete(rest, ctx.signal ? { signal: ctx.signal } : {});
          ctx.ui.notify(`Deleted memory ${rest}.`, 'info');
          void refreshMemoryStatus();
          break;
        }
        default:
          ctx.ui.notify(
            'Unknown subcommand. Available: status, search, profile, add, dedup, delete.',
            'warning',
          );
      }
    },
  });
}

function extractText(msg: { content?: unknown }): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return (msg.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!)
      .join('\n');
  }
  return '';
}
