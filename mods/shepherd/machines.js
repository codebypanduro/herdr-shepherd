// Machines for the Spaces sidebar and the settings dialogs: what each one is (kind, model), its
// load (cpu, mem, disk) and which agents it has, plus the machine and weekly-usage popovers. The
// sidebar copy probes every machine and keeps the results in shared state, so popovers and
// settings dialogs (other copies) read the same numbers.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { machines, terminals, shared, setShared, exec, knownAgents, readTextFile, appHome, props } from "herdr";
import { MONO, palette, machineOf } from "./common.js";
import { MACHINE_INFO, MACHINE_KINDS, USAGE, readWorkflow, shepherdHome, shepherdOn } from "./ui.js";

export const KINDS = [["server", "Server"], ["laptop", "MacBook"], ["mini", "Mac mini"], ["tower", "Desktop"]];
const PROBE_MS = 15000;
const PROBE_TIMEOUT_MS = 8000; // well under PROBE_MS, so rounds don't overlap
const USAGE_MS = 5 * 60000;
const USAGE_RETRY_MS = 30000;

/** Every machine the sidebar shows: this one first, then `machines()` (Herdr leaves out temporary
 *  ones). Kind: the person's pick in Add machine, else what machine.sh found. */
export function machineList() {
  const info = shared(MACHINE_INFO) ?? {};
  const terms = terminals();
  const kinds = shared(MACHINE_KINDS) ?? {};
  const list = [{ name: null, layout: "ready" }, ...machines().filter((m) => m.name)];
  return list.map((m) => {
    const key = m.name ?? "";
    const i = info[key] ?? {};
    return {
      key, name: m.name, label: m.name ?? (i.model && !/mac/i.test(i.model) ? "this computer" : "this mac"),
      online: m.layout !== "unavailable" && !i.error, layout: m.layout,
      kind: kinds[key] ?? i.kind ?? (m.name ? "server" : "laptop"), model: i.model ?? null,
      cpu: i.cpu ?? null, mem: i.mem ?? null, disk: i.disk ?? null, tools: i.tools ?? null,
      agents: terms.filter((x) => x.state === "live" && x.status && machineOf(x) === m.name).length,
    };
  });
}

export const machineByName = (name) => machineList().find((m) => m.name === (name ?? null)) ?? null;

/** Starts the sidebar copy's probes: machine.sh on each machine every 15 s, knownAgents once a
 *  machine answers, and the weekly usage commands every 5 minutes. */
export function startProbes(m, cx) {
  m.probing = new Set(); // machines with a probe in flight
  cx.timer.every(PROBE_MS, (cx) => probeMachines(m, cx));
  probeMachines(m, cx);
  cx.timer.every(USAGE_MS, (cx) => probeUsage(m, cx));
  probeUsage(m, cx);
  cx.timer.after(USAGE_RETRY_MS, (cx) => probeUsage(m, cx)); // again once other machines' tools are known
}

/** A promise that gives up after ms (knownAgents has no timeout of its own). */
const within = (cx, ms, p) => new Promise((resolve) => {
  cx.timer.after(ms, () => resolve(null));
  p.then(resolve, () => resolve(null));
});

/** One round of machine.sh on every machine that answers; a machine still busy from the last round
 *  is skipped. Kind and model are asked once. */
export function probeMachines(m, cx) {
  cx.spawn(async (cx) => {
    const script = await readTextFile(`${appHome()}/mods/shepherd/machine.sh`).catch(() => null);
    if (!script) return;
    const list = [{ name: null }, ...machines().filter((x) => x.name && x.layout !== "unavailable")]
      .filter((mc) => !m.probing.has(mc.name ?? ""));
    await Promise.all(list.map(async (mc) => {
      const key = mc.name ?? "";
      m.probing.add(key);
      try {
        const full = !((shared(MACHINE_INFO) ?? {})[key]?.kind);
        const r = await exec("sh", ["-c", script, "machine.sh", full ? "full" : ""], { on: mc.name, timeout: PROBE_TIMEOUT_MS })
          .catch((e) => ({ code: -1, stderr: String(e) }));
        const got = { at: Date.now() };
        if (r.code === 0) {
          for (const line of r.stdout.split("\n")) {
            const [k, ...v] = line.split("=");
            const val = v.join("=").trim();
            if (["cpu", "mem", "disk"].includes(k) && /^\d+$/.test(val)) got[k] = Number(val);
            if ((k === "kind" || k === "model") && val) got[k] = val;
          }
          got.error = null;
        } else got.error = (r.stderr || "unreachable").split("\n")[0];
        if (!got.error && !(shared(MACHINE_INFO) ?? {})[key]?.tools) {
          const agents = await within(cx, PROBE_TIMEOUT_MS, knownAgents({ on: mc.name }));
          if (agents) got.tools = agents.filter((a) => a.installed && ["claude", "codex"].includes(a.key)).map((a) => a.key);
        }
        // Merge into what's there now, not what was there when this probe started.
        const now = shared(MACHINE_INFO) ?? {};
        setShared(MACHINE_INFO, { ...now, [key]: { ...now[key], ...got } });
      } finally { m.probing.delete(key); }
    }));
  });
}

/** Weekly usage: neither Claude Code nor Codex has a usage command, so workflow.json names one per
 *  tool (`"usage": {"claude": "<command>", "codex": "<command>"}`); without it in the person's
 *  file, the example's are used (shepherd/usage/*.mjs). A command runs in the shepherd/ folder, in
 *  a login shell, on each machine that has the tool (this computer too before its tools are known)
 *  and a checkout there (shepherdOn). It prints a percent, then optionally a detail line,
 *  `resets=<ISO time>` and `part=<label> <pct>` lines (the bar's segments). Shared state keeps
 *  each machine's result; a failed run keeps the last good one while it's live (see `live`) and
 *  records its error. */
export function probeUsage(m, cx) {
  if (m.usageBusy) return;
  m.usageBusy = true;
  cx.spawn(async () => {
    try {
      const h = await shepherdHome(m);
      let cmds = (await readWorkflow(m)).wf.usage;
      if (!cmds && h) cmds = await readTextFile(h.example).then((x) => JSON.parse(x).usage).catch(() => null);
      cmds ??= {};
      const tools = TOOLS.map(([k]) => k).filter((k) => typeof cmds[k] === "string" && cmds[k]);
      const info = shared(MACHINE_INFO) ?? {};
      const toolsOn = (key) => (info[key]?.tools ? tools.filter((k) => info[key].tools.includes(k)) : key ? [] : tools);
      const runs = [{ key: "", on: null }, ...machines().filter((x) => x.name && x.layout !== "unavailable").map((x) => ({ key: x.name, on: x.name }))]
        .map((r) => ({ ...r, tools: toolsOn(r.key) })).filter((r) => r.tools.length);
      const got = Object.fromEntries(await Promise.all(runs.map(async (r) => [r.key, await runUsage(m, r, cmds)])));
      setShared(USAGE, { at: Date.now(), by: mergeUsage((shared(USAGE) ?? {}).by ?? {}, got) });
    } catch (e) {
      setShared(USAGE, { ...(shared(USAGE) ?? {}), failed: String(e?.message ?? e).split("\n")[0] });
    } finally { m.usageBusy = false; }
  });
}

/** One machine's usage commands: { tool: parsed output | {error} }. Where the checkout is on that
 *  machine is remembered only once found, so a checkout added later is picked up. */
async function runUsage(m, run, cmds) {
  const out = {};
  const where = (m.usageWhere ??= {})[run.key] ?? await shepherdOn(m, run.on);
  if (!where.dir) { for (const k of run.tools) out[k] = { error: where.reason }; return out; }
  m.usageWhere[run.key] = where;
  for (const k of run.tools) {
    const r = await (run.on
      ? exec("sh", ["-c", 'cd "$1" && PATH="$2:$PATH" && eval "$3"', "usage", where.dir, where.path, cmds[k]], { on: run.on, timeout: 30000 })
      : exec("sh", ["-lc", cmds[k]], { cwd: where.dir, timeout: 30000 })).catch((e) => ({ code: -1, stderr: String(e) }));
    out[k] = (r.code === 0 && parseUsage(r.stdout))
      || { error: (r.stderr || r.stdout || "").trim().split("\n")[0] || `exit ${r.code}` };
  }
  return out;
}

/** New results over the old: a failed run keeps the last % while it's live, with the error. */
function mergeUsage(before, got) {
  const now = Date.now();
  return Object.fromEntries(Object.entries(got).map(([key, res]) => [key, Object.fromEntries(Object.entries(res).map(([k, v]) => {
    const old = before[key]?.[k];
    return [k, v.error && live(old) ? { ...old, error: v.error } : { ...v, at: now }];
  }))]));
}

/** One usage command's output: percent, then detail / resets= / part= lines in any order. */
export function parseUsage(text) {
  const lines = (text ?? "").trim().split("\n").map((l) => l.trim());
  const pct = Number.parseFloat(lines[0]);
  if (!Number.isFinite(pct)) return null;
  const out = { pct: Math.max(0, Math.min(100, Math.round(pct))), detail: null, resets: null, parts: [] };
  for (const l of lines.slice(1)) {
    const kv = l.match(/^(resets|part)=(.*)$/);
    if (!kv) { if (l && out.detail == null) out.detail = l; continue; }
    if (kv[1] === "resets" && Number.isFinite(Date.parse(kv[2]))) out.resets = new Date(Date.parse(kv[2])).toISOString();
    const p = kv[1] === "part" && kv[2].match(/^(.*\S)\s+(\d+(?:\.\d+)?)$/);
    if (p) out.parts.push({ name: p[1], pct: Math.max(0, Math.round(Number(p[2]))) });
  }
  out.detail ??= "weekly limit";
  return out;
}

const TOOLS = [["claude", "Claude"], ["codex", "Codex"]];

/** A reading still worth showing: it has a %, and its week hasn't reset since (without a reset
 *  time, for three probe rounds). */
const live = (v) => v?.pct != null && (v.resets ? Date.parse(v.resets) > Date.now() : Date.now() - (v.at ?? 0) < USAGE_MS * 3);

/** A tool's weekly usage, account-wide: of every machine's live reading, the one in the newest
 *  week (latest reset), the highest % within it (usage only grows in a week); a reading without a
 *  reset time (e.g. Codex's "no run since it reset" 0) only when none has one, this computer's first. */
export function usageOf(tool) {
  const by = (shared(USAGE) ?? {}).by ?? {};
  const all = [by[""], ...Object.entries(by).filter(([k]) => k).map(([, v]) => v)].map((v) => v?.[tool]).filter(live);
  const dated = all.filter((v) => v.resets)
    .sort((a, b) => Date.parse(b.resets) - Date.parse(a.resets) || b.pct - a.pct);
  return dated[0] ?? all[0] ?? null;
}

/** What one machine's popover shows for a tool: its own live reading, else its own run's error,
 *  else (no run there) the account-wide one. */
export function machineUsage(tool, key) {
  const own = ((shared(USAGE) ?? {}).by ?? {})[key]?.[tool];
  if (live(own)) return { pct: own.pct };
  if (own?.error) return { error: own.error };
  const u = usageOf(tool);
  return u ? { pct: u.pct } : null;
}

const someMachineHas = (tool) => machineList().some((m) => (m.tools ?? []).includes(tool));

/** Weekly usage rows the sidebar shows: tools some machine has, with a live reading. */
export function usageRows() {
  return TOOLS.filter(([k]) => someMachineHas(k) && usageOf(k)).map(([k, name]) => ({ key: k, name, ...usageOf(k) }));
}

/** Why a tool some machine has shows no usage: the first error a run reported. */
export function usageErrors() {
  const by = (shared(USAGE) ?? {}).by ?? {};
  return TOOLS.filter(([k]) => someMachineHas(k) && !usageOf(k))
    .map(([k, name]) => ({ name, error: Object.values(by).map((v) => v?.[k]?.error).find(Boolean) ?? null }));
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Mon", or "Mon 23" when it's more than 6 days off; "today 13:00" for today. */
export function resetDay(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `today ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d - now > 6 * 86400000 ? `${DAYS[d.getDay()]} ${d.getDate()}` : DAYS[d.getDay()];
}

// ---- drawing --------------------------------------------------------------------------------

/** A machine's icon (laptop, mini, server, tower) with its status dot in the corner. */
export function machineIcon(t, mc, { size = 1, dotRing = t.chrome } = {}) {
  const dot = !mc.online ? t.idle : (mc.cpu ?? 0) >= 80 || (mc.disk ?? 0) >= 80 ? t.blocked : t.done;
  return div().relative().w(18 * size).h(14 * size).flex_none().flex().items_center().justify_center()
    .child(svg(`mods/shepherd/icons/${mc.kind}.svg`).w(18 * size).h(13 * size).text_color(t.muted))
    .child(div().absolute().right(-2).bottom(-1).size(6).rounded(3).bg(dot).border(1.5).border_color(dotRing));
}

export function agentIcon(t, tool, size = 13) {
  return tool === "claude"
    ? image("icons/claude.svg").size(size).flex_none()
    : div().size(size).flex_none().rounded(3).bg(t.foreground).text_color(t.background).font_family(MONO)
      .text_size(7).font_semibold().flex().items_center().justify_center().child(">_");
}

/** The machine popover (sidebar footer or a space row's machine): model, agents, meters, installed. */
export function renderMachinePop(m) {
  const t = palette();
  const mc = machineByName(props()?.machine ?? null);
  if (!mc) return div();
  return v_flex().id("machine-pop").size_full().p(12).gap(10).bg(t.surface).text_color(t.foreground)
    .child(h_flex().gap(8).items_center()
      .child(machineIcon(t, mc, { dotRing: t.surface }))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(13).font_semibold().truncate().child(mc.label))
        .child(div().text_size(11).text_color(t.dim).truncate().child(mc.online ? mc.model ?? "…" : "unreachable")))
      .child(div().font_family(MONO).text_size(10.5).text_color(t.dim).child(`${mc.agents} agents`)))
    .child(v_flex().gap(8)
      .child(bar(t, "cpu", mc.cpu)).child(bar(t, "mem", mc.mem)).child(bar(t, "disk", mc.disk)))
    .child(v_flex().gap(6)
      .child(div().text_size(10.5).text_color(t.dim).child("INSTALLED"))
      .children((mc.tools ?? []).map((tool) => h_flex().gap(6).items_center().text_size(12)
        .child(agentIcon(t, tool))
        .child(div().flex_1().child(tool === "claude" ? "Claude Code" : "Codex"))
        .when(Boolean(machineUsage(tool, mc.key)), (el) => {
          const u = machineUsage(tool, mc.key);
          return el.child(div().min_w(0).max_w(150).truncate().font_family(MONO).text_size(10.5).text_color(t.dim)
            .child(u.error ?? `${u.pct}% this week`));
        })))
      .when(!mc.tools, (el) => el.child(div().text_size(11).text_color(t.dim).child("…")))
      .when(Array.isArray(mc.tools) && !mc.tools.length, (el) => el.child(div().text_size(11).text_color(t.dim).child("No Claude Code or Codex"))));
}

/** A full-width bar for popovers and settings: label, value, fill; red at the limit, amber near it,
 *  and with a limit, a tick where it sits. */
export function bar(t, label, v, lim = null) {
  const hi = lim ?? 80;
  const color = v == null ? t.raised : v >= hi ? t.ansi1 : v >= hi - 10 ? t.blocked : t.muted;
  const pct = Math.max(0, Math.min(100, v ?? 0));
  return v_flex().gap(4).flex_1()
    .child(h_flex().justify_between().font_family(MONO).text_size(10.5)
      .child(div().text_color(t.dim).child(label))
      .child(div().text_color(v != null && v >= hi ? t.ansi1 : t.muted).child(v == null ? "—" : `${v}%`)))
    .child(div().relative().h(4).rounded(2).bg(t.raised)
      .child(div().absolute().left(0).top(0).h(4).rounded(2).bg(color).w(`${pct}%`))
      .when(lim != null, (el) => el.child(div().absolute().top(-2).h(8).w(1).bg(t.foreground).left(`${lim}%`))));
}

/** Usage this week: one row per tool with its detail, % and bar, split into the command's parts
 *  (Claude: the rest muted, a model with its own weekly cap ansi5; Codex done green); the % turns
 *  red from 80%, as in the footer. The header's reset day is the first row's; a row that resets on
 *  another day says so in its detail. */
export function renderUsagePop() {
  const t = palette();
  const rows = usageRows();
  const head = rows.find((r) => r.resets)?.resets ?? null;
  const segColors = (key) => key === "claude" ? [t.muted, t.ansi5, t.ansi6] : [t.done, t.ansi6, t.ansi5];
  const failed = (shared(USAGE) ?? {}).failed;
  return v_flex().id("usage-pop").size_full().p(12).gap(10).bg(t.surface).text_color(t.foreground)
    .child(h_flex().justify_between().items_center()
      .child(div().text_size(13).font_semibold().child("Usage this week"))
      .when(Boolean(head), (el) => el.child(div().font_family(MONO).text_size(11).text_color(t.dim).child(`resets ${resetDay(head)}`))))
    .children(rows.map((r) => {
      const other = r.resets && head && resetDay(r.resets) !== resetDay(head) ? ` · resets ${resetDay(r.resets)}` : "";
      const colors = segColors(r.key);
      const parts = (r.parts?.length ? r.parts : [{ name: r.name, pct: r.pct }])
        .map((p, i) => ({ ...p, color: colors[i % colors.length] })).filter((p) => p.pct > 0);
      return v_flex().gap(5)
        .child(h_flex().gap(6).items_center().text_size(12)
          .child(agentIcon(t, r.key))
          .child(div().child(r.name))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(`${r.detail}${other}`))
          .child(div().font_family(MONO).text_size(11).text_color(r.pct >= 80 ? t.ansi1 : t.muted).child(`${r.pct}%`)))
        .child(h_flex().h(5).gap(1).rounded(3).overflow_hidden().bg(t.raised)
          .children(parts.map((p) => div().h(5).flex_none().w(`${Math.min(100, p.pct)}%`).bg(p.color))));
    }))
    .when(!rows.length, (el) => el.child(v_flex().gap(4).text_size(11.5).text_color(t.dim)
      .when(Boolean(failed), (el) => el.child(`Usage check failed: ${failed}`))
      .children(usageErrors().map((e) => div().child(`${e.name}: ${e.error ?? "checking…"}`)))
      .when(!failed && !usageErrors().length, (el) => el.child(
        "No usage yet. workflow.json's \"usage\" commands (shepherd/usage/*.mjs by default) run every 5 minutes."))));
}
