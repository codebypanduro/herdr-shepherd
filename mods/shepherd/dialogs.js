// The Add machine and New space dialogs (panels "addmachine" and "newspace"). Their state lives on
// the dialog's own copy.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import {
  machines, spaces, shared, setShared, exec, hc, readTextFile, home, pickFolder, run, closeOverlay, notify, props,
} from "herdr";
import { MONO, palette } from "./common.js";
import { KINDS } from "./machines.js";
import { MACHINE_KINDS, NEW_SPACE, chip, check, normRemote } from "./ui.js";

const stop = (_e, cx) => cx.stop_propagation();

const footerButton = (t, id, label, primary, ok, onClick) => div().id(id).px(12).h(28).flex().items_center().rounded(5).text_size(12)
  .when(primary, (el) => el.font_semibold().bg(ok ? t.solid : t.raised).text_color(ok ? t.solid_foreground : t.dim))
  .when(!primary, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover)))
  .when(ok, (el) => el.cursor_pointer())
  .on_click(onClick).child(label);

// ---- Add machine ----------------------------------------------------------------------------

const NAME_RE = /^[\w.-]+$/;
// What `hc machine add` does, in order. It's one call: the list shows where a failure happened.
const STEPS = ["Connecting over SSH", "Checking herdr-core", "Installing herdr-core if it's missing", "Finding agents: claude, codex"];

export function initAddMachine(m, cx, InputState) {
  m.am = { kind: null, temp: false, phase: 0, error: null, failedAt: null, hints: [] };
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

/** The default name: the host's first part ("vps" for "me@vps.example.com"), the user for an IP
 *  ("ubuntu@10.0.0.4" → "ubuntu"), else "box". */
const defaultName = (host) => {
  const user = host.includes("@") ? host.split("@")[0] : "";
  const h = host.split("@").pop().replace(/:\d+$/, "");
  const n = /^[\d.]+$/.test(h) || h.includes(":") ? user : h.split(".")[0];
  return NAME_RE.test(n) ? n : "box";
};

/** The command and whether it can run: a name hc accepts, a host that isn't a flag. */
export function amCommand(m) {
  const host = m.amHost.value().trim();
  const name = m.amName.value().trim() || (host ? defaultName(host) : "");
  const problem = !host ? null
    : host.startsWith("-") || /\s/.test(host) ? "The SSH host can't start with - or hold spaces."
    : !NAME_RE.test(name) ? "The name may use letters, digits, . _ and - only."
    : machines().some((x) => x.name === name) ? `${name} is taken: pick another name.` : null;
  const args = ["machine", "add", "--json", "--name", name, ...(m.am.temp ? ["--temp"] : []), "--", host];
  const line = `hc machine add --name ${name || "<name>"}${m.am.temp ? " --temp" : ""} ${host || "<host>"}`;
  return { host, name, args, line, ok: Boolean(host) && !problem, problem };
}

/** Runs `hc machine add` without a terminal. ssh can't ask for a password or a new host key here:
 *  then the dialog shows hc's message and the command to run in a terminal instead. */
function addMachine(m, cx) {
  const c = amCommand(m);
  if (!c.ok || m.am.phase === 1) return;
  m.am = { ...m.am, phase: 1, error: null, failedAt: null };
  cx.notify();
  cx.spawn(async (cx) => {
    const r = await hc(c.args).catch((e) => ({ code: -1, stderr: String(e), stdout: "" }));
    if (r.code === 0) {
      if (m.am.kind) setShared(MACHINE_KINDS, { ...(shared(MACHINE_KINDS) ?? {}), [c.name]: m.am.kind });
      notify({ title: `Added ${c.name}`, body: "Make a new space there, or start agents on it.", level: "info" });
      closeOverlay(props()?.overlay);
      return;
    }
    let msg = (r.stderr || r.stdout || "").trim();
    let kind = null;
    try { const e = JSON.parse(msg).error; kind = e?.kind; msg = [e?.message, e?.hint].filter(Boolean).join(". ") || msg; } catch { /* plain text */ }
    m.am = { ...m.am, phase: 2, failedAt: kind === "unreachable" ? 0 : 1,
      error: msg.split("\n").slice(0, 2).join(" ") || `hc machine add failed (${r.code})` };
    cx.notify();
  });
}

export function renderAddMachine(m) {
  const t = palette();
  const c = amCommand(m);
  const field = (label, input, extra) => v_flex().gap(6)
    .child(div().text_size(12).text_color(t.muted).child(label))
    .child(Input.new(input).h(30).px(8).text_size(13).rounded(5).border(1).border_color(t.input).bg(t.background))
    .when(Boolean(extra), (el) => el.child(extra));
  const step = (label, i) => {
    const state = m.am.phase === 1 ? (i === 0 ? "run" : "wait") : m.am.failedAt == null ? "wait" : i < m.am.failedAt ? "ok" : i === m.am.failedAt ? "fail" : "wait";
    const [mark, color] = { run: ["●", t.working], ok: ["✓", t.done], fail: ["✕", t.ansi1], wait: ["○", t.dim] }[state];
    return h_flex().gap(8).text_size(12).text_color(state === "wait" ? t.dim : t.foreground)
      .child(div().w(12).text_color(color).child(mark)).child(label);
  };
  return v_flex().id("add-machine").size_full().bg(t.surface).text_color(t.foreground)
    .child(v_flex().px(18).pt(16).pb(10).gap(4)
      .child(div().text_size(15).font_semibold().child("Add machine"))
      .child(div().text_size(12).text_color(t.dim).child("Any machine you can reach over SSH. Its agents keep running while your laptop sleeps.")))
    .child(v_flex().flex_1().min_h(0).px(18).gap(14).overflow_y_scrollbar()
      .child(field("SSH host", m.amHost, h_flex().gap(6).flex_wrap().children(m.am.hints.map((h) =>
        div().id(`hint-${h}`).px(8).h(22).flex().items_center().rounded(11).bg(t.raised).cursor_pointer()
          .font_family(MONO).text_size(11).text_color(t.muted).hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { m.amHost.set_value(h); cx.notify(); }).child(h)))))
      .child(field("Name in Herdr", m.amName))
      .child(v_flex().gap(6)
        .child(div().text_size(12).text_color(t.muted).child("Kind"))
        .child(h_flex().gap(6)
          .child(chip(t, "kind-auto", "Detect", !m.am.kind, (_e, cx) => { m.am.kind = null; cx.notify(); }, { mono: false }))
          .children(KINDS.map(([k, label]) => chip(t, `kind-${k}`, label, m.am.kind === k, (_e, cx) => { m.am.kind = k; cx.notify(); }, { mono: false })))))
      .child(check(t, "am-temp", "Temporary sandbox · hide its spaces, remove when done", m.am.temp, (_e, cx) => { m.am.temp = !m.am.temp; cx.notify(); }))
      .child(h_flex().id("am-cmd").gap(8).p(10).rounded(6).bg(t.background).border(1).border_color(t.border)
        .font_family(MONO).text_size(11.5)
        .child(div().text_color(t.dim).child("$"))
        .child(div().flex_1().truncate().child(c.line))
        .child(div().id("am-copy").px(6).rounded(4).cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .on_mouse_down("left", stop)
          .on_click(() => exec("sh", ["-c", 'printf %s "$1" | pbcopy', "copy", c.line]).catch(() => null)).child("Copy")))
      .when(Boolean(c.problem), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(c.problem)))
      .when(m.am.phase > 0, (el) => el.child(v_flex().gap(6).children(STEPS.map(step))
        .when(Boolean(m.am.error), (el) => el.child(div().pt(4).text_size(12).text_color(t.ansi1).child(m.am.error))
          .child(div().text_size(12).text_color(t.dim).child("If it needs a password or a new host key, run the command above in a terminal: it asks there."))))))
    .child(h_flex().px(18).py(12).gap(8).items_center().border_t(1).border_color(t.border)
      .child(div().flex_1().text_size(11.5).text_color(t.dim).child("Installs herdr-core there if it's missing."))
      .child(footerButton(t, "am-cancel", "Cancel", false, true, () => closeOverlay(props()?.overlay)))
      .child(footerButton(t, "am-add", m.am.phase === 1 ? "Connecting…" : "Add machine", true, c.ok && m.am.phase !== 1, (_e, cx) => addMachine(m, cx))));
}

// ---- New space ------------------------------------------------------------------------------

const SCAN_ROOTS = ["code", "src", "Code", "Projects", "projects", "Developer", "dev", "repos", "work", "git"];
const norm = (p) => (p ?? "").replace(/\/+$/, "");

/** A folder's real path (symlinks resolved), here. */
const realPath = async (dir) => {
  const r = await exec("sh", ["-c", 'cd "$1" 2>/dev/null && pwd -P', "real", dir], { timeout: 5000 }).catch(() => null);
  return r?.code === 0 ? r.stdout.trim() : norm(dir);
};

/** The local space already in a folder (by path or real path), if any. */
const spaceIn = (dir, real) => spaces().find((s) => !s.machine && s.folder && [dir, real].includes(norm(s.folder)));

export function initNewSpace(m, cx, InputState) {
  m.ns = { repos: null, sel: null, folder: "", start: false, error: null };
  m.nsFilter = InputState.new({ placeholder: "code/…" });
  m.nsFilter.on("change", (_e, cx) => cx.notify());
  m.nsFilter.on("submit", (_e, cx) => { const r = nsRows(m)[0]; if (r) { m.ns.sel = r.path; addSpace(m, cx); } });
  cx.spawn(async (cx) => {
    m.nsFilter.focus();
    const h = home();
    // The usual code folders, and the folders this computer's spaces sit in (their siblings).
    const parents = spaces().filter((s) => !s.machine && s.folder?.startsWith(`${h}/`))
      .map((s) => norm(s.folder).replace(/\/[^/]+$/, "")).filter((d) => d !== h);
    const roots = [...new Set([...SCAN_ROOTS.map((r) => `${h}/${r}`), ...parents])];
    const r = await exec("sh", ["-c", `for d in "$@"; do [ -d "$d" ] && find "$d" -maxdepth 3 -name .git -not -path '*/node_modules/*' -prune 2>/dev/null; done; true`, "scan", ...roots], { timeout: 15000 }).catch(() => null);
    const have = new Set(spaces().map((s) => !s.machine && norm(s.folder)).filter(Boolean));
    const dirs = [...new Set((r?.stdout ?? "").split("\n").filter(Boolean).map((p) => p.replace(/\/\.git$/, "")))]
      .filter((d) => !d.includes("/.herdr/") && !d.includes("/worktrees/") && !have.has(d)).sort();
    m.ns.repos = await Promise.all(dirs.slice(0, 400).map(async (dir) => {
      const conf = await readTextFile(`${dir}/.git/config`).catch(() => null);
      const head = await readTextFile(`${dir}/.git/HEAD`).catch(() => null);
      const url = conf?.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/)?.[1] ?? null;
      return { path: dir, rel: dir.startsWith(`${h}/`) ? dir.slice(h.length + 1) : dir, remote: normRemote(url),
        branch: head?.match(/ref: refs\/heads\/(.+)/)?.[1]?.trim() ?? (head ? "detached" : "") };
    }));
    cx.notify();
  });
}

function nsRows(m) {
  const q = m.nsFilter.value().trim().toLowerCase();
  return (m.ns.repos ?? []).filter((r) => !q || r.rel.toLowerCase().includes(q));
}

/** space.new on this computer in the picked folder. A folder that already is a space selects that
 *  space instead. run() names nothing back, so the sidebar finds the new space (an id that wasn't
 *  there before, in this folder) and files it / starts its Shepherd (sidebar.js placeNewSpace). */
function addSpace(m, cx) {
  const dir = norm(m.ns.sel);
  if (!dir) return;
  cx.spawn(async () => {
    const real = await realPath(dir);
    const old = spaceIn(dir, real);
    if (old) {
      run("space.select", { id: old.id });
      notify({ title: `${old.name} is already a space`, body: "Selected it instead of making another.", level: "info" });
    } else {
      setShared(NEW_SPACE, { folder: dir, real, before: spaces().map((s) => s.id), group: m.ns.folder || null, start: m.ns.start, at: Date.now() });
      run("space.new", { folder: dir, machine: "" });
    }
    closeOverlay(props()?.overlay);
  });
}

/** For the sidebar: the space New space just made, if it has shown up. */
export function findNewSpace(p) {
  const before = new Set(p.before ?? []);
  return spaces().find((s) => !before.has(s.id) && !s.machine && [p.folder, p.real].includes(norm(s.folder))) ?? null;
}

export function renderNewSpace(m, folders) {
  const t = palette();
  const rows = nsRows(m);
  const ok = Boolean(m.ns.sel);
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
      .when(m.ns.repos == null, (el) => el.child(div().p(16).text_size(12).text_color(t.dim).child("Looking for git repos…")))
      .when(m.ns.repos != null && !rows.length, (el) => el.child(div().p(16).text_size(12).text_color(t.dim).child("No folders match."))))
    .child(h_flex().mx(18).mb(10).gap(8).items_center().flex_wrap()
      .child(div().text_size(12).text_color(t.muted).child("Put in"))
      .child(chip(t, "ns-nofolder", "No folder", !m.ns.folder, (_e, cx) => { m.ns.folder = ""; cx.notify(); }, { mono: false }))
      .children(folders.map((f) => chip(t, `ns-f-${f.id}`, f.name, m.ns.folder === f.id, (_e, cx) => { m.ns.folder = f.id; cx.notify(); }, { mono: false })))
      .child(div().flex_1())
      .child(check(t, "ns-start", "Start Shepherd", m.ns.start, (_e, cx) => { m.ns.start = !m.ns.start; cx.notify(); })))
    .child(h_flex().px(18).py(12).gap(8).items_center().border_t(1).border_color(t.border)
      .child(div().id("ns-finder").px(10).h(28).flex().items_center().rounded(5).border(1).border_color(t.input).cursor_pointer()
        .text_size(12).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => cx.spawn(async (cx) => {
          const dir = await pickFolder({ prompt: "Add space" }).catch(() => null);
          if (dir) { m.ns.sel = dir; addSpace(m, cx); }
        }))
        .child("Choose in Finder…"))
      .child(div().flex_1())
      .child(footerButton(t, "ns-cancel", "Cancel", false, true, () => closeOverlay(props()?.overlay)))
      .child(footerButton(t, "ns-add", "Add space", true, ok, (_e, cx) => addSpace(m, cx))));
}
