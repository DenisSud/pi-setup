/**
 * security/redact — remove secret values from anything flowing back to
 * the model.
 *
 * Design rules (all load-bearing):
 *  - Match full values only, never fragments; values shorter than
 *    MIN_SECRET_LENGTH are not registered at all (mangling unrelated
 *    text is worse than a weak secret).
 *  - One combined regex, longest value first, so the longest encoding of
 *    a value always wins and replaced text is never rescanned (markers
 *    contain no secret material).
 *  - Common encodings of each value are registered too, so trivial
 *    `base64`/`xxd`/URL-encoding of a secret is caught as well.
 *  - Marker is stable and self-describing: «redacted:ENV_NAME».
 */

/** Values shorter than this are not registered (too likely to match unrelated text). */
export const MIN_SECRET_LENGTH = 8;

/** Marker inserted in place of a secret value. */
export function placeholder(name: string): string {
	return `«redacted:${name}»`;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The value plus the encodings an agent realistically reaches for. */
export function encodings(value: string): string[] {
	const b64 = Buffer.from(value, "utf8").toString("base64");
	return [
		value,
		b64,
		b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), // base64url
		Buffer.from(value, "utf8").toString("hex"),
		encodeURIComponent(value),
		JSON.stringify(value).slice(1, -1), // JSON-escaped content
	];
}

export class Redactor {
	#map = new Map<string, string>(); // encoded value -> env name
	#pattern: RegExp | null = null;

	add(name: string, value: string): void {
		if (!value || value.length < MIN_SECRET_LENGTH) return;
		for (const variant of encodings(value)) {
			if (variant.length >= MIN_SECRET_LENGTH && !this.#map.has(variant)) this.#map.set(variant, name);
		}
		this.#pattern = null;
	}

	addEnv(env: Record<string, string>): void {
		for (const [name, value] of Object.entries(env)) this.add(name, value);
	}

	get size(): number {
		return this.#map.size;
	}

	/** Replace every registered value (or encoding) with its marker. */
	redact(text: string): string {
		if (!text || this.#map.size === 0) return text;
		if (!this.#pattern) {
			const values = [...this.#map.keys()].sort((a, b) => b.length - a.length);
			this.#pattern = new RegExp(values.map(escapeRegExp).join("|"), "g");
		}
		return text.replace(this.#pattern, (match) => placeholder(this.#map.get(match) ?? "secret"));
	}
}

/**
 * Walk a provider payload and redact every string in place. Used as the
 * last net before a request leaves the machine.
 */
export function redactDeep(value: unknown, redactor: Redactor, seen = new WeakSet<object>()): void {
	if (typeof value === "string") return; // handled by caller (strings can't be mutated in place)
	if (!value || typeof value !== "object") return;
	if (seen.has(value)) return;
	seen.add(value);
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const item = value[i];
			if (typeof item === "string") value[i] = redactor.redact(item);
			else redactDeep(item, redactor, seen);
		}
		return;
	}
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (typeof item === "string") {
			(value as Record<string, unknown>)[key] = redactor.redact(item);
		} else {
			redactDeep(item, redactor, seen);
		}
	}
}
