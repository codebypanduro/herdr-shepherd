#!/usr/bin/env node
// Claude's weekly usage, for workflow.json's `"usage": {"claude": "node usage/claude.mjs"}`.
//
// Asks the endpoint Claude Code's /usage screen and statusline tools use
// (GET https://api.anthropic.com/api/oauth/usage, beta header oauth-2025-04-20). It's
// undocumented and may change; this script is the only place that knows it. The login token is
// Claude Code's own: the macOS Keychain item "Claude Code-credentials", or
// ~/.claude/.credentials.json (or $CLAUDE_CONFIG_DIR's) elsewhere. The token stays in this
// process's memory: never printed, logged, written or passed as an argument. An expired token is
// not refreshed here; Claude Code renews it the next time it runs.
//
// Prints the Shepherd usage format (see RECIPE.md):
//   31                          weekly % (0-100)
//   others 31% · Fable 0%       detail line
//   resets=2026-11-23T12:00:00Z when the week resets
//   part=others 31              the bar's segments, in order, adding up to the %
//   part=Fable 0                (a model with its own weekly cap: its share of the week)
// Exits non-zero with one line on stderr when there's no login or the endpoint fails.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const fail = (msg) => { process.stderr.write(`${msg}\n`); process.exit(1); };

function token() {
  let raw = null;
  if (process.platform === "darwin") {
    try {
      raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
    } catch { /* not in the Keychain: try the file */ }
  }
  if (!raw) {
    const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    try { raw = readFileSync(join(dir, ".credentials.json"), "utf8"); } catch { /* none */ }
  }
  if (!raw) fail("no Claude Code login found (Keychain or .credentials.json)");
  try {
    const t = JSON.parse(raw)?.claudeAiOauth?.accessToken;
    if (typeof t === "string" && t) return t;
  } catch { /* fall through */ }
  return fail("Claude Code's credentials have no claude.ai login");
}

const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
  headers: { Authorization: `Bearer ${token()}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
  signal: AbortSignal.timeout(15000),
}).catch((e) => fail(`usage endpoint unreachable: ${e?.name === "TimeoutError" ? "timed out" : e?.message ?? e}`));
if (res.status === 401) fail("Claude login token expired; it renews the next time Claude Code runs");
if (!res.ok) fail(`usage endpoint answered ${res.status}`);
const u = await res.json().catch(() => fail("usage endpoint sent no JSON"));

const week = u?.seven_day;
if (!week || typeof week.utilization !== "number") fail("usage endpoint has no weekly limit for this login");
const pct = Math.max(0, Math.min(100, Math.round(week.utilization)));

// Models with a weekly cap of their own count inside the week; `weekly_scoped_shares` says how
// much of the week each one used (`limit_index` points into `limits`).
const limits = Array.isArray(u.limits) ? u.limits : [];
const scoped = (Array.isArray(u.weekly_scoped_shares) ? u.weekly_scoped_shares : [])
  .map((s) => {
    const l = limits[s.limit_index];
    const name = l?.scope?.model?.display_name || l?.scope?.surface?.display_name || null;
    return name && typeof s.used_percent_of_weekly === "number" ? { name, pct: Math.round(s.used_percent_of_weekly) } : null;
  })
  .filter(Boolean);
// Older answers instead carry seven_day_opus / seven_day_sonnet: each a % of its own cap.
const legacy = [["opus", u.seven_day_opus], ["sonnet", u.seven_day_sonnet]]
  .filter(([, w]) => typeof w?.utilization === "number").map(([n, w]) => `${n} ${Math.round(w.utilization)}% of its cap`);

const out = [String(pct)];
if (scoped.length) {
  const parts = [{ name: "others", pct: Math.max(0, pct - scoped.reduce((a, s) => a + s.pct, 0)) }, ...scoped];
  out.push(parts.map((p) => `${p.name} ${p.pct}%`).join(" · "));
  if (week.resets_at) out.push(`resets=${new Date(week.resets_at).toISOString()}`);
  for (const p of parts) out.push(`part=${p.name} ${p.pct}`);
} else {
  out.push(legacy.length ? legacy.join(" · ") : "weekly limit");
  if (week.resets_at) out.push(`resets=${new Date(week.resets_at).toISOString()}`);
}
process.stdout.write(`${out.join("\n")}\n`);
