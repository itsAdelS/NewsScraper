---
name: Playwright Chromium system libraries on Replit NixOS
description: How to get Playwright's bundled Chromium to launch in Replit's NixOS environment — the specific missing libs and how they're resolved.
---

# Playwright Chromium on Replit NixOS

## The Rule
Playwright's pre-compiled Chromium binary (`chromium_headless_shell`) is an FHS binary compiled for Debian/Ubuntu. On NixOS it cannot find two system libraries that aren't in the default dynamic linker path.

**Why:** `libgbm.so.1` and `libudev.so.1` are not part of glibc (which is always present) — they come from Mesa and systemd, which must be explicitly installed AND their Nix store paths added to `LD_LIBRARY_PATH`.

## How to Apply
1. Install the Nix packages via `installSystemDependencies(["mesa", "systemd"])` (or more precisely `mesa` installs `mesa-libgbm`; `systemd` installs `systemd-minimal`).
2. Set `LD_LIBRARY_PATH` in the server dev script using shell globs to resolve the Nix store paths without hardcoding hashes:
   ```
   for d in /nix/store/*-mesa-libgbm-*/lib; do export LD_LIBRARY_PATH="$d${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"; break; done
   for d in /nix/store/*-systemd-minimal-*/lib; do export LD_LIBRARY_PATH="$d${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"; break; done
   ```
3. Do NOT use the `electronplayer-*-fhs/usr/lib64/` path — it contains an older glibc that breaks `/bin/sh`.
4. Add `playwright install chromium` as a `postinstall` script in package.json so the binary is re-downloaded after any `pnpm install`.

## Verification
- `ldd <chrome-headless-shell> | grep "not found"` → no output = all libs resolved
- Test scrape returns `scraperUsed: playwright` (even if 403 SSRF) = Chromium launched

## Files
- `artifacts/api-server/package.json` — `postinstall` and `dev` scripts
