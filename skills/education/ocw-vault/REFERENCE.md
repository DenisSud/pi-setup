# Reference — OCW mirror → Obsidian vault

## The zip mirror

An OCW download is a static mirror of the course site:

| path | holds |
|---|---|
| `pages/**/data.json` | one per page: `title`, `uid`, `parent_uid`, `content_type: "page"`; the directory path mirrors the site URL |
| `resources/*/data.json` | one per resource: `resourcetype` (Video/Document/Image/Other), `file`, `file_type`, `parent_title`, `learning_resource_types`, `video_metadata.youtube_id`, `start_time`, `video_files.video_captions_resources` |
| `static_resources/<32-hex>_<name>` | the payloads; resource `file` fields reference the basename — match by basename, fall back to a `<uid>_*` glob |
| `content_map.json`, `data.json`, `index.html` | site chrome — ignore |

- Resources group by `parent_title`, which always resolves to a page title; page `uid`/`parent_uid` give the tree.
- Roots are the units plus `Syllabus` (18.01SC also has the final-exam page). Unit → `Part …`/`Exam N` children; sessions sit under parts; `Exam N` holds a review session and a materials session.
- Lecture clips share one `youtube_id` with increasing `start_time` — one video header per distinct id, deeplinked with `?t=`.
- Videos are never copied; the script keeps them as YouTube links and only grabs captions (`.srt` preferred, `.vtt` when that is all there is).

## Vault conventions

- `sc/unit-N-<page slug>/<part slug>/s<N>-<page slug>/` — slugs come from the site directories, numbers stay in the folder name.
- Files per session: `notes.pdf`, `problems.pdf`, `solutions.pdf` — merged with `pdfunite` (qpdf fallback) from the lettered source files; superseded lettered files are removed on rebuild. Captions: `lecture.srt` (`lecture-N.srt` when a session has several clips), `video-<title slug>.srt` (`.vtt` only when no `.srt` exists).
- `sessions/sN-<slug>.md` — one progress note per session: `type/session/course/title/unit/part/exam/done` + `video`, `notes`, `problems`, `solutions` wikilinks and a free `## My notes` body. `problem-sets/psN.md` and `exams/eN.md` / `final.md` mirror this for sets and exams (`score` on exams).
- `<course>.base` — Bases dashboard: **Next up** (undone sessions, sorted, limit 6), **Sessions** (grouped by unit, Checked/Unchecked summary per group), **Board** (kanban grouped by `done`, drag to complete), **Exams**, **Problem sets**.
- `exams/`: `examN.pdf` + `examN-solutions.pdf`, `final.pdf` + `final-solutions.pdf`.
- `problem-sets/books/`: `<book>-problems.pdf` / `<book>-solutions.pdf`.
- `syllabus.md`: `#` unit → `##` part (Exam sections included), one bullet per session: OCW page · lecture video(s) · transcripts · notes · problems · solutions; problem-set bullets link the books.
- Session, problem-set and exam bullets are checkboxes (`- [ ]`). The notes are the source of truth: the rebuild unions note `done` with the syllabus boxes and writes both, so a tick anywhere counts — clearing a tick requires clearing it in both places (or asking).
- Doc chain: calendar `W#` events > `academic-plan.md` > course `README.md` > `syllabus.md`.

## Adding a new course

1. Extract the zip; run `--inventory`. The report shows the page tree, which files match each pattern, and what stays unmatched — the shape you need for the config.
2. Open two or three `resources/*/data.json` plus the buckets' samples, then fill the `CONFIGS` entry: `folder`, `url`, `syllabus_title/heading`, `note_res`, `problem_re`, `book_re`, `exam_re`, `final_title`, `units`, `books`, `exam_ranges` (session ranges per exam, reviews included), `vault_prefix`, `folder_fix`. Builds need `pdfunite` (poppler) or `qpdf` on PATH.
3. Run against a scratch `--dst`, compare file counts and spot-check the syllabus; then build for real.

## Quirks seen so far

- The 32-hex prefix on `static_resources` names must be stripped before pattern matching.
- Caption folders can appear duplicated (`…8Z-s6Tuvc-1/`); the copies are identical — first match wins.
- "Materials for Exam N" sessions hold the exam PDF; the review sessions hold notes only.
- The final exam hides on its own root page (18.01SC: `Session 102: Materials for Final Exam`), matched per course by `final_title`.
- A page slug can lack its session number (18.01SC's exam-3 review) — fix with `folder_fix`.
- Some source PDFs carry xref defects; poppler warns while merging but the merged file still opens.
- Transcript PDFs, thumbnails, mathlets and HTML are deliberately left out; the syllabus links the OCW page and YouTube instead.

## Migrating between course editions

The failure mode this fixes: a half-migrated vault (plan/calendar on the old edition, course docs and materials on the new one) — what happened with 18.01 before Oct 14, 2026.

1. Build the new edition first (steps 1–4 of the skill), so the vault gains its materials before anything renumbers.
2. Map the covered range by topic, not by number — 18.01: old recitation 0 + lectures 1–5 = SC s1–15. Write the mapping down; it goes into the course README's status.
3. Rewrite `academic-plan.md` rows: new session ranges, PS numbers by their books, exam coverage ranges.
4. Draft the calendar `W#` edits for review, apply after approval — titles (`Calc1 s…+E#`), session lists, exam lines.
5. Archive superseded artifacts into `legacy-<edition>/` with a README saying what they are and why they stay.
6. Course README: add the status & history entry and update the current position (which session W2 resumes at).
7. Sweep for the old numbering — plan, calendar, READMEs, syllabus.

*Done when:* no old-edition session number survives anywhere and progress lands in the same topic under the new edition's numbering.
