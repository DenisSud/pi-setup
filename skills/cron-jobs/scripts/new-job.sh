#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $(basename "$0") <name> \"<schedule>\" [flake|devenv]" >&2
  exit 1
}

[ $# -ge 2 ] || usage
name="$1"
schedule="$2"
tier="${3:-flake}"
[ "$tier" = flake ] || [ "$tier" = devenv ] || usage

[[ "$name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || {
  echo "error: name must be lowercase a-z0-9 with hyphens" >&2
  exit 1
}

systemd-analyze calendar "$schedule" >/dev/null 2>&1 || {
  echo "error: invalid schedule: $schedule (try: systemd-analyze calendar \"...\")" >&2
  exit 1
}

jobs_dir="${XDG_DATA_HOME:-$HOME/.local/share}/cronjobs"
job_dir="$jobs_dir/$name"
units_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$job_dir" "$units_dir"

cat > "$units_dir/$name.service" <<EOF
[Unit]
Description=Cron job: $name

[Service]
Type=oneshot
ExecStart=%h/.local/share/cronjobs/$name/run.sh

[Install]
WantedBy=default.target
EOF

cat > "$units_dir/$name.timer" <<EOF
[Unit]
Description=Cron timer: $name

[Timer]
OnCalendar=$schedule
Persistent=true

[Install]
WantedBy=timers.target
EOF

if [ "$tier" = devenv ]; then
  cat > "$job_dir/run.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
export CI=1
# TODO: point at the project that does the work:
# cd /home/denis/dev/<project>
exec /run/current-system/sw/bin/devenv shell run
EOF
else
  cat > "$job_dir/run.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec /run/current-system/sw/bin/nix run "path:$HOME/.local/share/cronjobs/$name" --no-write-lock-file
EOF
fi
chmod +x "$job_dir/run.sh"

systemctl --user daemon-reload

echo "created: $job_dir"
echo "units:   $units_dir/$name.service  $units_dir/$name.timer"
echo
systemd-analyze calendar "$schedule"
echo
echo "next steps:"
echo "  1. write the job (see SKILL.md tier templates; tier: $tier)"
echo "  2. test:  systemctl --user start $name.service"
echo "  3. check: journalctl --user -u $name.service -n 30"
echo "  4. enable: systemctl --user enable --now $name.timer"
