#!/usr/bin/env bash
# Install this checkout on this machine:
#   - merges settings.json into ~/.pi/agent/settings.json (user keys win)
#   - installs this checkout as a pi package (base extensions + skills)
#   - links the bot tools: ~/.pi/agent/bin/pi-bot{,-new}, ~/.config/fish/functions/pi.fish
#   - creates the bots root (~/Bots) if it is missing
#
# The base rules (global/AGENTS.md) are injected into every agent's system
# prompt by the house-rules extension, so nothing is linked into
# ~/.pi/agent/AGENTS.md anymore — an old link from a previous install is
# removed if it points back into this checkout.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${PI_SETTINGS:-$HOME/.pi/agent/settings.json}"
bots_home="${PI_BOTS_HOME:-$HOME/Bots}"

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
  ($repo * $user) as $merged |  # jq * gives the right operand precedence: user keys win
  $merged | .packages = (($user.packages // []) + (($repo.packages // []) - ($user.packages // [])))
' "$repo_dir/settings.json" "$target" > "$target.tmp"

mv "$target.tmp" "$target"
echo "merged settings into $target"

# Retire the old global-context link: house-rules owns those rules now.
link="$HOME/.pi/agent/AGENTS.md"
if [[ -L "$link" ]] && [[ "$(readlink -f "$link")" == "$repo_dir/global/AGENTS.md" ]]; then
  rm "$link"
  echo "removed old link $link (base rules now injected by house-rules)"
fi

# Install the package itself (local path — live loading, no ref pinning)
if [[ "${PI_INSTALL_PACKAGE:-1}" == "1" ]]; then
  pi install "$repo_dir"
fi

# Bot tooling: pi --bot <name> (fish) and pi-bot <name> (scripts, cron).
mkdir -p "$HOME/.pi/agent/bin" "$HOME/.config/fish/functions" "$bots_home"
ln -sfn "$repo_dir/bin/pi-bot" "$HOME/.pi/agent/bin/pi-bot"
ln -sfn "$repo_dir/bin/pi-bot-new" "$HOME/.pi/agent/bin/pi-bot-new"
ln -sfn "$repo_dir/fish/pi.fish" "$HOME/.config/fish/functions/pi.fish"
echo "linked bot tooling (pi-bot, pi-bot-new, pi --bot <name>)"

# pi only puts ~/.pi/agent/bin on PATH for the processes it spawns, so the
# wrappers stay invisible in a fresh terminal unless the shell rc adds the
# dir. Idempotent; skip with PI_NO_SHELL_RC=1.
if [[ "${PI_NO_SHELL_RC:-0}" != "1" ]]; then
  if [[ -f "$HOME/.zshrc" ]] && ! grep -qF '.pi/agent/bin' "$HOME/.zshrc"; then
    printf '\n# pi bot tooling (link: %s/install.sh)\nexport PATH="$HOME/.pi/agent/bin:$PATH"\n' "$repo_dir" >> "$HOME/.zshrc"
    echo "added ~/.pi/agent/bin to PATH in ~/.zshrc"
  fi
  if [[ -d "$HOME/.config/fish" ]] && ! grep -rqF '.pi/agent/bin' "$HOME/.config/fish" 2>/dev/null; then
    printf '# pi bot tooling (link: %s/install.sh)\nfish_add_path --prepend "$HOME/.pi/agent/bin"\n' "$repo_dir" > "$HOME/.config/fish/conf.d/pi-bots.fish"
    echo "added ~/.pi/agent/bin to PATH in fish (conf.d/pi-bots.fish)"
  fi
fi

found=0
for d in "$bots_home"/*/; do
  [[ -f "$d/settings.json" ]] || continue
  found=1
  echo "  bot: $(basename "$d")"
done
if [[ "$found" == 0 ]]; then
  echo "  no bots in $bots_home yet — create one with: pi-bot new <name>"
fi
