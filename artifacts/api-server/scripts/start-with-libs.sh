#!/usr/bin/env bash
# Sets up LD_LIBRARY_PATH for Playwright's Chromium binary on NixOS/Replit,
# checks that its runtime libraries resolve, then starts the API server.

# Resolve paths relative to this script's location so the script
# works regardless of which directory the caller runs it from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Tell Playwright where the browser binary lives. The browsers are
# installed into .playwright-browsers/ (a sibling of src/ and dist/)
# so they survive into the production container image. The .cache/
# directory is gitignored and excluded from the Repl layer.
export PLAYWRIGHT_BROWSERS_PATH="$SCRIPT_DIR/../.playwright-browsers"

MESA_LIB_DIR=""
SYSTEMD_LIB_DIR=""
# The required Mesa and systemd packages are already present on PATH. Resolve
# their library directories from those entries rather than globbing /nix/store:
# whole-store wildcard expansion can stall the API launcher in this environment.
for p in ${PATH//:/ }; do
  case "$p" in
    *-mesa-*/bin)
      candidate="${p%/bin}/lib"
      if [[ -f "$candidate/libgbm.so.1" ]]; then
        MESA_LIB_DIR="$candidate"
      fi
      ;;
    *-systemd-*/bin)
      candidate="${p%/bin}/lib"
      if [[ -f "$candidate/libudev.so.1" ]]; then
        SYSTEMD_LIB_DIR="$candidate"
      fi
      ;;
  esac
  if [[ -n "$MESA_LIB_DIR" && -n "$SYSTEMD_LIB_DIR" ]]; then
    break
  fi
done

for d in "$MESA_LIB_DIR" "$SYSTEMD_LIB_DIR"; do
  if [[ -n "$d" ]]; then
    export LD_LIBRARY_PATH="$d${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  fi
done

# libgbm is supplied as a separate Nix package in this environment. It does not
# provide a bin/ directory, so it cannot be discovered through PATH like
# systemd above. The Nix runtime exposes it to the dynamic linker directly.
# Keep the check here so a dependency regression is visible at server startup
# instead of only surfacing as a low-level Playwright "page closed" error.
CHROMIUM_BIN="$(find "$PLAYWRIGHT_BROWSERS_PATH" -type f -name chrome-headless-shell -print -quit 2>/dev/null || true)"
if [[ -n "$CHROMIUM_BIN" ]]; then
  UNRESOLVED_LIBS="$(ldd "$CHROMIUM_BIN" 2>&1 | grep 'not found' || true)"
  if [[ -n "$UNRESOLVED_LIBS" ]]; then
    printf 'WARNING: Playwright Chromium has unresolved runtime libraries:\n%s\n' "$UNRESOLVED_LIBS" >&2
  fi
else
  printf 'WARNING: Playwright Chromium binary was not found at %s\n' "$PLAYWRIGHT_BROWSERS_PATH" >&2
fi

exec node --enable-source-maps "$SCRIPT_DIR/../dist/index.mjs"
