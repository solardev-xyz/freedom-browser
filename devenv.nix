# Devenv shell for Freedom Browser.
#
#   devenv shell       enter the dev shell
#   direnv allow       OR auto-activate on cd (requires direnv + the .envrc)
#
# This pins the same toolchain CI uses (Node 20 + npm, see
# .github/workflows/ci.yml and the node:20 / electronuserland/builder:20
# Docker images used by `npm run dist:linux:*:docker`) and bundles the system
# dependencies required to:
#
#   - build native modules (better-sqlite3, node-addon-api, freedom-ipfs-node
#     prebuild fallbacks via node-gyp): python3, gnumake, gcc, pkg-config
#   - run the binary fetch scripts: curl + jq (ant/radicle status helpers) and
#     xz (fetch-radicle.js runs `tar -xJf`)
#   - run the Playwright E2E suite headlessly on Linux: xvfb-run
#
# The .envrc is opt-in (only activates with direnv installed), so this file is
# a no-op for contributors who don't use devenv/Nix. See https://devenv.sh for
# the full option reference.

{ pkgs, config, lib, ... }:

{
  # ---------------------------------------------------------------------------
  # Languages
  # ---------------------------------------------------------------------------
  languages.javascript = {
    enable = true;
    # Match CI (Node 20). package.json engines is >=18; Electron 41 ships its
    # own bundled Node for the main process, but the dev toolchain (jest,
    # eslint, electron-builder, the fetch scripts) runs on this system Node.
    package = pkgs.nodejs_20;
    npm = {
      enable = true;
      # Do NOT auto-install on shell entry. The repo's postinstall hook
      # (`electron-builder install-app-deps`) rebuilds native addons for
      # Electron, which is slow and not always wanted. Run `devenv run setup`
      # (or `npm install`) explicitly instead.
      install.enable = false;
    };
  };

  # ---------------------------------------------------------------------------
  # Packages
  # ---------------------------------------------------------------------------
  packages =
    with pkgs;
    [
      # Version control + the `git-remote-rad` helper shipped by radicle:download.
      git
      # Used by the ant:status / system-ant:status / radicle:status npm scripts
      # and general node scripting.
      curl
      jq
      # fetch-radicle.js runs `tar -xJf` — needs xz for .tar.xz extraction.
      xz
      # Native-module build toolchain (node-gyp). better-sqlite3 and
      # freedom-ipfs-node ship prebuilds for the common targets; these are the
      # fallback for when a prebuild is missing.
      python3
      gnumake
      gcc
      pkg-config
    ]
    ++ lib.optionals pkgs.stdenv.isLinux [
      # Headless X server for `xvfb-run -a npm run test:e2e` (CI uses the same
      # invocation on ubuntu-latest). macOS/Windows runners boot a real
      # display, so this is Linux-only.
      xvfb_run
    ];

  # ---------------------------------------------------------------------------
  # Scripts — thin wrappers over the repo's npm scripts so contributors don't
  # have to remember the exact incantations. Invoke with `devenv run <name>`.
  # ---------------------------------------------------------------------------
  scripts.fetch-binaries.exec = ''
    echo "Downloading Ant (Swarm)…"
    npm run ant:download
    echo "Downloading IPFS native addon…"
    npm run ipfs:download
    echo "Downloading Radicle binaries (macOS/Linux only)…"
    npm run radicle:download || echo "radicle:download skipped (unsupported on this platform)"
  '';
  scripts.fetch-binaries.description = "Download antd, the freedom-ipfs native addon, and Radicle binaries.";

  scripts.setup.exec = ''
    npm install
    echo "Downloading Ant (Swarm)…"
    npm run ant:download
    echo "Downloading IPFS native addon…"
    npm run ipfs:download
    echo "Downloading Radicle binaries (macOS/Linux only)…"
    npm run radicle:download || echo "radicle:download skipped (unsupported on this platform)"
  '';
  scripts.setup.description = "First-time setup: npm install + download all node binaries.";

  scripts.start.exec = "npm start";
  scripts.start.description = "Launch Freedom (electron .).";

  scripts.test.exec = "npm test";
  scripts.test.description = "Run the Jest unit test suite.";

  scripts.lint.exec = "npm run lint";
  scripts.lint.description = "Run ESLint.";

  scripts.format.exec = "npm run format";
  scripts.format.description = "Format the tree with Prettier.";

  scripts.e2e.exec = ''
    if command -v xvfb-run >/dev/null 2>&1; then
      xvfb-run -a npm run test:e2e
    else
      npm run test:e2e
    fi
  '';
  scripts.e2e.description = "Run Playwright E2E (headless via xvfb when available).";

  # ---------------------------------------------------------------------------
  # enterShell — printed every time the shell activates.
  # ---------------------------------------------------------------------------
  enterShell = ''
    echo ""
    echo "  ⬢ Freedom Browser — devenv"
    echo "    node $(node --version)  •  npm $(npm --version)"
    echo ""
    echo "  First run:    devenv run setup"
    echo "  Launch:       devenv run start   (or npm start)"
    echo "  Tests:        devenv run test"
    echo "  Lint/format:  devenv run lint | devenv run format"
    echo "  E2E:          devenv run e2e"
    echo ""
  '';
}
