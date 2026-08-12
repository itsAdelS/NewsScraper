/**
 * Post-codegen fix: remove the conflicting barrel re-export that orval appends
 * to lib/api-zod/src/index.ts.
 *
 * Problem: orval generates `export * from './generated/types'` at the bottom of
 * the workspace-root index file.  That re-exports `ScrapeResponse` as a
 * TypeScript interface, which conflicts with the same-named Zod-schema const
 * already exported from `./generated/api` — triggering TS2308 every time the
 * typecheck pipeline runs.
 *
 * The individual `export type { … }` lines above it already expose every type
 * except ScrapeResponse (intentionally excluded to avoid the collision), so
 * removing the glob barrel line is safe and keeps the exports correct.
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexPath = resolve(__dirname, "..", "api-zod", "src", "index.ts");

const original = readFileSync(indexPath, "utf8");
// Strip any line that is exactly `export * from './generated/types';`
// (orval adds this with single quotes; account for optional trailing newline)
const fixed = original.replace(/^export \* from '\.\/generated\/types';\n?/m, "");

if (fixed === original) {
  console.log("fix-zod-index: nothing to remove — index.ts looks clean");
} else {
  writeFileSync(indexPath, fixed, "utf8");
  console.log(
    "fix-zod-index: removed conflicting `export * from './generated/types'` barrel from index.ts"
  );
}
