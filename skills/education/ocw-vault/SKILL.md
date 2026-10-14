---
name: ocw-vault
description: Unpack OCW course downloads into the Obsidian education vault and keep them wired to the plan. Use when an OCW zip in ~/Downloads should be unpacked, when a course moves to another edition or numbering (e.g. SC migrations), or when a course's local materials, syllabus or links need a refresh.
---

# OCW → vault

Turn an MIT OCW site-mirror zip into a self-study course inside `~/Documents/Notes/education/`: local session materials, one `syllabus.md` linking every session (videos stay external), problem books, exams, and the plan/calendar rows that schedule it. Session, problem-set and exam bullets are checkboxes; rebuilds keep the ticks. Proven on 18.01SC; every new course gets one `CONFIGS` entry, filled from `--inventory` before its first build.

## What a finished course looks like

```
18.01/
├── syllabus.md          # session index — the entry point for daily study
├── sc/                  # unit-N-…/part-…/sN-…/{notes*, problems*, solutions*, *.srt}
├── exams/               # exam1–4 + final, each with -solutions.pdf
├── problem-sets/books/  # problem books + solutions
└── README.md            # status, current position, history
```

Folder/file naming, the zip's anatomy, and per-course adaptation: [REFERENCE.md](REFERENCE.md).

## Steps

1. **Unpack.** Wait until the download finishes (file size stable across two checks), then `unzip -q ~/Downloads/<zip> -d /tmp/<slug>`.
   *Done when:* `pages/`, `resources/` and `static_resources/` exist and `find /tmp/<slug> -type f | wc -l` matches `unzip -l <zip> | tail -1`.

2. **Inventory.** `scripts/ocw_unpack.py --src /tmp/<slug> --course <c> --inventory` — read the tree, the classification buckets, the unmatched PDFs. First run for a course: fill its `CONFIGS` entry ([REFERENCE.md](REFERENCE.md#adding-a-new-course)).
   *Done when:* every session's notes/problems/solutions classify and the bucket samples match what the course pages list.

3. **Build.** Same command without `--inventory` (add `--dst DIR` for a scratch run). Writes `sc/`, `exams/`, `problem-sets/books/`, `syllabus.md`; re-runs skip existing files.
   *Done when:* the run reports ~650 copied files for 18.01-class courses and `sc/` holds one folder per session.

4. **Verify.** `scripts/check_links.py <dst>/syllabus.md`, plus `pdfinfo` on one session note and one exam.
   *Done when:* 0 missing links (run it again after step 5 — the vault docs supply `problem-sets/README.md`) and both PDFs report a title.

5. **Integrate the vault docs.** Course `README.md` (position, status & history), `problem-sets/README.md` (books link), `exams/README.md` (local copies), `education/README.md` caveats, `academic-plan.md` rows.
   *Done when:* each file mentions the local copies and a grep for the old edition's session ranges comes back empty.

6. **Calendar.** Draft the `W#` event edits — title, session list, exam line — and show them to Denis before applying. The calendar is the source of truth and takes edits only after his review.
   *Done when:* approved edits are applied and re-read, or explicitly deferred.

7. **Commit.** Skill or script changes go to pi-setup: commit and push (`skills: …`). The checkout is disposable — anything unpushed is lost on the next refresh.
   *Done when:* `git status` is clean and the commit is pushed.

Switching a course between editions (e.g. 18.01 Fall 2006 → 18.01SC): renumber plan and calendar, map the covered range by topic, archive superseded files under `legacy-<edition>/`. Playbook: [REFERENCE.md](REFERENCE.md#migrating-between-course-editions).
