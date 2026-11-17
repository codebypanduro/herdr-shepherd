// Machines for the Spaces sidebar and the settings dialogs: what each one is (kind, model), its
// load (cpu, mem, disk) and which agents it has, plus the machine and weekly-usage popovers. The
// sidebar copy probes every machine and keeps the results in shared state, so popovers and
// settings dialogs (other copies) read the same numbers.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { machines, terminals, shared, setShared, exec, knownAgents, readTextFile, appHome, props } from "herdr";
import { MONO, palette, machineOf } from "./common.js";
import { MACHINE_INFO, MACHINE_KINDS, USAGE, readWorkflow } from "./ui.js";

export const KINDS = [["server", "Server"], ["laptop", "MacBook"], ["mini", "Mac mini"], ["tower", "Desktop"]];
const PROBE_MS = 15000;
const PROBE_TIMEOUT_MS = 8000; // well under PROBE_MS, so rounds don't overlap
const USAGE_MS = 5 * 60000;

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

/** Weekly usage: Claude and Codex have no usage command a script can read, so the person names one
 *  per tool in their workflow.json (`"usage": {"claude": "<command>", "codex": "<command>"}`), each
 *  printing a percent and optionally a detail line. Only the person's own file on this computer is
 *  read, never a space's. Without a command, that tool's usage is hidden. */
export function probeUsage(m, cx) {
  cx.spawn(async () => {
    const cmds = (await readWorkflow(m)).wf.usage ?? {};
    const out = { at: Date.now() };
    for (const tool of ["claude", "codex"]) {
      if (typeof cmds[tool] !== "string" || !cmds[tool]) continue;
      const r = await exec("sh", ["-lc", cmds[tool]], { timeout: 20000 }).catch(() => null);
      const lines = (r?.code === 0 ? r.stdout : "").trim().split("\n");
      const pct = parseInt(lines[0], 10);
      if (Number.isFinite(pct)) out[tool] = { pct: Math.max(0, Math.min(100, pct)), detail: lines[1]?.trim() || "weekly limit" };
    }
    setShared(USAGE, out);
  });
}

/** Weekly usage rows the sidebar shows: only tools some machine has and a command reported. */
export function usageRows() {
  const u = shared(USAGE) ?? {};
  const list = machineList();
  const have = (tool) => list.some((m) => (m.tools ?? []).includes(tool));
  return [["claude", "Claude"], ["codex", "Codex"]].filter(([k]) => u[k] && have(k))
    .map(([k, name]) => ({ key: k, name, pct: u[k].pct, detail: u[k].detail }));
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
  const u = shared(USAGE) ?? {};
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
        .when(Boolean(u[tool]), (el) => el.child(div().font_family(MONO).text_size(10.5).text_color(t.dim).child(`${u[tool].pct}% this week`)))))
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

/** Usage this week: one row per tool with its bar. */
export function renderUsagePop() {
  const t = palette();
  const rows = usageRows();
  return v_flex().id("usage-pop").size_full().p(12).gap(10).bg(t.surface).text_color(t.foreground)
    .child(h_flex().justify_between().items_center()
      .child(div().text_size(13).font_semibold().child("Usage this week"))
      .child(div().font_family(MONO).text_size(11).text_color(t.dim).child("resets Mon")))
    .children(rows.map((r) => v_flex().gap(6)
      .child(h_flex().gap(6).items_center().text_size(12)
        .child(agentIcon(t, r.key))
        .child(div().child(r.name))
        .child(div().flex_1().truncate().font_family(MONO).text_size(10.5).text_color(t.dim).child(r.detail))
        .child(div().font_family(MONO).text_size(11).text_color(r.pct >= 80 ? t.ansi1 : t.muted).child(`${r.pct}%`)))
      .child(div().relative().h(4).rounded(2).bg(t.raised)
        .child(div().absolute().left(0).top(0).h(4).rounded(2).w(`${r.pct}%`).bg(r.pct >= 80 ? t.ansi1 : r.key === "claude" ? t.muted : t.done)))))
    .when(!rows.length, (el) => el.child(div().text_size(11.5).text_color(t.dim)
      .child("Set a command per tool in workflow.json: \"usage\": {\"claude\": \"…\"} printing a percent.")));
}

