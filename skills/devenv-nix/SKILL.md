---
name: devenv-nix
description: Use when creating, editing, or reviewing a devenv.nix setup, or when asked about Denis's devenv standards.
---

# devenv.nix standards

Keep every devenv.nix **minimal** — only include what the project needs to run, test, and be edited. Avoid demo banners, sample services, and speculative packages.

## Required scripts

Every project must expose these `scripts` in `devenv.nix`:

- `run` — start the project in its normal mode.
- `test` — run the project's tests. Include only if the project has tests or test infrastructure.
- `deploy` — only when the user explicitly requests production/homelab deployment. Otherwise omit it.

Scripts are the primary interface: `devenv shell` followed by `run`, `test`, or `deploy` should be the obvious next step.

Example:

```nix
scripts = {
  run.exec = "uv run python -m myapp";
  test.exec = "uv run pytest";
  # deploy is gated; see below
};
```

## Python projects

For Python projects, use **uv**:

```nix
languages.python = {
  enable = true;
  venv.enable = true;
  uv = {
    enable = true;
    sync.enable = true;
  };
};
```

- Do not use Poetry.
- Ensure a `pyproject.toml` exists.
- Keep `uv.lock` tracked.

## CUDA / GPU Python projects

PyTorch, JAX and cuTile work best from **pip CUDA wheels**, not nixpkgs (nixpkgs
CUDA lags, and `cuda_tileiras` does not exist there). That needs three extra
things on NixOS: a `patchelf` hook that rewrites the ELF interpreter of
pip-shipped binaries (`ptxas`, `tileiras`, triton's `ptxas`), driver libs on
`LD_LIBRARY_PATH` (`/run/opengl-driver/lib`), and `TRITON_LIBCUDA_PATH` for
`torch.compile`. Copy the verified recipe + failure/fix table from memory:
`knowledge/nixos-cuda-devenv.md`.

## Language servers

For every language block, explicitly enable the LSP:

```nix
languages.python.lsp.enable = true;
```

The default for Python is already `true`, but the devenv.nix must set it explicitly so the preference is visible.

## Git hooks

Keep hooks simple and aligned with the project languages:

```nix
inputs = {
  git-hooks.url = "github:cachix/git-hooks.nix";
};
```

in `devenv.yaml`, and in `devenv.nix`:

```nix
{
  git-hooks.hooks = {
    ruff-format.enable = true;
    ruff.enable = true;
    nixfmt.enable = true;
  };
}
```

Pick only the hooks that match the project files. Do not enable every available hook.

## Deploy gate

`deploy` is a gated script. Add it only when the user explicitly asks to run something in production or on the homelab. Without that explicit request, leave `deploy` out.

When added, keep it simple and targeted at the homelab (e.g., `nixos-rebuild`, container push, `rsync`, or a deployment script that already exists in the repo).

## Minimal skeleton

```nix
{ pkgs, lib, config, inputs, ... }:

{
  languages.python = {
    enable = true;
    lsp.enable = true;
    venv.enable = true;
    uv = {
      enable = true;
      sync.enable = true;
    };
  };

  packages = with pkgs; [
    git
    ripgrep
  ];

  scripts = {
    run.exec = "uv run python -m myapp";
    test.exec = "uv run pytest";
  };

  git-hooks.hooks = {
    ruff-format.enable = true;
    ruff.enable = true;
    nixfmt.enable = true;
  };
}
```

## Anti-patterns

- Do not enable a database, process, or service unless the project needs it.
- Do not print a welcome banner in `enterShell`.
- Do not add both `uv` and `poetry`.
- Do not add a `deploy` script "just in case".
