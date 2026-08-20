#!/usr/bin/env bash
# Sets up LD_LIBRARY_PATH so Playwright's Chromium binary can find
# libgbm.so.1 (mesa) and libudev.so.1 (systemd) on NixOS/Replit,
# then starts the API server.

# Resolve paths relative to this script's location so the script
# works regardless of which directory the caller runs it from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Tell Playwright where the browser binary lives. The browsers are
# installed into .playwright-browsers/ (a sibling of src/ and dist/)
# so they survive into the production container image. The .cache/
# directory is gitignored and excluded from the Repl layer.
export PLAYWRIGHT_BROWSERS_PATH="$SCRIPT_DIR/../.playwright-browsers"

MESA_LIB_DIR=""
for d in /nix/store/*-mesa-libgbm-*/lib; do
  MESA_LIB_DIR="$d"
  break
done

SYSTEMD_LIB_DIR=""
for d in /nix/store/*-systemd-minimal-*/lib; do
  SYSTEMD_LIB_DIR="$d"
  break
done

for d in "$MESA_LIB_DIR" "$SYSTEMD_LIB_DIR"; do
  if [[ -n "$d" ]]; then
    export LD_LIBRARY_PATH="$d${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  fi
done

exec node --enable-source-maps "$SCRIPT_DIR/../dist/index.mjs"
