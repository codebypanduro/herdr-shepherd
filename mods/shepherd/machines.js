// Machines for the Spaces sidebar and the settings overlays: what each one is (kind, model), its
// load (cpu, mem, disk), which agents it has, plus the machine popover, weekly usage, Add machine
// and New space. The sidebar copy probes every machine and keeps the results in shared state, so
// popovers and settings overlays (other copies) read the same numbers.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import {
  machines, terminals, shared, setShared, exec, hc, knownAgents, readTextFile, appHome, home, pickFolder,
  run, closeOverlay, notify, props,
} from "herdr";
import { MONO, palette, machineOf } from "./common.js";

export const MACHINE_INFO = "shepherd.machineInfo"; // { "<machine name, '' here>": {cpu, mem, disk, kind, model, tools, at, error} }
export const MACHINE_KINDS = "shepherd.machineKinds"; // the person's pick in Add machine: { name: kind }
export const USAGE = "shepherd.usage"; // { claude: {pct, detail}, codex: {pct, detail}, at }
export const FOLDERS = "shepherd.folders"; // sidebar folders: [{ id, name, open }]
export const SPACE_FOLDERS = "shepherd.spaceFolders"; // { space id: folder id }

export const KINDS = [["server", "Server"], ["laptop", "MacBook"], ["mini", "Mac mini"], ["tower", "Desktop"]];
const PROBE_MS = 15000;
const USAGE_MS = 5 * 60000;

/** Every machine the sidebar shows: this one first, then `machines()` (Herdr leaves out temporary ones). */
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
 *  machine answers, and the weekly usage commands (workflow `usage`) every 5 minutes. */
export function startProbes(m, cx) {
  cx.timer.every(PROBE_MS, (cx) => probeMachines(cx));
  probeMachines(cx);
  cx.timer.every(USAGE_MS, (cx) => probeUsage(m, cx));
  cx.timer.after(3000, (cx) => probeUsage(m, cx)); // once the workflow has loaded
}

/** One round of machine.sh on every machine that answers. Kind and model are asked once. */
export function probeMachines(cx) {
  cx.spawn(async () => {
    const script = await readTextFile(`${appHome()}/mods/shepherd/machine.sh`).catch(() => null);
    if (!script) return;
    await Promise.all([{ name: null }, ...machines().filter((x) => x.name && x.layout !== "unavailable")].map(async (mc) => {
      const key = mc.name ?? "";
      const prev = (shared(MACHINE_INFO) ?? {})[key] ?? {};
      const full = !prev.kind;
      const r = await exec("sh", ["-c", script, "machine.sh", full ? "full" : ""], { on: mc.name, timeout: 15000 }).catch((e) => ({ code: -1, stderr: String(e) }));
      const next = { ...prev, at: Date.now() };
      if (r.code === 0) {
        for (const line of r.stdout.split("\n")) {
          const [k, ...v] = line.split("=");
          const val = v.join("=").trim();
          if (["cpu", "mem", "disk"].includes(k) && /^\d+$/.test(val)) next[k] = Number(val);
          if ((k === "kind" || k === "model") && val) next[k] = val;
        }
        delete next.error;
      } else next.error = (r.stderr || "unreachable").split("\n")[0];
      if (!next.tools && !next.error) {
        const agents = await knownAgents({ on: mc.name }).catch(() => null);
        if (agents) next.tools = agents.filter((a) => a.installed && ["claude", "codex"].includes(a.key)).map((a) => a.key);
      }
      setShared(MACHINE_INFO, { ...(shared(MACHINE_INFO) ?? {}), [key]: next });
    }));
  });
}

/** Weekly usage: Claude and Codex have no usage command a script can read, so the person names one
 *  per tool in workflow.json (`"usage": {"claude": "<command>", "codex": "<command>"}`), each printing
 *  a percent and optionally a detail line. Without one, that tool's usage is hidden. */
export function probeUsage(m, cx) {
  cx.spawn(async () => {
    const cmds = m.settings().usage ?? {};
    const out = { at: Date.now() };
    for (const tool of ["claude", "codex"]) {
      if (!cmds[tool]) continue;
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

// ---- Add machine ----------------------------------------------------------------------------

/** The Add machine dialog's state lives on its copy: { host, kind, temp, phase, steps, error }. */
export function initAddMachine(m, cx, InputState) {
  m.am = { kind: "server", temp: false, phase: 0, error: null, hints: [] };
  m.amHost = InputState.new({ placeholder: "user@host, or a name from ~/.ssh/config" });
  m.amName = InputState.new({ placeholder: "vps-2" });
  m.amHost.on("change", (_e, cx) => cx.notify());
  m.amName.on("change", (_e, cx) => cx.notify());
  m.amHost.on("submit", (_e, cx) => addMachine(m, cx));
  m.amName.on("submit", (_e, cx) => addMachine(m, cx));
  cx.spawn(async (cx) => {
    m.amHost.focus();
    // Hints: Host names from ~/.ssh/config that aren't machines yet.
    const conf = await readTextFile(`${home()}/.ssh/config`).catch(() => null);
    const have = new Set(machines().map((x) => x.name));
    m.am.hints = [...new Set((conf ?? "").split("\n").map((l) => l.trim().match(/^Host\s+(.+)$/i)?.[1] ?? "")
      .flatMap((h) => h.split(/\s+/)).filter((h) => h && !/[*?!]/.test(h) && !have.has(h)))].slice(0, 6);
    cx.notify();
  });
}

const defaultName = (host) => {
  const h = host.split("@").pop().split(":")[0];
  return /^[\d.]+$/.test(h) ? host.split("@")[0] || "box" : h.split(".")[0];
};

export function amCommand(m) {
  const host = m.amHost.value().trim();
  const name = m.amName.value().trim() || (host ? defaultName(host) : "");
  return { host, name, args: ["machine", "add", "--json", "--name", name || "<name>", ...(m.am.temp ? ["--temp"] : []), host || "<host>"] };
}

/** Runs `hc machine add` without a terminal. ssh can't ask for a password or a new host key here:
 *  then the dialog shows the command to run in a terminal instead. */
function addMachine(m, cx) {
  const { host, name, args } = amCommand(m);
  if (!host || m.am.phase === 1) return;
  if (machines().some((x) => x.name === name)) { m.am.error = `${name} is taken: pick another name.`; cx.notify(); return; }
  m.am = { ...m.am, phase: 1, error: null };
  cx.notify();
  cx.spawn(async (cx) => {
    const r = await hc(args).catch((e) => ({ code: -1, stderr: String(e), stdout: "" }));
    if (r.code === 0) {
      if (m.am.kind) setShared(MACHINE_KINDS, { ...(shared(MACHINE_KINDS) ?? {}), [name]: m.am.kind });
      notify({ title: `Added ${name}`, body: `Pick it in a space's settings, or make a new space there.`, level: "info" });
      closeOverlay(props()?.overlay);
      return;
    }
    let msg = (r.stderr || r.stdout || "").trim();
    try { msg = JSON.parse(msg).error?.message ?? msg; } catch { /* plain text */ }
    m.am = { ...m.am, phase: 2, error: msg.split("\n")[0] || `hc machine add failed (${r.code})` };
    cx.notify();
  });
}

export function renderAddMachine(m) {
  const t = palette();
  const { host, name } = amCommand(m);
  const cmd = `hc machine add --name ${name || "<name>"}${m.am.temp ? " --temp" : ""} ${host || "<host>"}`;
  const ok = Boolean(host) && m.am.phase !== 1;
  const field = (label, input, extra) => v_flex().gap(6)
    .child(div().text_size(12).text_color(t.muted).child(label))
    .child(Input.new(input).h(30).px(8).text_size(13).rounded(5).border(1).border_color(t.input).bg(t.background))
    .when(Boolean(extra), (el) => el.child(extra));
  const chip = (id, label, on, onClick) => div().id(id).h(26).px(10).flex().items_center().rounded(5).border(1)
    .cursor_pointer().text_size(12)
    .border_color(on ? t.foreground : t.input).bg(on ? t.foreground : t.background).text_color(on ? t.background : t.foreground)
    .on_click(onClick).child(label);
  const stop = (_e, cx) => cx.stop_propagation();
  return v_flex().id("add-machine").size_full().bg(t.surface).text_color(t.foreground)
    .child(v_flex().px(18).pt(16).pb(10).gap(4)
      .child(div().text_size(15).font_semibold().child("Add machine"))
      .child(div().text_size(12).text_color(t.dim).child("Any machine you can reach over SSH. Its agents keep running while your laptop sleeps.")))
    .child(v_flex().flex_1().px(18).gap(14).overflow_y_scrollbar()
      .child(field("SSH host", m.amHost, h_flex().gap(6).flex_wrap().children(m.am.hints.map((h) =>
        div().id(`hint-${h}`).px(8).h(22).flex().items_center().rounded(11).bg(t.raised).cursor_pointer()
          .font_family(MONO).text_size(11).text_color(t.muted).hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { m.amHost.set_value(h); cx.notify(); }).child(h)))))
      .child(field("Name in Herdr", m.amName))
      .child(v_flex().gap(6)
        .child(div().text_size(12).text_color(t.muted).child("Kind"))
        .child(h_flex().gap(6).children(KINDS.map(([k, label]) => chip(`kind-${k}`, label, m.am.kind === k, (_e, cx) => { m.am.kind = k; cx.notify(); })))))
      .child(h_flex().id("am-temp").gap(8).items_center().cursor_pointer().text_size(12.5)
        .on_click((_e, cx) => { m.am.temp = !m.am.temp; cx.notify(); })
        .child(div().size(14).rounded(3).border(1).flex().items_center().justify_center().text_size(10)
          .border_color(m.am.temp ? t.accent : t.input).bg(m.am.temp ? t.accent : t.background).text_color(t.accent_foreground)
          .child(m.am.temp ? "✓" : ""))
        .child("Temporary sandbox · hide its spaces, remove when done"))
      .child(h_flex().id("am-cmd").gap(8).p(10).rounded(6).bg(t.background).border(1).border_color(t.border)
        .font_family(MONO).text_size(11.5)
        .child(div().text_color(t.dim).child("$"))
        .child(div().flex_1().truncate().child(cmd))
        .child(div().id("am-copy").px(6).rounded(4).cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .on_mouse_down("left", stop)
          .on_click(() => exec("sh", ["-c", `printf %s "$1" | pbcopy`, "copy", cmd]).catch(() => null)).child("Copy")))
      .when(m.am.phase > 0, (el) => el.child(v_flex().gap(6).text_size(12)
        .child(h_flex().gap(8).child(div().text_color(m.am.phase === 1 ? t.working : m.am.error ? t.ansi1 : t.done).child(m.am.phase === 1 ? "●" : m.am.error ? "✕" : "✓"))
          .child(div().child("Connecting over SSH, checking herdr-core")))
        .when(Boolean(m.am.error), (el) => el.child(div().text_color(t.ansi1).child(m.am.error))
          .child(div().text_color(t.dim).child("If it needs a password or a new host key, run the command above in a terminal: it asks there."))))))
    .child(h_flex().px(18).py(12).gap(8).items_center().border_t(1).border_color(t.border)
      .child(div().flex_1().text_size(11.5).text_color(t.dim).child("Installs herdr-core there if it's missing."))
      .child(div().id("am-cancel").px(12).h(28).flex().items_center().rounded(5).cursor_pointer().text_size(12).text_color(t.muted)
        .hover((s) => s.bg(t.hover)).on_click(() => closeOverlay(props()?.overlay)).child("Cancel"))
      .child(div().id("am-add").px(12).h(28).flex().items_center().rounded(5).text_size(12).font_semibold()
        .bg(ok ? t.solid : t.raised).text_color(ok ? t.solid_foreground : t.dim).when(ok, (el) => el.cursor_pointer())
        .on_click((_e, cx) => addMachine(m, cx)).child(m.am.phase === 1 ? "Connecting…" : "Add machine")));
}

// ---- New space ------------------------------------------------------------------------------

const SCAN_ROOTS = ["code", "src", "Code", "Projects", "projects", "Developer", "dev", "repos", "work", "git"];

/** Git repos under the usual code folders in home, two levels deep, for the New space list. */
export function initNewSpace(m, cx, InputState) {
  m.ns = { repos: null, sel: null, folder: "", start: false };
  m.nsFilter = InputState.new({ placeholder: "code/…" });
  m.nsFilter.on("change", (_e, cx) => cx.notify());
  m.nsFilter.on("submit", (_e, cx) => { const r = nsRows(m)[0]; if (r) { m.ns.sel = r.path; addSpace(m, cx); } });
  cx.spawn(async (cx) => {
    m.nsFilter.focus();
    const h = home();
    const roots = SCAN_ROOTS.map((r) => `${h}/${r}`);
    const r = await exec("sh", ["-c", `for d in "$@"; do [ -d "$d" ] && find "$d" -maxdepth 4 -name .git -not -path '*/node_modules/*' -prune 2>/dev/null; done; true`, "scan", ...roots], { timeout: 15000 }).catch(() => null);
    const have = new Set(m.allSpaces().map((s) => !s.machine && s.folder).filter(Boolean));
    const dirs = [...new Set((r?.stdout ?? "").split("\n").filter(Boolean).map((p) => p.replace(/\/\.git$/, "")))]
      .filter((d) => !d.includes("/.herdr/") && !have.has(d)).sort();
    m.ns.repos = await Promise.all(dirs.slice(0, 400).map(async (dir) => {
      const conf = await readTextFile(`${dir}/.git/config`).catch(() => null);
      const head = await readTextFile(`${dir}/.git/HEAD`).catch(() => null);
      const url = conf?.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/)?.[1] ?? null;
      return { path: dir, rel: dir.startsWith(`${h}/`) ? dir.slice(h.length + 1) : dir, remote: url ? url.replace(/^(git@|https:\/\/)/, "").replace(/:/, "/").replace(/\.git$/, "") : null,
        branch: head?.match(/ref: refs\/heads\/(.+)/)?.[1]?.trim() ?? (head ? "detached" : "") };
    }));
    cx.notify();
  });
}

function nsRows(m) {
  const q = m.nsFilter.value().trim().toLowerCase();
  return (m.ns.repos ?? []).filter((r) => !q || r.rel.toLowerCase().includes(q));
}

/** space.new on this computer in the picked folder; the sidebar puts it in the picked folder when it
 *  shows up (run() returns nothing to name it by). Start Shepherd runs start.sh in a tab there. */
function addSpace(m, cx) {
  const dir = m.ns.sel;
  if (!dir) return;
  const pending = { folder: dir, group: m.ns.folder || null, start: m.ns.start, at: Date.now() };
  setShared("shepherd.newSpace", pending);
  run("space.new", { folder: dir, machine: "" });
  closeOverlay(props()?.overlay);
}

export function renderNewSpace(m, folders) {
  const t = palette();
  const rows = nsRows(m);
  const ok = Boolean(m.ns.sel);
  const opt = (id, label, on, onClick) => div().id(id).h(24).px(9).flex().items_center().rounded(5).border(1).cursor_pointer()
    .text_size(12).border_color(on ? t.foreground : t.input).bg(on ? t.foreground : t.background).text_color(on ? t.background : t.foreground)
    .on_click(onClick).child(label);
  return v_flex().id("new-space").size_full().bg(t.surface).text_color(t.foreground)
    .child(v_flex().px(18).pt(16).pb(10).gap(4)
      .child(div().text_size(15).font_semibold().child("New space"))
      .child(div().text_size(12).text_color(t.dim).child("Pick a folder on this mac. Herdr reads its git remote; Shepherd can start there too.")))
    .child(h_flex().mx(18).h(32).px(8).gap(4).items_center().rounded(6).border(1).border_color(t.input).bg(t.background)
      .child(div().font_family(MONO).text_size(12).text_color(t.dim).child("~/"))
      .child(Input.new(m.nsFilter).flex_1().text_size(13)))
    .child(v_flex().id("ns-list").flex_1().min_h(0).mx(18).my(8).gap(2).overflow_y_scrollbar()
      .children(rows.map((r) => h_flex().id(`ns-${r.path}`).gap(10).px(8).py(6).rounded(6).border(1).cursor_pointer()
        .border_color(m.ns.sel === r.path ? t.input : t.surface).bg(m.ns.sel === r.path ? t.hover : t.surface)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { m.ns.sel = r.path; cx.notify(); })
        .child(svg("mods/shepherd/icons/folder.svg").w(14).h(12).flex_none().text_color(t.muted))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(12.5).truncate().child(`~/${r.rel}`))
          .child(div().font_family(MONO).text_size(10.5).text_color(t.dim).truncate().child(r.remote ?? "no remote · local only")))
        .child(div().font_family(MONO).text_size(10.5).text_color(t.dim).child(r.branch))))
      .when(m.ns.repos == null, (el) => el.child(div().p(16).text_size(12).text_color(t.dim).child("Looking for git repos in ~/code, ~/src, ~/Projects…")))
      .when(m.ns.repos != null && !rows.length, (el) => el.child(div().p(16).text_size(12).text_color(t.dim).child("No folders match."))))
    .child(h_flex().mx(18).mb(10).gap(8).items_center().flex_wrap()
      .child(div().text_size(12).text_color(t.muted).child("Put in"))
      .child(opt("ns-nofolder", "No folder", !m.ns.folder, (_e, cx) => { m.ns.folder = ""; cx.notify(); }))
      .children(folders.map((f) => opt(`ns-f-${f.id}`, f.name, m.ns.folder === f.id, (_e, cx) => { m.ns.folder = f.id; cx.notify(); })))
      .child(div().flex_1())
      .child(h_flex().id("ns-start").gap(6).items_center().cursor_pointer().text_size(12)
        .on_click((_e, cx) => { m.ns.start = !m.ns.start; cx.notify(); })
        .child(div().size(14).rounded(3).border(1).flex().items_center().justify_center().text_size(10)
          .border_color(m.ns.start ? t.accent : t.input).bg(m.ns.start ? t.accent : t.background).text_color(t.accent_foreground)
          .child(m.ns.start ? "✓" : ""))
        .child("Start Shepherd")))
    .child(h_flex().px(18).py(12).gap(8).items_center().border_t(1).border_color(t.border)
      .child(div().id("ns-finder").px(10).h(28).flex().items_center().rounded(5).border(1).border_color(t.input).cursor_pointer()
        .text_size(12).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => cx.spawn(async (cx) => {
          const dir = await pickFolder({ prompt: "Add space" }).catch(() => null);
          if (dir) { m.ns.sel = dir; addSpace(m, cx); }
        }))
        .child("Choose in Finder…"))
      .child(div().flex_1())
      .child(div().id("ns-cancel").px(12).h(28).flex().items_center().rounded(5).cursor_pointer().text_size(12).text_color(t.muted)
        .hover((s) => s.bg(t.hover)).on_click(() => closeOverlay(props()?.overlay)).child("Cancel"))
      .child(div().id("ns-add").px(12).h(28).flex().items_center().rounded(5).text_size(12).font_semibold()
        .bg(ok ? t.solid : t.raised).text_color(ok ? t.solid_foreground : t.dim).when(ok, (el) => el.cursor_pointer())
        .on_click((_e, cx) => addSpace(m, cx)).child("Add space")));
}
