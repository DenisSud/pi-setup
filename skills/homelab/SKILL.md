---
name: homelab
description: Working on Denis's homelab — services, media pipeline, torrents, troubleshooting. Use when the user mentions homelab services (Jellyfin, Forgejo, Caddy, qBittorrent), searching/downloading media, organizing for Jellyfin, or homelab troubleshooting.
---

# Homelab

This skill describes how to find homelab information and how to act. It deliberately contains **no facts** — no IPs, ports, credentials, or service locations.

## 1. Find the facts first

The single source of truth is the memory note `knowledge/homelab.md` in `/home/denis/.pi/agent/memory/`. Read it **before** running any homelab command. It has: machines and SSH access, PC and RPi services, API keys, media layout, and a troubleshooting table.

If the note doesn't cover what you need, discover it read-only on the target machine:
- `systemctl` / `systemctl --user` status, `podman ps`, `docker ps` for running services
- `/etc/caddy/Caddyfile` on the RPi, `~/jellyfin/compose.yml` on the PC for configs
- `~/.ssh/config` for host aliases

If you learn a new durable fact (changed IP, new service, rotated key), **write it back** to `knowledge/homelab.md` and commit/push the memory repo. Facts must live there, not in session output.

## 2. How to act

- **No breaking changes.** Don't stop, recreate, or reconfigure services unless the task requires it. Prefer reloads over restarts, restarts over recreates; know the difference (`docker compose restart` vs `down && up -d`) and check the memory note for service-specific caveats.
- **Follow established conventions.** Mirror how existing services are run on that machine (system service vs podman-compose vs docker compose vs NixOS module). Don't introduce a new deployment pattern for one task.
- **Clean up after yourself.** Remove temp files, downloaded-but-unwanted files, and test containers/keypairs you created. Delete downloaded media only after the library copy is verified.
- **Read-only diagnosis first.** Investigate with logs and status checks (`journalctl`, `podman logs`, `systemctl status`) before changing anything.
- **Verify after changes.** Confirm the service actually works (curl the endpoint, check the library scan result, test the SSH clone) — a successful command isn't the same as a working service.
- **Secrets stay out of notes.** Credential values live in Bitwarden (folder `pi`) and reach a command only through the bash tool's `secrets` parameter — e.g. `bash { command: 'curl -H "X-MediaBrowser-Token: $JELLYFIN_API_KEY" http://localhost:8096/System/Info', secrets: "jellyfin" }` (profiles: `jellyfin`, `forgejo`, `ollama`, `books`; ptc: `secrets_sh`). Never print, copy, or write values into notes, files, commits, or chat replies.
