---
name: homelab
description: Homelab infrastructure (RPi + PC), Jellyfin media server, torrent search/download via TorrentClaw, and end-to-end media pipeline. Use when working with homelab services, searching/downloading media, organizing for Jellyfin, or troubleshooting.
---

# Homelab

Two-machine setup: RPi (192.168.1.6) for proxy + Forgejo, PC (192.168.1.20) for media/LLM.

## Access & Infrastructure

| Machine | LAN | WAN | Sudo |
|---------|-----|-----|------|
| RPi | `ssh denis@192.168.1.6` | `REDACTED_WAN_IP:2222` | passwordless |
| PC | `ssh denis@192.168.1.20` | `REDACTED_WAN_IP:4096` | password `REDACTED` |

### SSH Config (`~/.ssh/config`)
```ssh-config
# Forgejo — local access via RPi port 2223
Host git.sudakov.site
  Hostname 192.168.1.6
  Port 2223
  User git
  IdentityFile ~/.ssh/id_ed25519
  StrictHostKeyChecking accept-new

# RPi — local
Host 192.168.1.6
  Port 22
  User denis
  IdentityFile ~/.ssh/id_ed25519
  StrictHostKeyChecking accept-new

# RPi — WAN
Host pi.wan
  Hostname REDACTED_WAN_IP
  Port 2222
  User denis
  IdentityFile ~/.ssh/id_ed25519
  StrictHostKeyChecking accept-new

# PC — local
Host 192.168.1.20
  Port 22
  User denis
  IdentityFile ~/.ssh/id_ed25519
  StrictHostKeyChecking accept-new

# PC — WAN
Host pc.wan
  Hostname REDACTED_WAN_IP
  Port 4096
  User denis
  IdentityFile ~/.ssh/id_ed25519
  StrictHostKeyChecking accept-new
```

### PC Hardware
- NixOS 26.11 (Zokar), 32GB DDR5, AMD Ryzen 5 9600X (6C/12T)
- GPU: NVIDIA RTX 5070 (12GB, CUDA 13.2, driver 595.84)
- OS: Samsung 990 EVO Plus 1TB NVMe. Media: WD40NPZZ 3.6TB NTFS at `/mnt/media` (read-only by default)
- Docker v29.4.2 with NVIDIA Container Toolkit
- Dev environments: devenv 2.1.2 (system-wide)

### Network Constraint
**UDP tracker ports are blocked.** Only HTTP trackers work for torrents. The TorrentClaw HTTP tracker (`http://tracker.torrentclaw.com:6969/announce`) works fine.

## Services on RPi

Only 2 services run on the RPi:

### 1. Caddy (system service on RPi)
- Config: `/etc/caddy/Caddyfile`, reload with `sudo systemctl reload caddy`
- Proxies:
  - `sudakov.site` → static files from `/srv/sudakov-site/`
  - `git.sudakov.site` → `127.0.0.1:3000` (Forgejo HTTP)

### 2. Forgejo (podman-compose on RPi)
- Location: `/home/denis/forgejo/`
- Compose file: `/home/denis/forgejo/compose.yml`
- Container: `codeberg.org/forgejo/forgejo:15`
- HTTP: `127.0.0.1:3000` (proxied via Caddy at `git.sudakov.site`)
- SSH: `192.168.1.6:2223` (mapped to container port 22)
- Data: `/home/denis/forgejo/data/`
- App config: `/home/denis/forgejo/data/gitea/conf/app.ini`
- Managed by podman (rootless), podman-restart enabled for auto-start on boot
- Restart: `cd /home/denis/forgejo && podman-compose up -d`

```bash
# Forgejo management
cd /home/denis/forgejo && podman-compose up -d      # Start
cd /home/denis/forgejo && podman-compose down        # Stop
podman logs forgejo                                  # Logs
podman exec -u git forgejo forgejo admin user list   # List users
```

**Forgejo SSH setup:**
- SSH key added to `DenisSud` user via API/CLI
- SSH access works without token: `git clone git@git.sudakov.site:DenisSud/repo.git`
- From outside LAN: SSH clone works via `ssh://git@git.sudakov.site:2223/...` (requires port 2223 forwarded on router)
- HTTPS clone always works: `https://git.sudakov.site/DenisSud/repo.git`

## Services on PC

### Jellyfin — Docker Compose at `~/pc-services/jellyfin/compose.yml`
- Port: 8096 (no longer proxied via Caddy — accessible on LAN only or via VPN/tunnel)
- GPU transcoding via NVIDIA RTX 5070
- Mounts: `/mnt/media/Movies:/media/movies:ro`, `/mnt/media/TV:/media/tv:ro`, `/home/denis/Videos/Movies:/media/videos:ro`, `/home/denis/Videos/TV_Shows:/media/tv_shows:ro`
- API key: `REDACTED_JELLYFIN_API_KEY`
- Library IDs: Movies `REDACTED_LIBRARY_ID`, TV `REDACTED_LIBRARY_ID`
- **Russia note:** TheMovieDB is blocked. Use TheTVDB for metadata, Fanart.tv for images.
- **Adding mounts** requires `docker compose down && docker compose up -d` (restart isn't enough)

### Marimo — Docker container on PC
- Port: 2718 (not proxied via Caddy)
- Image: `ghcr.io/marimo-team/marimo:latest`
- Container name: `marimo`
- Accessible at `http://192.168.1.20:2718`

### Transmission — system-level daemon on PC
- User: `denis` (override in `/etc/systemd/system/transmission-daemon.service.d/override.conf`)
- Download dir: `/home/denis/Downloads/media/` (fast NVMe)
- Use `sudo systemctl restart transmission-daemon` (NOT `--user`)
- Quick commands: `transmission-remote -l` (list), `transmission-remote -a 'MAGNET' -w /home/denis/Downloads/media` (add)

### Ollama — DISABLED (2026-07-28)
- Service is masked. Model data at `/var/lib/ollama/models` remains.
- To re-enable: `sudo systemctl unmask ollama && sudo systemctl start ollama`

## TorrentClaw API

Base: `https://torrentclaw.com/api/v1/search`. API key: `REDACTED_TORRENTCLAW_API_KEY` (free tier, 120 req/min).

```bash
curl -s -G -H "x-search-source: skill" \
  --data-urlencode "q=QUERY" \
  -d "sort=seeders" -d "limit=5" \
  "https://torrentclaw.com/api/v1/search"
```

Key filters: `type=movie|show`, `quality=1080p|2160p|720p`, `year_min=2020&year_max=2025`, `season=1`, `episode=5`, `lang=en|ru|es`.

Response gives `results[].torrents[]` with `magnetUrl`, `infoHash`, `qualityScore` (0-100), `seeders`, `sizeBytes`. Pick highest `qualityScore`.

## Media Organization for Jellyfin

### TV Shows
```
/mnt/media/TV/Show Name/          ← NO year in folder name
├── Season 01/                    ← zero-padded
│   ├── Show Name S01E01 Title.mkv
│   └── Show Name S01E02 Title.mkv
└── Season 02/
    └── Show Name S02E01 Title.mkv
```

### Movies
```
/mnt/media/Movies/Movie Name (year).mkv
```

### Scan trigger
```bash
# Movies
curl -s -X POST -H 'X-MediaBrowser-Token: REDACTED_JELLYFIN_API_KEY' \
  'http://localhost:8096/Library/Refresh?id=REDACTED_LIBRARY_ID'
# TV
curl -s -X POST -H 'X-MediaBrowser-Token: REDACTED_JELLYFIN_API_KEY' \
  'http://localhost:8096/Library/Refresh?id=REDACTED_LIBRARY_ID'
```

## Media Pipeline Workflow

### 1. Search TorrentClaw
```bash
ssh denis@192.168.1.20 "curl -s -G -H 'x-search-source: skill' \
  --data-urlencode 'q=Show Name S01E05' -d 'sort=seeders' -d 'limit=5' \
  'https://torrentclaw.com/api/v1/search'"
```
Pick highest `qualityScore` torrent. For season packs, `season` matches and `episode` is `null`.

### 2. Add to Transmission
```bash
ssh denis@192.168.1.20 "transmission-remote -a 'MAGNET_URL' -w /home/denis/Downloads/media"
```

### 3. Monitor download
```bash
ssh denis@192.168.1.20 "transmission-remote -l"
ssh denis@192.168.1.20 "transmission-remote -t 1 -i | grep -E 'State|Percent|Speed|ETA'"
```
- If "Idle" >30s: check tracker status with `-it`, verify HTTP tracker reachable
- Hard timeout: 3 hours. If incomplete, remove and try next result.

### 4. Organize
**TV:** Find files → organize on NVMe → batch-copy to external. Season folders zero-padded ("Season 01"), filenames must have SXXEYY. Remove year from show folder.

**Movie:** Copy to `/mnt/media/Movies/Name (year).ext` or `/home/denis/Videos/Movies/` for custom mount.

```bash
# Find downloaded files
ssh denis@192.168.1.20 "find /home/denis/Downloads/media/ -type f \( -name '*.mkv' -o -name '*.mp4' \)"
# Copy to destination
ssh denis@192.168.1.20 "cp '/home/denis/Downloads/media/path/file.mkv' '/mnt/media/Movies/Movie Name (2025).mkv'"
# Cleanup
ssh denis@192.168.1.20 "rm -rf /home/denis/Downloads/media/*"
```

### 5. Stop seeding + scan
```bash
ssh denis@192.168.1.20 "transmission-remote -t ID --stop && transmission-remote -t ID --remove"
ssh denis@192.168.1.20 'curl -s -X POST -H "X-MediaBrowser-Token: REDACTED_JELLYFIN_API_KEY" "http://localhost:8096/Library/Refresh?id=REDACTED_LIBRARY_ID"'
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Torrent stays "Idle" | Re-add with HTTP trackers only; check `curl http://tracker.torrentclaw.com:6969` |
| "Permission denied" in daemon logs | Re-run Transmission setup; ensure User=denis override |
| External drive read-only | `sudo mount -o remount,rw /mnt/media` (stop Jellyfin first) |
| Jellyfin shows 0 series | Switch to TheTVDB in Jellyfin UI (TMDB blocked in Russia) |
| New mount not visible | Full recreate: `docker compose down && docker compose up -d` |
| UDP "IPv4 connection failed" | Expected — UDP blocked, HTTP trackers still work |
| Library scan returns 401 | Check API key `REDACTED_JELLYFIN_API_KEY` |
| Empty library after scan | Delete and recreate library (empty-dir watcher bug) |
| `transmission-remote -tr` crashes | Known bug in 4.1.0-beta.2, avoid `-tr` |
| Forgejo SSH "Permission denied" | Check key added via `podman exec -u git forgejo forgejo admin user list` and re-add via API |
| Forgejo not starting after reboot | Verify `systemctl --user enable podman-restart --now` on RPi; check `podman ps` |
