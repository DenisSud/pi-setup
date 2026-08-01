---
name: cron-jobs
description: |
  Cron jobs on Linux: schedules a bash entry point (run.sh) via systemd user
  timers. Two tiers — Tier 1: simple bash scripts as Nix flake apps
  (writeShellApplication: pinned deps, build-time shellcheck); Tier 2: real
  projects (uv/Python, existing ~/dev projects) run via their devenv `run`
  script. Creates job dir + service/timer units, validates schedules with
  systemd-analyze, enables and verifies. Use when the user wants a cron job,
  periodic/recurring script, "run every hour/day/week/month", or any
  systemd-timer-driven job.
---

# Cron Jobs

A cron job = a job directory + a bash entry point `run.sh` + two systemd user
units (service + timer). Every job, in both tiers, is executed by calling its
`run.sh`. The timer fires, systemd runs `run.sh`, `run.sh` does the work (or
execs the flake app / devenv script that does).

## Step 1 — Pick the tier (always, first)

| | **Tier 1 — flake app** | **Tier 2 — devenv project** |
|---|---|---|
| Job is… | a bash script needing a few packages (git, jq, curl, pi…) | real code: uv/Python deps, a multi-file app, or an existing project |
| Deps from | nixpkgs (`runtimeInputs`) | PyPI via uv, nixpkgs via devenv.nix |
| Executed as | `nix run path:<jobdir>#<name>` — hermetic, shellchecked at build | `devenv shell run` in the project — flexible, GC-protected |
| When the job lives in | its own job dir | an existing project dir (e.g. ~/dev/<proj>) — no duplication |

**Rule: script → Tier 1, project → Tier 2.** If the job needs PyPI packages,
or is more than one file of logic, it is Tier 2. If it's a script plus a few
tools, it is Tier 1.

## Steps

1. **Tier** — decide per the table above.
2. **Scaffold** — run `scripts/new-job.sh <name> "<schedule>" [devenv]` from
   this skill's directory. It validates the name (lowercase-hyphen) and the
   schedule with `systemd-analyze calendar`, creates
   `~/.local/share/cronjobs/<name>/` with a `run.sh` stub, writes
   `~/.config/systemd/user/<name>.{service,timer}`, reloads systemd, and
   prints the next fire time. Pass `devenv` as the third arg for a Tier 2
   stub. Do not enable anything yet.
3. **Write the job** — per the tier template below. The unit never changes;
   all tier differences live in `run.sh`.
4. **Test once, manually** — `systemctl --user start <name>.service`, then
   `journalctl --user -u <name>.service -n 30`. Completion criterion: the
   run reports `Success` (exit 0) with no errors. For Tier 1 this is the first
   build — shellcheck failures surface here, not at 09:00.
5. **Enable** — `systemctl --user enable --now <name>.timer`, then verify:
   `systemctl --user list-timers` shows the job with the expected NEXT elapse.

## Rules (non-negotiable)

- **Job dir is a plain directory, never a git repo.** A flake inside a git
  repo only sees git-indexed files — an untracked script is invisible to the
  timer, which then silently runs stale code. (Verified: Nix manual, flake
  references.)
- `run.sh` uses `set -euo pipefail` and **absolute binary paths** — systemd
  units do not inherit your shell PATH. `HOME` is set in user units.
- Never let the timer mutate locks: flake runs carry `--no-write-lock-file`;
  never run `devenv update` from a job.
- Timers only fire while you are logged in. If a job must run headless,
  `loginctl enable-linger` first (one-time, note in the job dir).
- Jobs that spawn pi agents: follow the subagents skill (fixed
  `opencode-go/deepseek-v4-flash` model, `--print`, least-privilege tools,
  own `--session-dir`).

## Tier 1 — flake app template

Job dir:

```
~/.local/share/cronjobs/<name>/
    run.sh      # exec nix run (written by scaffold; path is correct already)
    flake.nix   # you write this
    flake.lock  # generated: nix flake lock
```

`flake.nix`:

```nix
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      apps.${system}.default = {
        type = "app";
        program = "${pkgs.writeShellApplication {
          name = "<name>";
          runtimeInputs = [ pkgs.git ];   # every tool the script needs
          text = ''
            # job body — bash, set -euo pipefail already applied
            # writeShellApplication: shellcheck + bash -n at build time
          '';
        }}/bin/<name>";
      };
    };
}
```

Then `cd ~/.local/share/cronjobs/<name> && nix flake lock` (needs network
once). Everything the script needs must be in `runtimeInputs` — do not rely
on the ambient system. Note: the app is a bash script, so the
"bash entry point" rule holds inside the flake too.

## Tier 2 — devenv project template

Job dir:

```
~/.local/share/cronjobs/<name>/
    run.sh      # cd <project> && exec devenv shell run
```

`run.sh` (fill the TODO):

```bash
#!/usr/bin/env bash
set -euo pipefail
export CI=1                      # disables the devenv TUI (clean journal logs)
cd /home/denis/dev/<project>     # TODO: the project that does the work
exec /run/current-system/sw/bin/devenv shell run
```

- The project itself is a normal devenv project — create new ones in
  `~/dev/` following the devenv-nix skill (it already standardizes the `run`
  script), or reuse an existing one. The cron job adds nothing to it; the job
  is just `devenv shell run`.
- `devenv shell <cmd>` runs one command non-interactively (official CI
  pattern). `run` is the project's `scripts.run` entry; a task works too:
  `devenv tasks run <name>` (tasks support `execIfModified` — skip work when
  inputs are unchanged).
- First manual test run builds the devenv shell (can take minutes; needs
  network). Subsequent runs are fast and GC-protected.

## Reference

### Schedules (systemd OnCalendar)

| Want | Schedule |
|---|---|
| Daily 09:00 | `*-*-* 09:00:00` |
| Hourly | `hourly` |
| Every 5 minutes | `*:0/5` |
| Weekly, Mon 09:00 | `Mon *-*-* 09:00:00` |
| Monthly, 1st, 03:00 | `*-*-01 03:00:00` |
| Yearly | `yearly` |

Validate or explore any expression: `systemd-analyze calendar "<expr>"` —
prints the normalized form and next elapse.

### Lifecycle

```bash
systemctl --user list-timers                              # all jobs + next fire
systemctl --user start <name>.service                     # run now (test)
journalctl --user -u <name>.service -n 50                 # last run's log
journalctl --user -u <name>.service -f                    # follow
systemctl --user stop <name>.timer                        # pause
systemctl --user start <name>.timer                       # resume
# reschedule: edit ~/.config/systemd/user/<name>.timer, then:
systemctl --user daemon-reload
# remove:
systemctl --user disable --now <name>.timer
rm ~/.config/systemd/user/<name>.service ~/.config/systemd/user/<name>.timer
rm -rf ~/.local/share/cronjobs/<name>
systemctl --user daemon-reload
```
