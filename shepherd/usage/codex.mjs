#!/usr/bin/env node
// Codex's weekly usage, for workflow.json's `"usage": {"codex": "node usage/codex.mjs"}`.
//
// Codex CLI has no usage command; every turn it logs the account's rate limits to its session
// files (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, or $CODEX_HOME's): `token_count` events
// with `rate_limits.primary` / `.secondary`, each `{used_percent, window_minutes, resets_at}`
// (older versions: `resets_in_seconds`). This reads the newest one with a weekly window
// (10080 minutes). Only what this machine's Codex has logged counts: when the week has reset
// since its last run, it prints 0.
//
// Prints the Shepherd usage format (see RECIPE.md):
//   9                           weekly % (0-100)
//   weekly limit                detail line
//   resets=2026-11-21T22:30:56Z when the week resets
// Exits non-zero with one line on stderr when Codex has logged no rate limits.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const fail = (msg) => { process.stderr.write(`${msg}\n`); process.exit(1); };
const WEEK_MIN = 7 * 24 * 60;
const root = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");

const ls = (dir) => { try { return readdirSync(dir); } catch { return []; } };
const desc = (a) => a.sort().reverse();

/** Session files, newest day first; within a day, newest change first. */
function* files() {
  for (const y of desc(ls(root))) for (const mo of desc(ls(join(root, y)))) for (const d of desc(ls(join(root, y, mo)))) {
    const dir = join(root, y, mo, d);
    const day = ls(dir).filter((f) => f.endsWith(".jsonl"))
      .map((f) => { const p = join(dir, f); try { return { p, t: statSync(p).mtimeMs }; } catch { return null; } })
      .filter(Boolean).sort((a, b) => b.t - a.t);
    for (const f of day) yield f.p;
  }
}

/** The last weekly window a file logged, with the time it was logged. */
function weekly(path) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes("rate_limits")) continue;
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    const rl = e?.payload?.rate_limits ?? e?.rate_limits;
    const w = [rl?.secondary, rl?.primary].find((x) => x && x.window_minutes === WEEK_MIN);
    if (!w || typeof w.used_percent !== "number") continue;
    const at = Date.parse(e.timestamp) || null;
    const resets = typeof w.resets_at === "number" ? w.resets_at * 1000
      : typeof w.resets_in_seconds === "number" && at ? at + w.resets_in_seconds * 1000 : null;
    return { pct: w.used_percent, resets };
  }
  return null;
}

let found = null;
let tried = 0;
for (const f of files()) {
  if (++tried > 200) break; // a long idle stretch of runs without limits: give up rather than read them all
  found = weekly(f);
  if (found) break;
}
if (!found) fail(`no Codex rate limits logged under ${root}`);

const now = Date.now();
const reset = found.resets != null && found.resets <= now;
const out = [String(reset ? 0 : Math.max(0, Math.min(100, Math.round(found.pct))))];
out.push(reset ? "no run since it reset" : "weekly limit");
if (found.resets != null && !reset) out.push(`resets=${new Date(found.resets).toISOString()}`);
process.stdout.write(`${out.join("\n")}\n`);
