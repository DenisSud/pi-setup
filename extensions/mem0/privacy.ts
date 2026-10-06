import { createHash } from 'node:crypto';
import path from 'node:path';
import type { MemoryUserIdScope } from './types.ts';

/**
 * Prompt-injection heuristics for memory text that flows back into model
 * context. A conservative subset of pi-shared's strict patterns: clear
 * instruction overrides, prompt exfiltration, chat-template markers.
 */
const THREAT_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    'instruction-override',
    /\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|messages?)/i,
  ],
  ['instruction-injection', /\b(new|updated|revised)\s+instructions?\s*[:.]/i],
  [
    'prompt-exfiltration',
    /\b(reveal|print|repeat|show|dump)\s+(me\s+)?(your|the)\s+(system\s+prompt|hidden\s+(instructions?|rules?)|developer\s+message)/i,
  ],
  [
    'chat-template-marker',
    /<\|im_(start|end)\|>|\[INST\]|\[\/INST\]|<\/?(system|tool_call|function_call)>/i,
  ],
];

function scanForThreats(text: string): string[] {
  return THREAT_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

export function scopeMemoryUserId(
  baseUserId: string,
  cwd: string,
  scope: MemoryUserIdScope = 'project',
): string {
  if (scope === 'exact') return baseUserId;
  const project = createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 12);
  return `${baseUserId}:project:${project}`;
}

export function redactMemoryText(text: string): string {
  return text
    .replace(
      /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi,
      '[REDACTED]',
    )
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [REDACTED]')
    .replace(
      /\b(api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^\s"',;]{6,}/gi,
      '$1=[REDACTED]',
    );
}

export function formatRecalledMemory(text: string): string {
  const findings = scanForThreats(text);
  if (findings.length > 0) {
    return `[BLOCKED UNTRUSTED MEMORY: ${findings.join(', ')}]`;
  }
  return `[UNTRUSTED MEMORY DATA] ${JSON.stringify(text)}`;
}
