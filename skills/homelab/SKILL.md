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
- OS: Samsung 990 EVO Plus 1TB NVMe. Media: 251G ext4 disk image `/home/denis/jellyfin/media.img` mounted at `/home/denis/jellyfin/media` (~49G used, loop device). No external HDD
- Docker v29.4.2 with NVIDIA Container Toolkit
- Dev environments: devenv 2.1.2 (system-wide)

### Network Constraint
UDP tracker ports were historically blocked (Transmission era). Since switching to qBittorrent (Aug 2026) magnets with UDP-only trackers complete fine — no special handling needed.

## Services on RPi

Only 2 services run on the RPi:

### 1. Caddy (system service on RPi)
- Config: `/etc/caddy/Caddyfile`, reload with `sudo systemctl reload caddy`
- Proxies:
  - `sudakov.site` → static files from `/srv/sudakov-site/`
  - `git.sudakov.site` → `127.0.0.1:3000` (Forgejo HTTP)
  - `jellyfin.sudakov.site` → `192.168.1.20:8096` (Jellyfin)

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

### Jellyfin — Docker Compose at `~/jellyfin/compose.yml`
- Exposed at https://jellyfin.sudakov.site (RPi Caddy reverse_proxy → 192.168.1.20:8096); ports 8096 + 8920
- GPU transcoding via NVIDIA RTX 5070
- Mount: `./media:/media:ro` (disk image `media.img`) → host `/home/denis/jellyfin/media`; movies at `media/movies/`
- API key: `REDACTED_JELLYFIN_API_KEY` (only key, named "Jellyseerr"; recover from `config/data/jellyfin.db` `ApiKeys` table if lost)
- Library: Movies only, ID `REDACTED_LIBRARY_ID`, path `/media/movies` (TV library removed)
- **Russia note:** TMDB was blocked in Russia; current Movies library fetchers: TheMovieDb + OMDB (`EnableInternetProviders: false`)
- **Adding mounts** requires `docker compose down && docker compose up -d` (restart isn't enough)

### Marimo — Docker container on PC
- Port: 2718 (not proxied via Caddy)
- Image: `ghcr.io/marimo-team/marimo:latest`
- Container name: `marimo`
- Accessible at `http://192.168.1.20:2718`

### qBittorrent — desktop app on PC
- Installed via `modules/user.nix` (`pkgs.qbittorrent`), launched manually (Transmission daemon removed)
- Downloads land in `~/Videos/Torrents/<Title> [...]/` and `~/Downloads/<Title> [...]/` (save path chosen per download)
- Add magnets: `qbittorrent 'magnet:?xt=...'` or drag into the GUI; UDP trackers work fine

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
/home/denis/jellyfin/media/tv/Show Name/   ← NO year in folder name (no TV library configured yet)
├── Season 01/                    ← zero-padded
│   ├── Show Name S01E01 Title.mkv
│   └── Show Name S01E02 Title.mkv
└── Season 02/
    └── Show Name S02E01 Title.mkv
```

### Movies
```
/home/denis/jellyfin/media/movies/Movie Name (year)/Movie Name (year).mkv
```
One subdirectory per movie — matches the existing library layout.

### Scan trigger
```bash
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
qbittorrent 'MAGNET_URL'   # or drag into the GUI; default save path ~/Videos/Torrents
```

### 3. Monitor download
Watch progress in the qBittorrent GUI. Hard timeout: 3 hours. If incomplete, remove and try the next search result.

### 4. Organize
**TV:** no TV library yet. When it exists: season folders zero-padded ("Season 01"), filenames must have SXXEYY, no year in show folder.

**Movie:** copy to `/home/denis/jellyfin/media/movies/Movie Name (year)/` (one subdir per movie, flat `Movie Name (year).ext` inside).

```bash
# Find downloaded files
find ~/Videos/Torrents ~/Downloads -type f \( -name '*.mkv' -o -name '*.mp4' \)
# Copy to destination, then verify byte size matches source
rsync -a "SOURCE.mkv" "/home/denis/jellyfin/media/movies/Movie Name (2025)/Movie Name (2025).mkv"
# Cleanup (only after the library copy is verified; keep sources of movies not yet added)
rm -rf ~/Videos/Torrents/*
```

### 5. Scan library
```bash
curl -s -X POST -H 'X-MediaBrowser-Token: REDACTED_JELLYFIN_API_KEY' \
  'http://localhost:8096/Library/Refresh?id=REDACTED_LIBRARY_ID'
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Torrent stuck | Check tracker status in qBittorrent; UDP trackers work since Aug 2026 |
| Media image full | `df -h /home/denis/jellyfin/media` — 251G image; when full, grow/recreate `media.img` |
| Metadata not matching | Current Movies library uses TheMovieDb + OMDB fetchers, internet providers disabled |
| New mount not visible | Full recreate: `docker compose down && docker compose up -d` |
| UDP "IPv4 connection failed" | Expected — UDP blocked, HTTP trackers still work |
| Library scan returns 401 | Check API key `REDACTED_JELLYFIN_API_KEY` |
| Empty library after scan | Delete and recreate library (empty-dir watcher bug) |

| Forgejo SSH "Permission denied" | Check key added via `podman exec -u git forgejo forgejo admin user list` and re-add via API |
| Forgejo not starting after reboot | Verify `systemctl --user enable podman-restart --now` on RPi; check `podman ps` |
