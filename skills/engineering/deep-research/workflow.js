// deep-research — the graph behind /skill:deep-research.
//
//   seekers (researcher, one per sub-question, parallel)
//     -> coverage judge (reviewer, structured verdict)
//       -> optional targeted round 2 on the gaps it names
//         -> draft (worker, the single writer)
//           -> claim audit (researcher, fetches the cited pages)
//             -> revise (worker, fixes only what the audit flagged)
//
// The parent session does the scoping and the recon; this script owns the
// execution. Do not edit this per question — pass a different plan.
//
// args (plain JSON, persisted, no secrets):
//   outdir     absolute run directory, created by the parent, holding brief.md
//   plan       [{ id, question, angle? }] — id must match [A-Za-z0-9][A-Za-z0-9._-]*
//   rounds     1 or 2 fan-out rounds (default 1)
//   model      optional provider/id override for every child
//   tier       "light" | "standard" | "deep", sets per-searcher effort

const outdir = String(args.outdir || "").replace(/\/+$/, "");
const Model = args.model ? String(args.model) : "";
const tier = String(args.tier || "standard");
const rounds = Math.max(1, Math.min(2, Number(args.rounds || 1)));
const plan = (Array.isArray(args.plan) ? args.plan : []).filter(
	(item) => item && typeof item.id === "string" && typeof item.question === "string" && item.question.trim(),
);

if (!outdir.startsWith("/")) throw new Error("args.outdir must be an absolute path");
if (!plan.length) throw new Error("args.plan must be a non-empty list of { id, question }");

const effort = tier === "deep" ? "6-12" : tier === "light" ? "3-5" : "4-8";
const findings = outdir + "/findings";
// One brief, one place: every child reads it from disk, so nothing is duplicated
// into args and an edit to brief.md reaches the next stage.
const briefPath = outdir + "/brief.md";

// Every child is its own context: no child inherits the parent's transcript, so
// a stage judges the brief and the files, not the conversation that produced it.
function child(spec) {
	const base = { context: "fresh", ...spec };
	return Model ? { ...base, model: Model } : base;
}

function seekTask(item) {
	return [
		"You are one searcher in a parallel research run. Your notes file is the only thing that survives you: the",
		"agent that writes the final report reads that file and nothing else from your work. Depth in the notes beats",
		"brevity in your reply.",
		"",
		"Read " + briefPath + " first. The whole run answers that brief; you answer one part of it.",
		"",
		"YOUR SUB-QUESTION",
		item.question,
		item.angle ? "\nANGLE: " + item.angle : "",
		"",
		"TOOLS IN THIS SETUP — this differs from what you may assume, read it before you start:",
		"- `web_search(query=\"...\", max_results=8, time_range?)` takes ONE query string. There is no `queries` array.",
		"  Call it once per query.",
		"- There is NO `fetch_content` and NO `source_check` tool here. Read pages yourself in bash:",
		"  curl -sSL --max-time 20 --compressed -A 'Mozilla/5.0' \"<url>\" | sed -e 's/<[^>]*>//g' | tr -s '\\n' | head -400",
		"  Always pass --max-time. Never fetch a PDF: you get binary, not text. If curl runs past 20s, abandon that URL.",
		"- Stripped text under ~500 characters means the page is JS-rendered or a paywall. Do not fight it, find another source.",
		"",
		"SEARCH DISCIPLINE",
		"- " + effort + " web_search calls. Stop early when the last two searches returned nothing new, or when the",
		"  sub-question is answered.",
		"- Search for the thing, not the topic: the spec, the paper, the repo, the changelog, the filing, the official doc.",
		"- Reject content farms, SEO listicles and secondary write-ups that cite a primary source you can reach yourself.",
		"  Go to the primary source.",
		"- Record the publication date of anything time-sensitive. A 2019 benchmark is evidence about 2019.",
		"",
		"FIRST: mkdir -p " + findings,
		"",
		"WRITE TO: " + findings + "/" + item.id + ".md — exactly this format:",
		"",
		"# " + item.question,
		"## Answer",
		"2-4 sentences. Direct. No hedging.",
		"## Claims",
		"- <one claim> [n] — \"<verbatim quote, max 30 words>\" — <direct|partial|inferred>",
		"  One line per claim. [n] is the source number. `direct` = the source states it, `partial` = the source implies",
		"  it, `inferred` = you concluded it. Never label an inference as direct.",
		"## Sources",
		"[n] <title> — <url> — accessed <YYYY-MM-DD> — <primary|paper|docs|vendor|blog>",
		"## Conflicts",
		"Sources that disagree with each other, quoted on both sides. Write \"none found\" if none.",
		"## Unanswered",
		"What you could not establish and where you looked. Be specific: this drives the next round.",
		"## Queries",
		"The queries you actually ran.",
		"",
		"Your reply to me: 10 lines max. The sub-question, the answer, how many sources, what is unresolved. The file is",
		"the deliverable.",
	].join("\n");
}

function gapTask(gap, n) {
	return [
		"You are the follow-up searcher in a research run. A first round of parallel searchers left a specific hole;",
		"you are here to close it. Do not re-research what the notes already cover.",
		"",
		"Read " + briefPath + " first — that is the brief the whole run answers.",
		"",
		"THE HOLE",
		gap.question,
		gap.why ? "\nWHY IT MATTERS: " + gap.why : "",
		gap.looked ? "\nALREADY LOOKED HERE: " + gap.looked : "",
		"",
		"The first round's notes are in " + findings + "/ — read the ones closest to your hole first with `read`,",
		"then search only for what they miss.",
		"",
		"Tools: `web_search(query=\"...\", max_results=8)` takes ONE query, once per query. No `fetch_content`, no",
		"`source_check`. Read pages with",
		"curl -sSL --max-time 20 --compressed -A 'Mozilla/5.0' \"<url>\" | sed -e 's/<[^>]*>//g' | tr -s '\\n' | head -400",
		"Never fetch a PDF. Abandon a URL that runs past 20s.",
		"",
		"3-6 web_search calls. If the hole cannot be closed, say so plainly in Unanswered — that is a valid result.",
		"",
		"WRITE TO: " + findings + "/gap-" + n + ".md, same format as the other note files: # <question>, then",
		"## Answer, ## Claims, ## Sources, ## Conflicts, ## Unanswered, ## Queries.",
		"",
		"Your reply to me: 5 lines max.",
	].join("\n");
}

// ── round 1: parallel seekers, one per sub-question ──────────────────────

emit({ stage: "seek", count: plan.length, tier });

const seekers = await runs.all(
	plan.map((item) =>
		child({
			key: String(item.id),
			label: "Research: " + String(item.question).slice(0, 70),
			agent: "researcher",
			task: seekTask(item),
			output: findings + "/" + item.id + ".md",
		}),
	),
);

const seekerRows = seekers.map((result, index) => ({
	key: String(plan[index].id),
	ok: Boolean(result && result.ok),
	runId: result && result.runId,
	file: findings + "/" + plan[index].id + ".md",
	error: result && !result.ok ? String(result.error || "failed").slice(0, 300) : undefined,
}));
const seeked = seekerRows.filter((row) => row.ok).length;
if (!seeked) {
	return { stage: "seek", ok: false, error: "every seeker failed", seekers: seekerRows };
}

// ── coverage judge: does the notes set answer the brief? ─────────────────

let gapRows = [];
let coverage = null;

// rounds: 1 is one fan-out and no judge. rounds: 2 adds the coverage judgement
// and one targeted round of searchers on the holes it names.
if (rounds > 1) {
	emit({ stage: "coverage", notes: seeked });

	const judge = await runs.run(
		"coverage",
		child({
			label: "Judge coverage of the notes",
			// reviewer, not oracle: oracle defaults to a forked context, so as a workflow node
			// it replays the parent transcript to answer a question about five small files.
			// The judge reads brief.md and the notes; it needs no inherited context.
			agent: "reviewer",
			task: [
				"You are the coverage judge on a deep-research run. You did not do the searching and you do not",
				"defend it: your job is to find what the notes do not answer. You are read-only and you write no file;",
				"the verdict comes back through the structured output.",
				"",
				"The brief the report must answer is at " + briefPath + ". Read it, then read every notes file",
				"(.md) in " + findings + "/ .",
				"",
				"Decide whether a competent writer could produce a report that answers the brief from these notes alone.",
				"Judge coverage of the brief, not the quality of the prose:",
				"- Are the brief's explicit sub-questions answered?",
				"- Is any load-bearing claim resting on one weak or secondary source?",
				"- Is anything asserted with no source at all?",
				"- Are contradictions in the notes left unresolved?",
				"- Is the evidence current enough for the question?",
				"",
				"Then answer through the structured output only.",
				"`verdict`: \"sufficient\" if a writer could answer the brief well, \"continue\" if a hole would show.",
				"`gaps`: at most 3, each a searchable question a new searcher could actually close. Not \"more depth on X\".",
				"If verdict is sufficient, return an empty list.",
				"`assessment`: 3 sentences on where the evidence is thin.",
			].join("\n"),
			outputSchema: {
				type: "object",
				required: ["verdict", "gaps", "assessment"],
				additionalProperties: false,
				properties: {
					verdict: { type: "string", enum: ["sufficient", "continue"] },
					assessment: { type: "string" },
					gaps: {
						type: "array",
						maxItems: 3,
						items: {
							type: "object",
							required: ["question", "why"],
							additionalProperties: false,
							properties: {
								question: { type: "string" },
								why: { type: "string" },
								looked: { type: "string" },
							},
						},
					},
				},
			},
		}),
	);

	const verdict = judge && judge.ok && judge.structuredOutput ? judge.structuredOutput : undefined;
	if (verdict) coverage = String(verdict.assessment || "").slice(0, 400);
	gapRows.push({ key: "coverage", ok: Boolean(judge && judge.ok), structured: Boolean(verdict), verdict: verdict && verdict.verdict });

	const gaps = verdict && verdict.verdict === "continue" && Array.isArray(verdict.gaps)
		? verdict.gaps.filter((gap) => gap && typeof gap.question === "string" && gap.question.trim()).slice(0, 3)
		: [];

	// ── round 2: one targeted searcher per named gap ──────────────────────

	if (gaps.length) {
		emit({ stage: "gap-fill", count: gaps.length });

		const topped = await runs.all(
			gaps.map((gap, index) =>
				child({
					key: "gap-" + (index + 1),
					label: "Close the gap: " + gap.question.slice(0, 60),
					agent: "researcher",
					task: gapTask(gap, index + 1),
					output: findings + "/gap-" + (index + 1) + ".md",
				}),
			),
		);

		topped.forEach((result, index) => {
			gapRows.push({
				key: "gap-" + (index + 1),
				ok: Boolean(result && result.ok),
				runId: result && result.runId,
				file: findings + "/gap-" + (index + 1) + ".md",
			});
		});
	}
}

// ── draft: exactly one writer, one pass ─────────────────────────────────

emit({ stage: "draft" });

const draft = await runs.run(
	"draft",
	child({
		label: "Write the report",
		agent: "worker",
		task: [
			"Write a research report. You are the only writer on this run: every searcher's notes are already on disk",
			"and nobody else will touch the prose. One pass, one voice.",
			"",
			"Read, in this order:",
			"1. " + outdir + "/brief.md — what the report has to answer, and for whom",
			"2. every .md file in " + findings + "/ — the evidence, with numbered sources and verbatim quotes",
			"",
			"RULES",
			"- Answer the brief. If the brief asks a question, the answer is in the first paragraph, not the last.",
			"- Every factual claim carries a citation to a numbered source from the notes, as a link: [title](url).",
			"- Use the verbatim quotes in the notes. Quote only what a searched agent actually copied from the source.",
			"- Where the notes conflict, say so in the report and give both sides. Do not silently pick one.",
			"- Where the notes are thin or a claim was inferred, write that it is inferred or unverified. Never invent a",
			"  number, a date, a quotation or a citation. A missing citation is better than a fabricated one.",
			"- Structure follows the question, not a template: Short answer, then the sections the evidence supports,",
			"  then what remains open. No executive summary of the executive summary, no self-reference, no \"as an AI\".",
			"- Markdown. `##` for top-level sections. Prose by default; lists and tables only where they carry comparison.",
			"- Leave no other files behind: " + outdir + " holds brief.md, findings/, draft.md, audit.md and report.md.",
			"",
			"Write the draft to " + outdir + "/draft.md. The revised report goes to report.md later, by another agent.",
			"Your reply to me: 5 lines max, ending with \"draft written\".",
		].join("\n"),
		output: outdir + "/draft.md",
	}),
);

const draftRow = {
	key: "draft",
	ok: Boolean(draft && draft.ok),
	runId: draft && draft.runId,
	file: outdir + "/draft.md",
	error: draft && !draft.ok ? String(draft.error || "failed").slice(0, 300) : undefined,
};
if (!draftRow.ok) {
	return { stage: "draft", ok: false, error: "draft failed", seekers: seekerRows, gaps: gapRows, draft: draftRow };
}

// ── claim audit: fetch what the draft cites, judge support ──────────────

emit({ stage: "audit" });

const audit = await runs.run(
	"audit",
	child({
		label: "Verify the citations",
		agent: "researcher",
		task: [
			"You are auditing a finished research report, not writing one. The report is at " + outdir + "/draft.md.",
			"The failure you are hunting: a citation that looks valid and does not support the claim attached to it.",
			"",
			"1. Read the report. Pick up to 15 load-bearing claims — the ones the conclusion depends on, plus any",
			"   surprising number, date, quote or comparison. Skip the uncontroversial.",
			"2. For each, take the cited URL and fetch the page yourself:",
			"   curl -sSL --max-time 20 --compressed -A 'Mozilla/5.0' \"<url>\" | sed -e 's/<[^>]*>//g' | tr -s '\\n' | head -400",
			"   Never fetch a PDF. Abandon a URL that runs past 20s.",
			"3. Judge each claim against the page text, not against the report's own wording:",
			"   `supported` — the page states it (quote the passage)",
			"   `partial` — the page implies it or states something weaker",
			"   `contradicted` — the page says otherwise (quote it)",
			"   `absent` — the page exists but does not contain the claim",
			"   `dead` — 404, paywall, timeout, or nothing readable after 20s",
			"4. A claim whose citation is a secondary write-up of a primary source it cites: name the primary source.",
			"",
			"Write " + outdir + "/audit.md:",
			"# Citation audit",
			"## Verdict",
			"one line: <n> of <m> load-bearing claims supported",
			"## Table",
			"| claim | cited source | status | evidence |",
			"## Must fix",
			"numbered list, worst first: what the writer has to change, and to what. Empty list if nothing is wrong.",
			"## Could not check",
			"claims you did not get to, and why.",
			"",
			"Your reply to me: the verdict line, then the must-fix list. 15 lines max.",
		].join("\n"),
		output: outdir + "/audit.md",
	}),
);

const auditRow = {
	key: "audit",
	ok: Boolean(audit && audit.ok),
	runId: audit && audit.runId,
	file: outdir + "/audit.md",
};

// ── revise: fix only what the audit flagged ────────────────────────────

let reviseRow = { key: "revise", ok: false, skipped: true };

if (auditRow.ok) {
	emit({ stage: "revise" });

	const revise = await runs.run(
		"revise",
		child({
			label: "Revise from the audit",
			agent: "worker",
			task: [
				"Revise " + outdir + "/draft.md against " + outdir + "/audit.md.",
				"",
				"- Fix only what the audit's Must fix list names. Leave supported passages alone; do not rewrite for style.",
				"- `contradicted`: correct the claim to what the source says, or remove it. The source wins.",
				"- `partial`: weaken the wording to what the source actually supports, keep the citation.",
				"- `absent` / `dead`: drop the citation and either find the claim in the notes (in " + findings + "/) with a",
				"  source that holds, or mark the claim unverified in place. Do not swap in a different URL you have not read.",
				"- Then re-read the changed lines against their sources. This is the last pass; nothing checks your work after you.",
				"",
				"Keep the report's structure and length. Write the corrected report to " + outdir + "/report.md and",
				"leave draft.md untouched: the audit's line references point at it.",
				"Your reply to me: 8 lines max — what you changed, and what you left unverified.",
			].join("\n"),
			output: outdir + "/report.md",
		}),
	);

	reviseRow = {
		key: "revise",
		ok: Boolean(revise && revise.ok),
		runId: revise && revise.runId,
		file: outdir + "/report.md",
	};
}

return {
	stage: "complete",
	ok: reviseRow.ok || draftRow.ok,
	outdir,
	// the file to hand the user: revised when the revise stage ran, else the draft
	deliverable: reviseRow.ok ? outdir + "/report.md" : outdir + "/draft.md",
	report: outdir + "/report.md",
	audit: outdir + "/audit.md",
	brief: outdir + "/brief.md",
	draftFile: outdir + "/draft.md",
	coverage,
	seekers: seekerRows,
	gaps: gapRows,
	draft: draftRow,
	auditRun: auditRow,
	revise: reviseRow,
};
