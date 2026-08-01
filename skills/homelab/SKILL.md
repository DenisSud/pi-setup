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

### Jellyfin — Docker Compose at `~/jellyfin/compose.yml` (moved from ~/pc-services)
- Port: 8096 (LAN only)
- GPU transcoding via NVIDIA RTX 5070, user 1000:100
- Data: `~/jellyfin/config`, media: `~/jellyfin/media` mounted read-only at `/media` in container
- Movies library root on host: `~/jellyfin/media/movies/` (folder per movie: `Name (year)/Name (year).ext`)
- **API key: `REDACTED_JELLYFIN_API_KEY`** (old key `dfa37c...` is dead → 401). Fresh keys: `sqlite3 ~/jellyfin/config/data/jellyfin.db "SELECT AccessToken FROM ApiKeys;"`
- Library IDs: Movies `REDACTED_LIBRARY_ID`, TV `REDACTED_LIBRARY_ID`
- **Russia note:** TheMovieDB is blocked. Use TheTVDB for metadata, Fanart.tv for images.

### Media stack — Docker Compose at `~/media-stack/compose.yml` (NOT running by default)
- Services: qbittorrent (WebUI 8090), prowlarr, radarr, jellyseerr, byparr; mihomo config dir exists but service is NOT in compose
- Download client is **qBittorrent**, NOT Transmission (Transmission daemon no longer installed)
- Start: `cd ~/media-stack && docker compose up -d <svc>`
- qBittorrent downloads to `~/media-stack/downloads`

### TorrentClaw access from this IP
- **torrentclaw.com is Cloudflare-blocked from this machine's IP** (curl → 000, browser → timeout). Only works via VPN/proxy egress or the `web_fetch` tool
- mihomo (Clash Meta, VLESS+REALITY Lagom VPN proxies) config at `~/media-stack/config/mihomo/config.yaml`; run ad-hoc: `docker run -d --name mihomo --network host -v ~/media-stack/config/mihomo:/config metacubex/mihomo -d /config` → mixed proxy at `localhost:7890` (use `curl -x http://localhost:7890`)
- API key: `REDACTED_TORRENTCLAW_API_KEY`. Via proxy you still get Cloudflare 403 on bare curl — byparr is needed to pass the challenge
- byparr is **FlareSolverr-style**: `POST http://localhost:8191/v1` with `{"cmd":"request.get","url":"..."}` (no custom headers supported → API key auth via header doesn't work through byparr)

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

### Movies
```
~/jellyfin/media/movies/Movie Name (year)/Movie Name (year).ext
```
(folder-per-movie; matches existing convention)

### Scan trigger
```bash
# Movies (get key from jellyfin.db if 401)
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

### 2. Add to qBittorrent
```bash
# Start stack first: cd ~/media-stack && docker compose up -d qbittorrent
# WebUI: http://localhost:8090 (API: POST /api/v2/auth/login, then /api/v2/torrents/add)
curl -s -c /tmp/qb.cookies -d 'username=admin&password=REDACTED' http://localhost:8090/api/v2/auth/login
curl -s -b /tmp/qb.cookies --data-urlencode 'urls=MAGNET_URL' 'http://localhost:8090/api/v2/torrents/add'
```
Downloads land in `~/media-stack/downloads`.

### 3. Monitor download
```bash
curl -s -b /tmp/qb.cookies 'http://localhost:8090/api/v2/torrents/info' | jq '.[] | {name, progress, state, dlspeed}'
```
- Hard timeout: 3 hours. If incomplete, remove and try next result.

### 4. Organize
**TV:** Season folders zero-padded ("Season 01"), filenames must have SXXEYY. Remove year from show folder.

**Movie:** Move into `~/jellyfin/media/movies/Name (year)/Name (year).ext` (folder per movie).

```bash
# Find downloaded files
find ~/media-stack/downloads/ -type f \( -name '*.mkv' -o -name '*.mp4' \)
# Move to library
mkdir -p ~/jellyfin/media/movies/'Movie Name (2025)'
mv '~/media-stack/downloads/path/file.mkv' ~/jellyfin/media/movies/'Movie Name (2025)'/'Movie Name (2025).mkv'
```

### 5. Scan library
```bash
curl -s -X POST -H 'X-MediaBrowser-Token: REDACTED_JELLYFIN_API_KEY' \
  'http://localhost:8096/Library/Refresh?id=REDACTED_LIBRARY_ID'
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| TorrentClaw unreachable (curl → 000 / byparr timeout) | Cloudflare blocks this IP. Egress via mihomo VPN (see TorrentClaw section above); bare curl through proxy still gets 403, byparr browser needed to pass challenge |
| API key 401 on Jellyfin | Get fresh key: `sqlite3 ~/jellyfin/config/data/jellyfin.db "SELECT AccessToken FROM ApiKeys;"` |
| Jellyfin shows 0 series | Switch to TheTVDB in Jellyfin UI (TMDB blocked in Russia) |
| UDP "IPv4 connection failed" | Expected — UDP blocked, HTTP trackers still work |
| Empty library after scan | Delete and recreate library (empty-dir watcher bug) |
| Forgejo SSH "Permission denied" | Check key added via `podman exec -u git forgejo forgejo admin user list` and re-add via API |
| Forgejo not starting after reboot | Verify `systemctl --user enable podman-restart --now` on RPi; check `podman ps` |
