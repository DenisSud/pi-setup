/**
 * asr — transcribe an audio or video file with Parakeet TDT 0.6B v3, locally.
 *
 *   asr → `pi-asr <path> [--json]` (sherpa-onnx + ONNX Runtime, CPU, offline)
 *
 * Why wrap a binary instead of a JS implementation: the model is a 640 MB
 * NeMo transducer that sherpa-onnx runs in int8 on CPU at ~27x realtime. The
 * Nix package (`nix/asr.nix`) pins the model files, ffmpeg and the VAD, so
 * the tool works with no network and no Python on the host.
 *
 * Utterances are cut at silence before decoding (the encoder attends over its
 * whole input, so a long file would be slow and memory-hungry), which also
 * gives the segment times `timestamps: true` returns.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { toolExposure } from "../../lib/exposure.ts";
import { configPath, loadConfig, type AsrConfig } from "./config.ts";

interface RunResult {
	stdout: string;
	stderr: string;
}

interface Segment {
	start: number;
	end: number;
	text: string;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** `~/x` and relative paths are resolved here: spawn does not expand `~`. */
export function resolvePath(path: string): string {
	const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
	return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

export function buildArgs(path: string, timestamps: boolean, config: AsrConfig): string[] {
	const args = [path];
	if (timestamps) args.push("--json");
	args.push("--chunk-seconds", String(config.chunkSeconds));
	return args;
}

/** Spawn the CLI, collect stdout/stderr, and translate failures into fixes. */
export function runAsr(args: string[], config: AsrConfig, signal?: AbortSignal): Promise<RunResult> {
	return new Promise((resolveRun, reject) => {
		let child;
		try {
			child = spawn(config.command, args, { stdio: ["ignore", "pipe", "pipe"], signal });
		} catch (err) {
			reject(err);
			return;
		}

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, config.timeoutMs);

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			// Keep the tail: progress arrives first, the failure reason last.
			stderr = (stderr + chunk.toString("utf8")).slice(-4000);
		});
		child.on("error", (err: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			if (err.code === "ENOENT") {
				reject(
					new Error(
						`asr: ${config.command} not found — install it with \`nix profile install ~/dev/pi-setup#asr\`, or set "command" in ${configPath()}`,
					),
				);
				return;
			}
			reject(new Error(`asr: ${config.command} failed to start: ${err.message}`));
		});
		child.on("close", (code: number | null, sig: NodeJS.Signals | null) => {
			clearTimeout(timer);
			if (timedOut) {
				reject(
					new Error(
						`asr: ${config.command} did not finish in ${config.timeoutMs} ms — raise "timeoutMs" in ${configPath()}, or transcribe a shorter cut`,
					),
				);
				return;
			}
			if (code !== 0) {
				const detail = stderr.trim().split("\n").slice(-6).join("\n");
				reject(new Error(`asr: ${config.command} exited ${code ?? sig}${detail ? `:\n${detail}` : ""}`));
				return;
			}
			resolveRun({ stdout, stderr });
		});
	});
}

async function saveArtifact(config: AsrConfig, path: string, body: string): Promise<string> {
	await mkdir(config.artifactDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const target = join(config.artifactDir, `${stamp}-${basename(path, extname(path))}.txt`);
	await writeFile(target, body, "utf8");
	return target;
}

/** The CLI's JSON mode; a parse failure means the binary is not ours. */
export function parseTranscript(stdout: string): { text: string; segments: Segment[]; duration?: number } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error(`asr: the CLI did not return JSON — check "command" in ${configPath()}`);
	}
	const value = parsed as { text?: unknown; segments?: unknown; duration?: unknown };
	if (typeof value.text !== "string") throw new Error(`asr: the CLI returned no "text" — check "command" in ${configPath()}`);
	const segments = Array.isArray(value.segments) ? (value.segments as Segment[]) : [];
	return { text: value.text, segments, duration: typeof value.duration === "number" ? value.duration : undefined };
}

export default function asrExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "transcribe",
		label: "Transcribe",
		exposure: toolExposure(),
		description:
			"Transcribe an audio or video file to text with Parakeet TDT 0.6B v3, locally on this machine. Handles anything ffmpeg reads (wav, mp3, m4a, ogg, opus, webm, mp4) and auto-detects the language across 25 European languages, including Russian and English in the same recording. Use it for voice notes, meeting recordings, interviews, podcasts or the audio track of a video instead of guessing at what was said. With `timestamps` it also returns the start and end time of each utterance.",
		promptGuidelines: [
			"Use `transcribe` for any audio or video file whose speech you need: voice notes, meeting recordings, calls, interviews. It prints the transcript with one utterance per line; pass `timestamps: true` when you need to cite what was said at a given time. When the result says the output was truncated, read the artifact path it names for the rest.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Audio or video file to transcribe (~ and relative paths are resolved)" }),
			timestamps: Type.Optional(
				Type.Boolean({ description: "Return JSON with the utterance text and its start/end times instead of plain lines" }),
			),
			max_chars: Type.Optional(
				Type.Number({ description: "Truncate the returned transcript at this many characters (default: from asr.json, 40000)" }),
			),
		}),
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			let content = theme.fg("toolTitle", theme.bold("Transcribe "));
			content += theme.fg("accent", truncate(basename(String(args.path ?? "")), 60));
			if (args.timestamps) content += theme.fg("dim", " (timestamps)");
			text.setText(content);
			return text;
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const details = result.details as
				| { chars?: number; segments?: number; duration?: number; truncated?: boolean; artifact?: string }
				| undefined;

			if (isPartial) {
				text.setText(theme.fg("warning", "Transcribing the audio…"));
				return text;
			}
			if (context.isError) {
				text.setText(theme.fg("error", result.content[0]?.type === "text" ? result.content[0].text : "asr failed"));
				return text;
			}

			let content = theme.fg("success", "✓ ") + theme.fg("toolTitle", `${details?.chars ?? 0} chars`);
			if (details?.segments) content += theme.fg("dim", `, ${details.segments} utterances`);
			if (details?.duration) content += theme.fg("dim", `, ${Math.round(details.duration / 60)} min audio`);
			if (details?.truncated) content += theme.fg("warning", ` (truncated → ${details.artifact})`);
			if (!expanded) {
				text.setText(content);
				return text;
			}
			const body = result.content[0]?.type === "text" ? result.content[0].text : "";
			text.setText(`${content}\n${body}`);
			return text;
		},
		async execute(_id, params, signal) {
			const config = loadConfig();
			const path = resolvePath(params.path);
			if (!fs.existsSync(path)) throw new Error(`asr: no such file: ${path}`);

			const timestamps = params.timestamps === true;
			const { stdout } = await runAsr(buildArgs(path, timestamps, config), config, signal);

			let body: string;
			let segments = 0;
			let duration: number | undefined;
			if (timestamps) {
				const parsed = parseTranscript(stdout);
				if (!parsed.text.trim()) throw new Error(`asr: ${path} produced no speech — is it silent or corrupt?`);
				body = JSON.stringify(parsed, null, 2);
				segments = parsed.segments.length;
				duration = parsed.duration;
			} else {
				body = stdout.trimEnd();
				if (!body) throw new Error(`asr: ${path} produced no speech — is it silent or corrupt?`);
			}

			const limit = params.max_chars ?? config.maxChars;
			if (body.length <= limit) {
				return {
					content: [{ type: "text", text: body }],
					details: { path, chars: body.length, segments, duration, truncated: false },
				};
			}

			const artifact = await saveArtifact(config, path, body);
			const head = body.slice(0, limit);
			return {
				content: [
					{
						type: "text",
						text: `${head}\n\n[truncated: ${body.length} chars total. Full transcript: ${artifact}]`,
					},
				],
				details: { path, chars: body.length, segments, duration, truncated: true, artifact },
			};
		},
	});
}
