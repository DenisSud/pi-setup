#!/usr/bin/env bash
# Merge the shareable settings from this repo into ~/.pi/agent/settings.json.
#
# Rules:
#   - Preference keys that already exist in the user's settings are kept
#     (user wins, repo provides defaults).
#   - `packages` is a union: existing entries are preserved, repo entries
#     are added if missing.
#   - auth.json / models.json / models-store.json are never touched.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${PI_SETTINGS:-$HOME/.pi/agent/settings.json}"

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required (nix: nix shell nixpkgs#jq, apt: sudo apt install jq)" >&2
  exit 1
fi

if [[ ! -f "$target" ]]; then
  echo "no settings file at $target, creating it"
  mkdir -p "$(dirname "$target")"
  echo '{}' > "$target"
fi

jq -s '
  .[0] as $repo | .[1] as $user |
  ($user * $repo) as $merged |  # user keys win
  $merged | .packages = (($user.packages // []) + (($repo.packages // []) - ($user.packages // [])))
' "$repo_dir/settings.json" "$target" > "$target.tmp"

mv "$target.tmp" "$target"
echo "merged settings into $target"

# Global context file: pi loads ~/.pi/agent/AGENTS.md in every session.
# Link the repo copy in; never overwrite an existing file (user wins).
if [[ ! -e "$HOME/.pi/agent/AGENTS.md" ]]; then
  ln -s "$repo_dir/global/AGENTS.md" "$HOME/.pi/agent/AGENTS.md"
  echo "linked global/AGENTS.md -> ~/.pi/agent/AGENTS.md"
fi

# Install the package itself (local path — live loading, no ref pinning)
if [[ "${PI_INSTALL_PACKAGE:-1}" == "1" ]]; then
  pi install "$repo_dir"
fi
