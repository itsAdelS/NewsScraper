#!/usr/bin/env bash
# Sets up LD_LIBRARY_PATH so Playwright's Chromium binary can find
# libgbm.so.1 (mesa) and libudev.so.1 (systemd) on NixOS/Replit,
# then starts the API server.

for d in /nix/store/*-mesa-libgbm-*/lib; do
  export LD_LIBRARY_PATH="$d${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  break
done

for d in /nix/store/*-systemd-minimal-*/lib; do
  export LD_LIBRARY_PATH="$d${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  break
done

# Resolve dist path relative to this script's location so the script
# works regardless of which directory the caller runs it from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec node --enable-source-maps "$SCRIPT_DIR/../dist/index.mjs"
