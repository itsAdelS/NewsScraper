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
2. Set `LD_LIBRARY_PATH` in the server dev script by deriving the Mesa and systemd library directories from the matching package entries already on `PATH`:
   ```
    for p in ${PATH//:/ }; do
      case "$p" in
        *-mesa-*/bin) candidate="${p%/bin}/lib"; [[ -f "$candidate/libgbm.so.1" ]] && MESA_LIB_DIR="$candidate" ;;
        *-systemd-*/bin) candidate="${p%/bin}/lib"; [[ -f "$candidate/libudev.so.1" ]] && SYSTEMD_LIB_DIR="$candidate" ;;
      esac
    done
   ```
   Do not search `/nix/store` with sequential wildcard globs during process startup.
   
   **Why:** In this environment, a second broad `/nix/store/*` expansion can stall the launcher before Node is executed, causing artifact workflow port timeouts. `PATH` already contains the required package roots and has no hash coupling.
3. Do NOT use the `electronplayer-*-fhs/usr/lib64/` path — it contains an older glibc that breaks `/bin/sh`.
4. Add `playwright install chromium` as a `postinstall` script in package.json so the binary is re-downloaded after any `pnpm install`.

## Verification
- `ldd <chrome-headless-shell> | grep "not found"` → no output = all libs resolved
- Test scrape returns `scraperUsed: playwright` (even if 403 SSRF) = Chromium launched

## Files
- `artifacts/api-server/package.json` — `postinstall` and `dev` scripts
