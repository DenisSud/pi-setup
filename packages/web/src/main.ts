import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ByteTransportHandlers, Client } from "@earendil-works/pi-client";
import {
	activateBuiltinClientServices,
	type ActivatedClientRuntimeServer,
} from "@pi/fork/experimental/services/activation.ts";
import { createServerServiceSource, createSessionServiceSource } from "@pi/fork/experimental/services/connection.ts";
import { blobatarSvg } from "./blob.ts";
import { renderMarkdown } from "./markdown.ts";

// Minimal browser client for the connector bridge. One WebSocket carries one
// session's byte stream to the bot's pi server; everything above it uses the
// same client stack as the TUI (Client + Chord service facades).

interface BotSummary {
	name: string;
	dir: string;
	running: boolean;
	serverId: string | null;
	pid: number | null;
	startedAt: string | null;
	lastSession: { sessionId: string; updatedAt: string } | null;
}

interface TextBlock {
	type: "text";
	text: string;
}
interface ThinkingBlock {
	type: "thinking";
	thinking: string;
}
interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: unknown;
}
type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | { type: string };

interface MessageLike {
	role: string;
	content?: ContentBlock[];
	isError?: boolean;
	stopReason?: string;
	errorMessage?: string;
	toolCallId?: string;
}

interface MessageEntry {
	type: "message";
	id: string;
	message: MessageLike;
}
interface CompactionEntry {
	type: "compaction";
	id: string;
	summary: string;
}
interface BranchSummaryEntry {
	type: "branch_summary";
	id: string;
	summary: string;
}
interface CustomEntry {
	type: "custom";
	id: string;
	customType: string;
}
type Entry = MessageEntry | CompactionEntry | BranchSummaryEntry | CustomEntry;

interface RunningTool {
	status: "running" | "settled";
	toolCallId: string;
	toolName: string;
	args: unknown;
}

interface QueuedItem {
	entryId: string;
	kind: string;
	type: string;
	message?: MessageLike;
	customType?: string;
}

interface Operation {
	id: string;
	kind: string;
	status: string;
	deferred?: unknown;
	streamingMessage?: MessageLike;
	runningTools?: RunningTool[];
}

interface TranscriptSnapshot {
	lane: string;
	transcript: Entry[];
	operation: Operation | null;
	queues?: QueuedItem[];
	configuration?: { model?: { provider: string; modelId: string }; thinkingLevel?: string };
	stats?: { messageCount?: number };
}

interface ActiveSession {
	bot: string;
	sessionId: string;
	serverId: string;
	client: Client;
	activated: ActivatedClientRuntimeServer;
	ws: WebSocket;
	unsubscribe: () => void;
}

const botList = mustFind<HTMLUListElement>("#bot-list");
const refreshButton = mustFind<HTMLButtonElement>("#refresh");
const sessionTitle = mustFind<HTMLSpanElement>("#session-title");
const sessionStatus = mustFind<HTMLSpanElement>("#session-status");
const transcriptElement = mustFind<HTMLElement>("#transcript");
const promptForm = mustFind<HTMLFormElement>("#prompt-form");
const promptInput = mustFind<HTMLTextAreaElement>("#prompt");
const composerElement = mustFind<HTMLElement>("#composer");
const composerToggle = mustFind<HTMLButtonElement>("#composer-toggle");
const promptLine = 23; // px, mirrors --prompt-line in style.css
const composerState = { expanded: false };
const sendButton = mustFind<HTMLButtonElement>("#send");
const stopButton = mustFind<HTMLButtonElement>("#stop");
const compactButton = mustFind<HTMLButtonElement>("#compact");
const newButton = mustFind<HTMLButtonElement>("#new");
const latestButton = mustFind<HTMLButtonElement>("#latest");
const latestSpinner = document.querySelector<HTMLElement>("#latest-spin");
const menuButton = mustFind<HTMLButtonElement>("#menu");
const sidebarCloseButton = mustFind<HTMLButtonElement>("#sidebar-close");
const scrim = mustFind<HTMLElement>("#scrim");

const ICON_PLUS =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';

let active: ActiveSession | undefined;
let bots: BotSummary[] = [];
// True while the open session has a running turn; drives the sidebar marker
// and the jump pill's spinner.
let laneBusy = false;

/**
 * The spine: one rAF loop owns both smooth behaviors. The transcript follows
 * the end with an exponential glide (~75ms time constant) instead of per-chunk
 * snaps, and the live window's content translates through its mask the same
 * way. Following stops the moment the reader scrolls up and only start again
 * from the jump pill or a sent message — a chunk landing elsewhere never
 * steals the viewport.
 */
const spine = {
	following: true,
	ty: 0, // current live-window translation
	last: 0,
	showLatest: false,
	expected: undefined as number | undefined, // scrollTop we last wrote
};
function tickSpine(now: number): void {
	const dt = Math.min(0.1, (now - spine.last) / 1000);
	spine.last = now;
	if (spine.following && active !== undefined) {
		const distance = transcriptElement.scrollHeight - transcriptElement.clientHeight - transcriptElement.scrollTop;
		if (distance > 0.5) {
			transcriptElement.scrollTop += distance * (1 - Math.exp(-dt / 0.075));
			spine.expected = transcriptElement.scrollTop;
		}
	}
	if (liveWindow !== undefined) {
		const overflow = Math.max(0, liveWindow.line.offsetHeight - liveWindow.clip.clientHeight + 14);
		if (overflow > 0) {
			spine.ty += (overflow - spine.ty) * (1 - Math.exp(-dt / 0.07));
		} else {
			spine.ty *= Math.exp(-dt / 0.05);
		}
		if (spine.ty > 0.5) liveWindow.line.style.transform = `translateY(${(-spine.ty).toFixed(1)}px)`;
		else if (liveWindow.line.style.transform !== "") liveWindow.line.style.transform = "";
	} else {
		spine.ty = 0;
	}
	const show = !spine.following && active !== undefined;
	if (show !== spine.showLatest) {
		spine.showLatest = show;
		latestButton.classList.toggle("show", show);
	}
	if (latestSpinner !== null && latestSpinner.hidden === laneBusy) latestSpinner.hidden = !laneBusy;
	requestAnimationFrame(tickSpine);
}
requestAnimationFrame((t) => {
	spine.last = t;
	requestAnimationFrame(tickSpine);
});

// The transcript is appended to, never rebuilt, so <details> stay open, the
// streaming caret keeps blinking, and new entries can animate in. Compaction
// and session switches replace the list and go through the rebuild path.
let renderedIds: string[] = [];
const toolSteps = new Map<string, HTMLDetailsElement>();
// Results seen before the tool's settled row renders, so the status dot and
// output arrive whatever the order of transcript entries.
const toolResults = new Map<string, MessageLike>();
const liveSlot = document.createElement("div");
liveSlot.className = "live";

/** Streaming answer text: settled markdown plus a fading tail. */
interface StreamText {
	wrap: HTMLElement;
	settled: HTMLElement;
	tail: HTMLSpanElement;
	source: string;
}
/** Live work window: a fixed masked viewport the text glides through. */
interface ThinkingWindow {
	clip: HTMLElement;
	line: HTMLElement;
	source: string;
}
let liveWindow: ThinkingWindow | undefined;
let live: {
	shape: string;
	text?: StreamText;
	root?: HTMLElement;
	queuedIds?: string;
} = { shape: "" };

// No prompt until a session is attached and hydrated.
promptInput.disabled = true;
sendButton.disabled = true;
resetTranscript();
updateLatest();

function mustFind<T extends Element>(selector: string): T {
	const element = document.querySelector<T>(selector);
	if (element === null) throw new Error(`missing element ${selector}`);
	return element;
}

// The session header holds the one live blobatar; its gaze driver has to be
// stopped whenever the header is rebuilt.
let liveBlobatarStop: (() => void) | undefined;

function setSessionTitle(bot?: string, sessionId?: string): void {
	liveBlobatarStop?.();
	liveBlobatarStop = undefined;
	sessionTitle.replaceChildren();
	if (bot === undefined || sessionId === undefined) {
		sessionTitle.textContent = "no session";
		return;
	}
	const blob = blobatarSvg(bot, "avatar title-blob", true);
	liveBlobatarStop = blob.stop;
	const name = document.createElement("span");
	name.className = "title-name";
	name.textContent = bot;
	const id = document.createElement("span");
	id.className = "title-id";
	id.textContent = sessionId.slice(0, 8);
	sessionTitle.append(blob.element, name, id);
}

async function fetchBots(): Promise<BotSummary[]> {
	const response = await fetch("/api/bots");
	if (!response.ok) throw new Error(`/api/bots: ${response.status}`);
	return ((await response.json()) as { bots: BotSummary[] }).bots;
}

function bridgeUrl(path: string): string {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	return `${scheme}://${location.host}${path}`;
}

function setStatus(text: string, kind: "idle" | "busy" | "error" = "idle"): void {
	const dot = document.createElement("span");
	dot.className = "dot";
	sessionStatus.replaceChildren(dot, document.createTextNode(text));
	sessionStatus.className = kind;
}

async function refreshBots(): Promise<void> {
	try {
		bots = await fetchBots();
	} catch (error) {
		setStatus(message(error), "error");
		return;
	}
	renderBots();
}

function renderBots(): void {
	const fragment = document.createDocumentFragment();
	for (const bot of bots) {
		const item = document.createElement("li");
		const busy = bot.name === active?.bot && laneBusy;
		item.className = bot.name === active?.bot ? "active" : "";
		item.title = bot.dir;

		const meta = document.createElement("div");
		meta.className = "bot-meta";

		const name = document.createElement("span");
		name.className = "bot-name";
		name.textContent = bot.name;

		const state = document.createElement("span");
		state.className = busy ? "bot-state busy" : bot.running ? "bot-state running" : "bot-state";
		state.textContent = busy ? "running a turn" : bot.running ? "server running" : "idle";

		meta.append(name, state);

		// one full-row button: the whole pill is the press target
		const open = document.createElement("button");
		open.className = "bot-open";
		open.type = "button";
		open.onclick = () => void openBot(bot.name, false);

		open.append(blobatarSvg(bot.name, "avatar", false).element, meta);
		item.append(open);
		fragment.append(item);
	}
	botList.replaceChildren(fragment);
}

async function openBot(bot: string, fresh: boolean): Promise<void> {
	await closeSession();
	resetTranscript();
	updateComposer();
	setStatus("connecting", "busy");
	try {
		const summary = bots.find((candidate) => candidate.name === bot);
		if (summary === undefined) throw new Error(`unknown bot ${bot}`);
		const sessionId = fresh || summary.lastSession === null ? crypto.randomUUID() : summary.lastSession.sessionId;
		const openSessionId = sessionId;

		const ws = new WebSocket(bridgeUrl(`/ws?bot=${encodeURIComponent(bot)}&session=${sessionId}`));
		ws.binaryType = "arraybuffer";
		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => resolve();
			ws.onerror = () => reject(new Error("bridge upgrade failed"));
		});

		// The upgrade starts the bot's server, so the route exists by now.
		const started = await fetchBots();
		bots = started;
		const serverId = started.find((candidate) => candidate.name === bot)?.serverId;
		if (serverId === null || serverId === undefined) throw new Error(`bot ${bot} has no server route`);

		const client = await Client.connect({ serverId, transportFactory: browserTransport(ws) });
		const server = createServerServiceSource(client);
		const session = createSessionServiceSource(client);
		const activated = await activateBuiltinClientServices({
			route: { transport: "unix", serverId, path: "bridge" },
			client,
			server,
			session,
		});
		const known = activated.directory.state.value?.sessions.some((entry) => entry.sessionId === sessionId) ?? false;
		if (!known) await activated.management.create({ id: sessionId }, BACKGROUND_CONTEXT);
		await activated.management.attach(sessionId, BACKGROUND_CONTEXT);

		active = { bot, sessionId, serverId, client, activated, ws, unsubscribe: () => {} };
		setSessionTitle(bot, sessionId);
		spine.following = true;
		document.body.classList.remove("drawer-open");
		active.unsubscribe = activated.transcript.state.subscribe((state) => {
			// A late update from a previous bot must not clobber the current view.
			if (active?.sessionId === openSessionId) renderTranscript(state.snapshot);
		});
		renderTranscript(activated.transcript.state.value?.snapshot);
		updateComposer();
		renderBots();
		promptInput.focus();
		// The attach registered this session as the bot's last one.
		void refreshBots();
	} catch (error) {
		setStatus(message(error), "error");
	}
}

/**
 * ByteTransport over one bridge WebSocket. Sends are fire-and-forget: the
 * browser API offers no completion signal, and pi frames are small.
 */
function browserTransport(ws: WebSocket) {
	return async (handlers: ByteTransportHandlers) => {
		ws.onmessage = (event) => handlers.onData(new Uint8Array(event.data as ArrayBuffer));
		ws.onclose = () => handlers.onClose();
		ws.onerror = () => handlers.onError(new Error("bridge websocket error"));
		return {
			async send(chunk: Uint8Array): Promise<void> {
				if (ws.readyState !== WebSocket.OPEN) throw new Error("bridge websocket is closed");
				ws.send(chunk);
			},
			close(): void {
				ws.close();
			},
		};
	};
}

async function closeSession(): Promise<void> {
	if (active === undefined) return;
	const closing = active;
	active = undefined;
	closing.unsubscribe();
	closing.ws.close();
	resetTranscript();
	setSessionTitle();
	updateComposer();
	updateLatest();
	updateActions();
	try {
		await closing.client.dispose();
	} catch {
		// the socket may already be gone
	}
}

function snapshotIsRunning(): boolean {
	return currentOperation() !== undefined;
}

// A snapshot operation is present while the lane is busy; status is "open"
// when it can still be aborted and "aborting" once the abort was requested.
function currentOperation(): Operation | undefined {
	const operation = currentSnapshot()?.operation;
	return operation === null || operation === undefined ? undefined : operation;
}

function currentSnapshot(): TranscriptSnapshot | undefined {
	return active?.activated.transcript.state.value?.snapshot as TranscriptSnapshot | null | undefined ?? undefined;
}

// Buttons only do what the lane can take: nothing while connecting, abort while
// running, compact while idle.
function updateActions(): void {
	const live = active !== undefined;
	const operation = currentOperation();
	stopButton.disabled = !live || operation?.status !== "open";
	compactButton.disabled = !live || operation !== undefined;
	newButton.disabled = !live;
	const busy = operation !== undefined;
	if (laneBusy !== busy) {
		laneBusy = busy;
		renderBots();
	}
}

function updateComposer(): void {
	const live = active !== undefined;
	promptInput.disabled = !live;
	sendButton.disabled = !live || promptInput.value.trim() === "";
	promptInput.placeholder = !live ? "Select a bot" : snapshotIsRunning() ? "Steer the agent\u2026" : `Message ${active?.bot ?? ""}`;
}

function resetTranscript(): void {
	if (liveSwapTimer !== undefined) {
		clearTimeout(liveSwapTimer);
		liveSwapTimer = undefined;
	}
	renderedIds = [];
	toolSteps.clear();
	toolResults.clear();
	liveWindow = undefined;
	spine.ty = 0;
	spine.following = true;
	spine.showLatest = false;
	latestButton.classList.remove("show");
	live = { shape: "" };
	liveSlot.replaceChildren();
	liveSlot.classList.remove("enter");
	transcriptElement.replaceChildren(liveSlot);
	transcriptElement.classList.add("empty");
}

function scrollToBottom(smooth: boolean): void {
	spine.following = true;
	updateLatest();
}

function isNearBottom(): boolean {
	return transcriptElement.scrollHeight - transcriptElement.scrollTop - transcriptElement.clientHeight < 90;
}

function updateLatest(): void {
	const show = !spine.following && active !== undefined;
	if (show !== spine.showLatest) {
		spine.showLatest = show;
		latestButton.classList.toggle("show", show);
	}
}

function renderTranscript(snapshot: TranscriptSnapshot | null | undefined): void {
	if (snapshot === null || snapshot === undefined) {
		setStatus("waiting for the transcript", "busy");
		return;
	}
	const stick = spine.following;
	const entries = snapshot.transcript;
	const prefix =
		entries.length >= renderedIds.length && renderedIds.every((id, index) => entries[index]?.id === id);
	if (!prefix) {
		renderedIds = [];
		toolSteps.clear();
		toolResults.clear();
		transcriptElement.replaceChildren(liveSlot);
		const fragment = document.createDocumentFragment();
		for (const entry of entries) {
			const node = renderEntry(entry);
			if (node !== undefined) fragment.append(node);
		}
		transcriptElement.insertBefore(fragment, liveSlot);
	} else if (entries.length > renderedIds.length) {
		const fragment = document.createDocumentFragment();
		for (const entry of entries.slice(renderedIds.length)) {
			const node = renderEntry(entry);
			if (node !== undefined) {
				node.classList.add("enter");
				fragment.append(node);
			}
		}
		transcriptElement.insertBefore(fragment, liveSlot);
	}
	renderedIds = entries.map((entry) => entry.id);
	renderLive(snapshot);
	transcriptElement.classList.toggle("empty", renderedIds.length === 0 && liveSlot.firstElementChild === null);
	if (stick) scrollToBottom(false);
	updateLatest();
	const running = snapshot.operation !== null && snapshot.operation !== undefined;
	if (sessionStatus.className !== "error") setStatus(running ? "running" : "ready", running ? "busy" : "idle");
	updateComposer();
	updateActions();
}

function renderEntry(entry: Entry): HTMLElement | undefined {
	switch (entry.type) {
		case "message": {
			const message = entry.message;
			if (message.role === "toolResult") {
				if (message.toolCallId !== undefined) toolResults.set(message.toolCallId, message);
				return undefined;
			}
			return renderMessage(message);
		}
		case "compaction":
			return systemNote("compacted", entry.summary);
		case "branch_summary":
			return systemNote("branch summary", entry.summary);
		case "custom":
			return systemNote(entry.customType, "");
		default:
			return undefined;
	}
}

function renderMessage(message: MessageLike, options: { register?: boolean } = {}): HTMLElement {
	const article = document.createElement("article");
	article.className = message.role === "user" ? "message user" : "message assistant";
	if (message.isError === true || message.stopReason === "error") article.classList.add("error");

	if (message.role === "user") {
		const bubble = document.createElement("div");
		bubble.className = "bubble";
		bubble.textContent = textOf(message);
		article.append(bubble);
		return article;
	}
	let hasText = false;
	// tool calls and thinking are not rendered for now (styling kept)
	for (const block of messageBlocks(message)) {
		if (block.type === "text" && block.text.trim() !== "") {
			article.append(markdown(block.text));
			hasText = true;
		}
	}
	if (message.stopReason === "error" && message.errorMessage !== undefined) article.append(note(message.errorMessage));
	if (!hasText) article.classList.add("blockless");
	return article;
}

/**
 * The answer slot: what the model is writing right now, or a thinking line
 * while it has not written anything yet.
 */
function renderLive(snapshot: TranscriptSnapshot): void {
	const operation = snapshot.operation;
	const queued = queuedMessages(snapshot);
	const streaming = operation?.streamingMessage;
	const running = (operation?.runningTools ?? []).filter((tool) => tool.status === "running");
	const text = streaming === undefined ? "" : blockText(streaming, "text");
	const queuedIds = queued.map((item) => item.entryId).join(",");
	const shape = JSON.stringify({
		id: operation?.id ?? null,
		status: operation?.status ?? null,
		deferred: operation?.deferred !== undefined,
		queued: queuedIds,
		blocks: messageBlocks(streaming).map((block) => block.type),
		running: running.map((tool) => tool.toolCallId),
		streaming: streaming !== undefined,
		hasText: text.trim() !== "",
	});
	if (shape === live.shape) {
		// The same nodes, with more content: extend what is already rendered.
		if (live.text !== undefined && text !== live.text.source) updateStreamText(live.text, text);
		return;
	}
	live.shape = shape;
	spine.ty = 0;
	liveWindow = undefined;
	// The answer is on screen and still streaming: keep it, only the working
	// line under it changes (a full swap would blink the whole answer).
	if (live.text !== undefined && live.root !== undefined && text.trim() !== "" && queuedIds === live.queuedIds) {
		updateStreamText(live.text, text);
		setWorkLine(live.root, running[running.length - 1]);
		return;
	}
	live.text = undefined;
	live.root = undefined;
	live.queuedIds = queuedIds;
	const fragment = document.createDocumentFragment();
	for (const item of queued) fragment.append(queuedMessage(item));
	if (streaming !== undefined) {
		const view = createLiveView(streaming, running, operation?.deferred !== undefined);
		live.root = view;
		fragment.append(view);
	} else if (operation !== null && operation !== undefined) {
		const tool = running[running.length - 1];
		fragment.append(tool === undefined ? thinkingLine(operation.deferred !== undefined) : runningLine(tool));
	}
	swapLive(fragment);
}

/**
 * The live view: the answer being written, or one quiet working line while
 * the model thinks or runs tools. Tool rows and thinking blocks stay in the
 * stylesheet for later; they are not rendered for now.
 */
function createLiveView(message: MessageLike, running: RunningTool[], deferred: boolean): HTMLElement {
	const root = document.createElement("article");
	root.className = "message assistant streaming";
	const text = blockText(message, "text");
	const tool = running[running.length - 1];
	if (text.trim() !== "") {
		const stream = newStreamText();
		root.append(stream.wrap);
		updateStreamText(stream, text);
		live.text = stream;
		// what the model already said stays above the tool it is running now
		if (tool !== undefined) {
			const line = runningLine(tool);
			line.dataset.key = tool.toolCallId;
			root.append(line);
		}
		return root;
	}
	root.append(tool === undefined ? thinkingLine(deferred) : runningLine(tool));
	return root;
}

/** Add, replace or fade out the working line under the streaming answer. */
function setWorkLine(root: HTMLElement, tool: RunningTool | undefined): void {
	const current = root.querySelector<HTMLElement>(".work");
	if (tool === undefined) {
		if (current !== null && current.dataset.leaving !== "1") {
			current.dataset.leaving = "1";
			current
				.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: EASE })
				.finished.then(() => current.remove())
				.catch(() => current.remove());
		}
		return;
	}
	if (current !== null && current.dataset.key === tool.toolCallId) return;
	const next = runningLine(tool);
	next.dataset.key = tool.toolCallId;
	next.classList.add("enter");
	if (current !== null) current.replaceWith(next);
	else root.append(next);
}

/** Streaming answer text: settled markdown plus a fading tail. */
interface StreamText {
	wrap: HTMLElement;
	settled: HTMLElement;
	tail: HTMLSpanElement;
	source: string;
}

function newStreamText(): StreamText {
	const wrap = document.createElement("div");
	wrap.className = "text markdown";
	const settled = document.createElement("div");
	settled.className = "settled";
	const tail = document.createElement("span");
	tail.className = "tail";
	settled.append(tail);
	wrap.append(settled);
	return { wrap, settled, tail, source: "" };
}

/**
 * Append-only updates fade in what arrived (fade < median inter-token
 * interval, so the pace follows the model's real throughput); any rewrite
 * re-renders whole with no animation.
 */
function updateStreamText(stream: StreamText, next: string): void {
	const oldFull = stream.source + (stream.tail.textContent ?? "");
	if (oldFull !== "" && next.startsWith(oldFull)) {
		stream.source = oldFull;
		stream.settled.innerHTML = renderMarkdown(oldFull);
		placeTail(stream, next.slice(oldFull.length));
	} else {
		stream.source = next;
		stream.settled.innerHTML = renderMarkdown(next);
		stream.tail.replaceChildren();
		const blocks = stream.settled.children;
		const last = blocks[blocks.length - 1];
		if (last !== undefined && /^(P|LI|H[1-4]|UL|OL|BLOCKQUOTE)$/.test(last.tagName)) last.append(stream.tail);
		else stream.settled.append(stream.tail);
	}
}

function placeTail(stream: StreamText, delta: string): void {
	const fresh = document.createElement("span");
	fresh.className = "tail";
	if (delta !== "") {
		if (delta.length <= 40) appendRevealSpan(fresh, delta);
		else for (const word of delta.match(/\S+ ?/g) ?? []) appendRevealSpan(fresh, word);
	}
	stream.tail.replaceWith(fresh);
	stream.tail = fresh;
	const blocks = stream.settled.children;
	const last = blocks[blocks.length - 1];
	if (last !== undefined && /^(P|LI|H[1-4]|UL|OL|BLOCKQUOTE)$/.test(last.tagName)) last.append(stream.tail);
	else stream.settled.append(stream.tail);
}

function appendRevealSpan(parent: HTMLElement, text: string): void {
	const span = document.createElement("span");
	span.className = "w-fade";
	span.textContent = text;
	parent.append(span);
}

/* ---- live work window: fixed masked viewport, text glides through ---- */

function makeLiveWindow(source: string): ThinkingWindow {
	const clip = document.createElement("div");
	clip.className = "live-window";
	const line = document.createElement("p");
	line.className = "live-line";
	line.textContent = source;
	clip.append(line);
	return { clip, line, source };
}

function appendThinkingTail(win: ThinkingWindow, next: string): void {
	if (next.startsWith(win.source)) {
		const delta = next.slice(win.source.length);
		if (delta !== "") {
			if (delta.length <= 40) appendRevealSpan(win.line, delta);
			else for (const word of delta.match(/\S+ ?/g) ?? []) appendRevealSpan(win.line, word);
		}
	} else {
		win.line.textContent = next;
	}
	win.source = next;
}

function statusDot(shape: "" | "wait"): HTMLElement {
	const dot = document.createElement("span");
	dot.className = shape === "" ? "tdot" : `tdot ${shape}`;
	return dot;
}

function toolStep(block: ToolCallBlock, running: boolean, register: boolean): HTMLDetailsElement {
	const details = document.createElement("details");
	details.className = running ? "step tool running" : "step tool";
	const summary = document.createElement("summary");
	summary.append(statusDot(running ? "wait" : ""));
	const name = document.createElement("span");
	name.className = "step-name";
	name.textContent = block.name;
	const text = document.createElement("span");
	text.className = "step-text";
	text.textContent = summarizeArgs(block.arguments) || "\u2026";
	summary.append(name, text);
	const args = document.createElement("pre");
	args.className = "step-block args";
	args.textContent = pretty(block.arguments);
	details.append(summary, args);
	if (register) {
		toolSteps.set(block.id, details);
		const cached = toolResults.get(block.id);
		if (cached !== undefined) attachResult(details, cached);
	}
	return details;
}

function runningStep(tool: RunningTool): HTMLDetailsElement {
	const details = document.createElement("details");
	details.className = "step tool running";
	const summary = document.createElement("summary");
	const name = document.createElement("span");
	name.className = "step-name";
	name.textContent = tool.toolName;
	const text = document.createElement("span");
	text.className = "step-text";
	text.textContent = summarizeArgs(tool.args) || "\u2026";
	summary.append(statusDot("wait"), name, text);
	details.append(summary);
	return details;
}

function attachResult(step: HTMLDetailsElement, message: MessageLike): void {
	const dot = step.querySelector(".tdot");
	if (dot !== null) dot.className = message.isError === true ? "tdot err" : "tdot ok";
	if (message.isError === true) step.classList.add("failed");
	const pre = document.createElement("pre");
	pre.className = "step-block result";
	pre.textContent = textOf(message).trim() || "(no output)";
	step.append(pre);
}

function toolResultPanel(message: MessageLike): HTMLElement {
	const article = document.createElement("article");
	article.className = message.isError === true ? "message toolResult error" : "message toolResult";
	const label = document.createElement("div");
	label.className = "tool-label";
	label.textContent = message.isError === true ? "tool error" : "tool result";
	const pre = document.createElement("pre");
	pre.className = "step-block result";
	pre.textContent = textOf(message).trim() || "(no output)";
	article.append(label, pre);
	return article;
}

function queuedMessage(item: QueuedItem): HTMLElement {
	const article = document.createElement("article");
	article.className = "message user queued";
	const bubble = document.createElement("div");
	bubble.className = "bubble";
	bubble.textContent = textOf(item.message ?? { role: "user" });
	const tag = document.createElement("span");
	tag.className = "tag";
	tag.textContent = item.kind === "steer" ? "steering" : "queued";
	bubble.append(tag);
	article.append(bubble);
	return article;
}

/** The quiet working line before anything lands. */
function thinkingLine(deferred: boolean): HTMLElement {
	return workLine(ICONS.thinking, deferred ? "Waiting" : "Thinking", "", true);
}

/** The working line while a tool runs: its icon, label and argument. */
function runningLine(tool: RunningTool): HTMLElement {
	return workLine(iconFor(tool.toolName), labelFor(tool.toolName), summarizeArgs(tool.args), false);
}

/* ---- working line: one quiet row, a tool icon and a short label ---- */

const SVG_ATTRS =
	'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

/** One icon per standard tool; anything else gets the general wrench. */
const ICONS: Record<string, string> = {
	bash: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
	read: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/>',
	write:
		'<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
	edit: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
	ls: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
	grep: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
	glob: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
	find: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
	web: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
	general:
		'<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
	thinking:
		'<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
	wait: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
};

const TOOL_LABELS: Record<string, string> = {
	bash: "Running command",
	read: "Reading",
	write: "Writing",
	edit: "Editing",
	ls: "Listing files",
	grep: "Searching",
	glob: "Finding files",
	find: "Finding files",
	web_search: "Searching the web",
	web_fetch: "Fetching page",
};

function iconFor(tool: string): string {
	if (tool in ICONS) return ICONS[tool];
	if (tool.startsWith("web")) return ICONS.web;
	return ICONS.general;
}

function labelFor(tool: string): string {
	return TOOL_LABELS[tool] ?? tool.replace(/_/g, " ");
}

/** One working line: icon, label, optional detail, optional dots. */
function workLine(icon: string, label: string, detail: string, dots: boolean): HTMLElement {
	const line = document.createElement("div");
	line.className = "work thinking";
	const glyph = document.createElement("span");
	glyph.className = "work-icon";
	glyph.innerHTML = `<svg ${SVG_ATTRS}>${icon}</svg>`;
	const text = document.createElement("span");
	text.className = "work-label";
	text.textContent = label;
	line.append(glyph, text);
	if (detail !== "") {
		const args = document.createElement("span");
		args.className = "work-detail";
		args.textContent = detail;
		line.append(args);
	}
	if (dots) {
		const pulse = document.createElement("span");
		pulse.className = "dots";
		for (let index = 0; index < 3; index += 1) pulse.append(document.createElement("i"));
		line.append(pulse);
	}
	return line;
}

const EASE = "cubic-bezier(0.2, 0, 0, 1)";
let liveSwapTimer: number | undefined;

/** Replace the live slot: the outgoing content fades out, the new fades in. */
function swapLive(fragment: DocumentFragment): void {
	const place = (): void => {
		liveSlot.replaceChildren(fragment);
		for (const node of liveSlot.children) node.classList.add("enter");
	};
	const previous = [...liveSlot.children];
	if (liveSwapTimer !== undefined) {
		clearTimeout(liveSwapTimer);
		liveSwapTimer = undefined;
		place();
		return;
	}
	if (previous.length === 0) {
		place();
		return;
	}
	for (const node of previous) node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: EASE });
	liveSwapTimer = window.setTimeout(() => {
		liveSwapTimer = undefined;
		place();
	}, 150);
}

function markdown(source: string): HTMLElement {
	const element = document.createElement("div");
	element.className = "text markdown";
	element.innerHTML = renderMarkdown(source);
	return element;
}

function collapsible(label: string, body: string): HTMLDetailsElement {
	const details = document.createElement("details");
	details.className = "reason-row";
	const summary = document.createElement("summary");
	const chev = document.createElement("span");
	chev.className = "chev";
	chev.textContent = "\u203a";
	const name = document.createElement("span");
	name.className = "reason-label";
	name.textContent = label;
	summary.append(chev, name);
	const pre = document.createElement("pre");
	pre.className = "rbody";
	pre.textContent = body;
	details.append(summary, pre);
	return details;
}

function systemNote(label: string, summary: string): HTMLElement {
	const aside = document.createElement("details");
	aside.className = "note";
	const head = document.createElement("summary");
	head.textContent = label;
	aside.append(head);
	if (summary !== "") {
		const body = document.createElement("pre");
		body.className = "step-block";
		body.textContent = summary;
		aside.append(body);
	}
	return aside;
}

function note(text: string): HTMLElement {
	const aside = document.createElement("div");
	aside.className = "note error-note";
	aside.textContent = text;
	return aside;
}

function queuedMessages(snapshot: TranscriptSnapshot): QueuedItem[] {
	return (snapshot.queues ?? []).filter(
		(item) => item.type === "message" && (item.kind === "steer" || item.kind === "followUp"),
	);
}

function messageBlocks(message: MessageLike | undefined): ContentBlock[] {
	return message !== undefined && Array.isArray(message.content) ? message.content : [];
}

function isToolCall(block: ContentBlock): block is ToolCallBlock {
	return block.type === "toolCall";
}

function blockText(message: MessageLike, type: "text" | "thinking"): string {
	const parts: string[] = [];
	for (const block of messageBlocks(message)) {
		if (type === "text" && block.type === "text") parts.push(block.text);
		else if (type === "thinking" && block.type === "thinking") parts.push(block.thinking);
	}
	return parts.join(type === "text" ? "\n" : "\n\n");
}

function textOf(message: MessageLike): string {
	return blockText(message, "text");
}

/** One line of a tool call, in the CLI's `bash: ls -la` shape. */
function summarizeArgs(args: unknown): string {
	if (args === null || typeof args !== "object") return typeof args === "string" ? singleLine(args) : "";
	const record = args as Record<string, unknown>;
	const first = record.command ?? record.path ?? record.pattern ?? record.query ?? Object.values(record)[0];
	return typeof first === "string" ? singleLine(first) : "";
}

function singleLine(text: string, max = 100): string {
	const line = text.split("\n").find((part) => part.trim() !== "")?.trim() ?? "";
	return line.length > max ? `${line.slice(0, max)}\u2026` : line;
}

function pretty(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? "";
	} catch {
		return String(value);
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The composer pill: one line grows with the text; past 14 lines it caps
 * (scrollable, fading top) until the toggle calls for the expanded 27.
 */
function composerRelayout(): void {
	promptInput.style.height = "0px";
	const single = promptLine;
	const natural = promptInput.scrollHeight;
	const multiline = composerState.expanded || promptInput.value.includes("\n") || natural > single + 4;
	composerElement.classList.toggle("multiline", multiline);
	const cap = Math.max(
		3 * promptLine,
		Math.min((composerState.expanded ? 27 : 14) * promptLine, window.innerHeight - 152),
	);
	promptInput.style.height = `${Math.min(natural, multiline ? cap : single)}px`;
	composerElement.classList.toggle("capped", promptInput.scrollHeight > promptInput.clientHeight + 1);
	promptInput.scrollTop = promptInput.scrollHeight;
}

window.addEventListener("resize", () => composerRelayout());

composerToggle.addEventListener("click", () => {
	composerState.expanded = !composerState.expanded;
	composerElement.classList.toggle("expanded", composerState.expanded);
	composerToggle.title = composerState.expanded ? "collapse input" : "expand input";
	composerToggle.ariaLabel = composerToggle.title;
	composerRelayout();
	promptInput.focus();
});

/** Text still in the lane queues, handed back to the composer on abort. */
function restoreQueued(): void {
	const snapshot = currentSnapshot();
	const dropped = queuedMessages(snapshot ?? ({ transcript: [], operation: null } as TranscriptSnapshot))
		.map((item) => textOf(item.message ?? { role: "user" }).trim())
		.filter((text) => text !== "");
	if (dropped.length === 0) return;
	const text = dropped.join("\n\n");
	promptInput.value = promptInput.value.trim() === "" ? text : `${text}\n\n${promptInput.value}`;
	composerRelayout();
	updateComposer();
}

promptForm.addEventListener("submit", (event) => {
	event.preventDefault();
	const text = promptInput.value.trim();
	const session = active;
	if (text === "" || session === undefined) return;
	const request = { message: text, images: null };
	promptInput.value = "";
	composerRelayout();
	updateComposer();
	scrollToBottom(true);
	// While a turn runs the message steers it; otherwise it starts a turn.
	const call = snapshotIsRunning()
		? session.activated.agent.steer(request, BACKGROUND_CONTEXT)
		: session.activated.agent.prompt(request, BACKGROUND_CONTEXT);
	void call.then(
		(response) => {
			if (response.accepted) {
				updateComposer();
				return;
			}
			promptInput.value = text;
			setStatus(response.error.message, "error");
			updateComposer();
		},
		(error: unknown) => {
			promptInput.value = text;
			setStatus(message(error), "error");
			updateComposer();
		},
	);
});

promptInput.addEventListener("input", () => {
	composerRelayout();
	updateComposer();
});

promptInput.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		promptForm.requestSubmit();
	}
});

transcriptElement.addEventListener("scroll", () => {
	// The spine's own glide reports scroll events; only a human struggle
	// (positions we did not write) counts as "the reader moved".
	if (spine.expected !== undefined && Math.abs(spine.expected - transcriptElement.scrollTop) <= 2) return;
	spine.expected = undefined;
	spine.following = isNearBottom();
	updateLatest();
});

menuButton.addEventListener("click", () => document.body.classList.add("drawer-open"));
sidebarCloseButton.addEventListener("click", () => document.body.classList.remove("drawer-open"));
scrim.addEventListener("click", () => document.body.classList.remove("drawer-open"));

latestButton.addEventListener("click", () => scrollToBottom(true));
refreshButton.addEventListener("click", () => void refreshBots());
window.addEventListener("focus", () => void refreshBots());

stopButton.addEventListener("click", () => {
	const session = active;
	const operation = currentOperation();
	if (session === undefined || operation === undefined) return;
	restoreQueued();
	stopButton.disabled = true;
	setStatus("aborting", "busy");
	void session.activated.agent.requestAbort(operation.id, BACKGROUND_CONTEXT).catch((error: unknown) => {
		setStatus(message(error), "error");
		updateActions();
	});
});

compactButton.addEventListener("click", () => {
	const session = active;
	if (session === undefined) return;
	compactButton.disabled = true;
	setStatus("compacting", "busy");
	void session.activated.agent.compact({ customInstructions: null }, BACKGROUND_CONTEXT).then(
		(response) => {
			if (!response.accepted || response.error !== null) {
				setStatus(response.error?.message ?? "compact failed", "error");
			} else if (sessionStatus.className === "error") {
				setStatus("ready", "idle");
			}
			updateActions();
		},
		(error: unknown) => {
			setStatus(message(error), "error");
			updateActions();
		},
	);
});

newButton.addEventListener("click", () => {
	if (active === undefined) return;
	void openBot(active.bot, true);
});

await refreshBots();
