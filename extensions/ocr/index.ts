/**
 * ocr — read a PDF or image with Indra OCR, locally.
 *
 *   ocr → `indra-ocr <path> --format md` (ONNX Runtime, CPU, no network once
 *         the ~76 MB of models are cached by the first run)
 *
 * Why wrap a binary instead of a JS implementation: Indra is a small ONNX
 * graph (det 0.4 MB, rec 5 MB) surrounded by ~5k lines of OpenCV post-
 * processing, PDF text-layer handling and n-gram rescoring. The Nix package
 * (`nix/indra-ocr.nix`) runs that pipeline natively on every device; a port
 * would be a second implementation to keep honest.
 *
 * The tool returns markdown (headings, lists, tables, reading order) unless
 * asked for text or json. Long documents are truncated to `maxChars` and the
 * full output is written to the artifact directory the result names.
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
import { configPath, loadConfig, type OcrConfig } from "./config.ts";

type Format = "md" | "text" | "json";
type Mode = "auto" | "ocr" | "text";

interface RunResult {
	stdout: string;
	stderr: string;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** `~/x` and relative paths are resolved here: spawn does not expand `~`. */
export function resolvePath(path: string): string {
	const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
	return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

export function buildArgs(path: string, format: Format, mode?: Mode, maxPages?: number): string[] {
	const args = [path, "--format", format];
	if (mode) args.push("--mode", mode);
	if (maxPages !== undefined) args.push("--max-pages", String(maxPages));
	return args;
}

/** Spawn the CLI, collect stdout/stderr, and translate failures into fixes. */
export function runOcr(
	args: string[],
	config: OcrConfig,
	signal?: AbortSignal,
): Promise<RunResult> {
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
			// Keep the tail: warnings arrive first, the failure reason last.
			stderr = (stderr + chunk.toString("utf8")).slice(-4000);
		});
		child.on("error", (err: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			if (err.code === "ENOENT") {
				reject(
					new Error(
						`ocr: ${config.command} not found — install it with \`nix profile install ~/dev/pi-setup#indra-ocr\`, or set "command" in ${configPath()}`,
					),
				);
				return;
			}
			reject(new Error(`ocr: ${config.command} failed to start: ${err.message}`));
		});
		child.on("close", (code: number | null, sig: NodeJS.Signals | null) => {
			clearTimeout(timer);
			if (timedOut) {
				reject(
					new Error(
						`ocr: ${config.command} did not finish in ${config.timeoutMs} ms — raise "timeoutMs" in ${configPath()} or pass max_pages`,
					),
				);
				return;
			}
			if (code !== 0) {
				const detail = stderr.trim().split("\n").slice(-6).join("\n");
				reject(new Error(`ocr: ${config.command} exited ${code ?? sig}${detail ? `:\n${detail}` : ""}`));
				return;
			}
			resolveRun({ stdout, stderr });
		});
	});
}

async function saveArtifact(config: OcrConfig, path: string, format: Format, body: string): Promise<string> {
	await mkdir(config.artifactDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const ext = format === "json" ? "json" : format === "text" ? "txt" : "md";
	const target = join(config.artifactDir, `${stamp}-${basename(path, extname(path))}.${ext}`);
	await writeFile(target, body, "utf8");
	return target;
}

export default function ocrExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ocr",
		label: "OCR",
		exposure: toolExposure(),
		description:
			"Extract text from a PDF or image with Indra OCR, locally on this machine. Returns markdown by default — headings, lists, tables and reading order — and handles 80+ languages, handwriting, rotated or tilted scans and dark backgrounds. For digital PDFs it reads the existing text layer and only OCRs the pages that need it. Use it to read scanned documents, photos of pages, receipts or screenshots instead of guessing at their content.",
		promptGuidelines: [
			"Use `ocr` for any file whose text you cannot read with the `read` tool: scanned PDFs, photos of documents, screenshots of text. It prints markdown; when the result says the output was truncated, read the artifact path it names for the rest.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "PDF or image file to read (~ and relative paths are resolved)" }),
			format: Type.Optional(
				Type.Union([Type.Literal("md"), Type.Literal("text"), Type.Literal("json")], {
					description: "md (default): markdown with layout; text: plain lines; json: lines, boxes, blocks, confidences",
				}),
			),
			mode: Type.Optional(
				Type.Union([Type.Literal("auto"), Type.Literal("ocr"), Type.Literal("text")], {
					description: "auto (default) reads the text layer where it passes checks; ocr never trusts it; text always uses it",
				}),
			),
			max_pages: Type.Optional(Type.Number({ description: "Read at most this many pages" })),
			max_chars: Type.Optional(
				Type.Number({ description: "Truncate the returned text at this many characters (default: from ocr.json, 20000)" }),
			),
		}),
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			let content = theme.fg("toolTitle", theme.bold("OCR "));
			content += theme.fg("accent", truncate(basename(String(args.path ?? "")), 60));
			if (args.format && args.format !== "md") content += theme.fg("dim", ` (${args.format})`);
			if (args.max_pages !== undefined) content += theme.fg("dim", ` max ${args.max_pages}p`);
			text.setText(content);
			return text;
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const details = result.details as { chars?: number; truncated?: boolean; artifact?: string } | undefined;

			if (isPartial) {
				text.setText(theme.fg("warning", "Reading the document…"));
				return text;
			}
			if (context.isError) {
				text.setText(theme.fg("error", result.content[0]?.type === "text" ? result.content[0].text : "ocr failed"));
				return text;
			}

			let content = theme.fg("success", "✓ ") + theme.fg("toolTitle", `${details?.chars ?? 0} chars`);
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
			if (!fs.existsSync(path)) throw new Error(`ocr: no such file: ${path}`);

			const format: Format = params.format ?? "md";
			const { stdout } = await runOcr(buildArgs(path, format, params.mode, params.max_pages), config, signal);
			const body = stdout.trimEnd();
			if (!body) throw new Error(`ocr: ${path} produced no text — is it an empty or corrupt document?`);

			const limit = params.max_chars ?? config.maxChars;
			if (body.length <= limit) {
				return {
					content: [{ type: "text", text: body }],
					details: { path, format, chars: body.length, truncated: false },
				};
			}

			const artifact = await saveArtifact(config, path, format, body);
			const head = body.slice(0, limit);
			return {
				content: [
					{
						type: "text",
						text: `${head}\n\n[truncated: ${body.length} chars total. Full output: ${artifact}]`,
					},
				],
				details: { path, format, chars: body.length, truncated: true, artifact },
			};
		},
	});
}
