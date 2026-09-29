{
  pkgs,
  lib,
  config,
  inputs,
  ...
}:

let
  # web_fetch extractors. The web-search test runner falls back to a bare
  # `nix shell nixpkgs#…` when these are missing; shipping them here keeps the
  # shell self-contained so the harness runs without that detour.
  extractors = with pkgs; [
    python3Packages.trafilatura # HTML
    poppler-utils # pdftotext
    pandoc # fallback extractor
  ];
in
{
  # ── Toolchain ───────────────────────────────────────────────────────
  # Node runs the extension harnesses, the connector (native TS type
  # stripping) and the web bundle; bun owns installs, workspaces and the
  # package scripts.
  #
  # Deliberately NOT languages.javascript: it prepends node_modules/.bin to
  # PATH, where bun's auto-installed peer @earendil-works/pi-coding-agent
  # shadows the system `pi`. That npm bundle has no monorepo store layout, so
  # extensions/*/test/run.sh can no longer resolve the pi store. Plain
  # packages keep the installed pi authoritative; the install task below
  # still keeps node_modules in sync with bun.lock.
  packages = [
    pkgs.nodejs_24 # >= 23.6: native TS type stripping
    pkgs.bun
    pkgs.git # commit/push from the shell
    pkgs.jq # install.sh and pi-bot-new refuse to run without it
    pkgs.fish # `lint` syntax-checks fish/pi.fish
    pkgs.curl # bridge smoke tests, doctor's SearXNG probe
    pkgs.shellcheck # `lint`
    pkgs.watchexec # `web-watch`
  ] ++ extractors;

  # ── `devenv shell` setup ────────────────────────────────────────────
  # bun install only when bun.lock (or bun itself) changed.
  tasks."pi-bots:install".exec = ''
    set -euo pipefail
    cd "$DEVENV_ROOT"
    stamp="node_modules/.pi-bots-lock"
    want="$(sha256sum bun.lock | cut -d' ' -f1)"
    if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$want" ]; then
      echo "pi-bots: bun install (bun.lock changed)"
      bun install --frozen-lockfile
      printf '%s\n' "$want" > "$stamp"
    fi
  '';
  tasks."devenv:enterShell".after = [ "pi-bots:install" ];

  # ── Commands ────────────────────────────────────────────────────────
  # `devenv info` lists these; the shell puts them on PATH.
  scripts = {
    check = {
      description = "All tests: connector suite + every extension harness";
      exec = ''
        set -euo pipefail
        cd "$DEVENV_ROOT"
        echo "== connector tests =="
        bun run test
        exec test-ext
      '';
    };

    test-ext = {
      description = "Extension harnesses: all, or `test-ext <name…>` for some";
      exec = ''
        set -euo pipefail
        cd "$DEVENV_ROOT"
        runners=()
        if [ "$#" -gt 0 ]; then
          for name in "$@"; do
            runners+=("extensions/$name/test/run.sh")
          done
        else
          runners=(extensions/*/test/run.sh)
        fi
        for runner in "''${runners[@]}"; do
          echo "== $runner =="
          "$runner" harness
        done
      '';
    };

    test-connector = {
      description = "Connector unit tests (node --test, no network)";
      exec = ''
        cd "$DEVENV_ROOT"
        exec bun run test
      '';
    };

    test-web-search-live = {
      description = "web-search live test (needs the local SearXNG service)";
      exec = ''
        cd "$DEVENV_ROOT"
        exec extensions/web-search/test/run.sh live
      '';
    };

    build = {
      description = "Bundle the web app into packages/web/dist";
      exec = ''
        cd "$DEVENV_ROOT"
        exec bun run build
      '';
    };

    web = {
      description = "Serve the built web app + bridge on 127.0.0.1:8787";
      exec = ''
        cd "$DEVENV_ROOT"
        exec bin/pi-bots-web "$@"
      '';
    };

    web-watch = {
      description = "Rebuild the web bundle while packages/web/src changes";
      exec = ''
        cd "$DEVENV_ROOT"
        exec watchexec --no-shell --watch packages/web/src --exts ts,css,html -- bun run build
      '';
    };

    bot = {
      description = "This checkout's pi-bot (local connector source)";
      exec = ''
        cd "$DEVENV_ROOT"
        exec bin/pi-bot "$@"
      '';
    };

    lint = {
      description = "shellcheck the shell entrypoints, syntax-check the fish function";
      exec = ''
        cd "$DEVENV_ROOT"
        shellcheck -S warning \
          bin/pi-bot bin/pi-bot-new bin/pi-bots-web install.sh \
          extensions/*/test/run.sh
        fish -n fish/pi.fish
        echo "lint clean"
      '';
    };

    install-base = {
      description = "Run ./install.sh: settings merge, pi install, tool links";
      exec = ''
        cd "$DEVENV_ROOT"
        exec ./install.sh "$@"
      '';
    };

    doctor = {
      description = "Check pi, the pi source checkout, bots root and SearXNG";
      exec = ''
        set -u
        echo "node       $(node --version)  ($(command -v node))"
        echo "bun        $(bun --version)"
        echo "jq         $(jq --version)"

        pi_bin="$(command -v pi || true)"
        if [ -n "$pi_bin" ]; then
          pi_version="$("$pi_bin" --version 2>/dev/null | head -n1)"
          echo "pi         $pi_version  ($pi_bin)"
        else
          echo "pi         MISSING — extensions/*/test/run.sh resolves the pi store from it"
        fi

        src="''${PI_SOURCE_DIR:-$HOME/dev/pi}"
        if [ -f "$src/pi-test.sh" ]; then
          echo "pi source  $src"
        else
          echo "pi source  MISSING at $src — bots and the web bundle need the checkout"
        fi

        bots="''${PI_BOTS_HOME:-$HOME/Bots}"
        if [ -d "$bots" ]; then
          echo "bots       $bots ($(find "$bots" -mindepth 2 -maxdepth 2 -name settings.json | wc -l) found)"
        else
          echo "bots       $bots missing — create one with: pi-bot new <name>"
        fi

        searx="''${SEARXNG_BASE_URL:-http://127.0.0.1:8888}"
        if curl -fsS -m 2 -o /dev/null "$searx"; then
          echo "searxng    $searx"
        else
          echo "searxng    $searx unreachable (harness runs offline; live tests need it)"
        fi
      '';
    };
  };

  # ── `devenv up` ─────────────────────────────────────────────────────
  # Builds the web bundle (needs $PI_SOURCE_DIR) and serves it with the bridge.
  processes.web.exec = ''
    cd ${config.devenv.root}
    bun run build
    exec bin/pi-bots-web
  '';

  enterShell = ''
    echo "pi-bots devenv — node $(node --version), bun $(bun --version)"
    echo "commands: check · test-ext · build · web · bot <name> · doctor   (devenv info)"
  '';

  # `devenv test` — connector suite + every extension harness.
  enterTest = ''
    set -euo pipefail
    cd "$DEVENV_ROOT"
    bun run test
    for runner in extensions/*/test/run.sh; do
      echo "== $runner =="
      "$runner" harness
    done
  '';

  # Full option reference: https://devenv.sh/reference/options/
}
