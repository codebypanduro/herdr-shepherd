// The Add machine and New space dialogs (panels "addmachine" and "newspace"). Their state lives on
// the dialog's own copy.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import {
  machines, spaces, shared, setShared, exec, hc, readTextFile, home, pickFolder, run, closeOverlay, notify, props,
} from "herdr";
import { MONO, palette } from "./common.js";
import { KINDS } from "./machines.js";
import { MACHINE_KINDS, NEW_SPACE, chip, check, normRemote, shepherdOn, execSafe, failLine, onMachine } from "./ui.js";

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
    const r = await hc(c.args).catch((e) => ({ code: -1, stderr: String(e?.message ?? e), stdout: "" }));
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

const norm = (p) => (p ?? "").replace(/\/+$/, "");
const LOCAL = ""; // this computer's key in m.ns.scans / m.ns.shep
const keyOf = (machine) => machine ?? LOCAL;
const onOf = (machine) => (machine ? { on: machine } : {});
const SCAN_MS = { local: 15000, remote: 20000 }; // a remote scan also pays for ssh

// One script, here or on another machine (exec … {on}): prints "home<TAB>$HOME", then one
// "repo<TAB>path<TAB>origin url<TAB>branch" per git repo under the usual code folders of that
// home and under the folders that machine's spaces sit in (their siblings: "$@", kept only when
// inside that home). A folder reached twice (~/code and ~/Code on a case-insensitive disk) is
// scanned once. Worktrees, .herdr/ and node_modules are skipped; at most 400 repos. A repo whose
// .git is a file (a submodule, an outside worktree) gets its branch from git.
const SCAN = `h=\${HOME%/}; printf 'home\\t%s\\n' "$h"
{ for r in code src Code Projects projects Developer dev repos work git; do printf '%s\\n' "$h/$r"; done
  for p in "$@"; do case "$p" in "$h"/?*) printf '%s\\n' "$p" ;; esac; done; } | sort -u | { seen=" "; while IFS= read -r d; do
  [ -d "$d" ] || continue
  i=$(ls -di "$d" | awk '{ print $1 }')
  case "$seen" in *" $i "*) continue ;; esac
  seen="$seen$i "
  find "$d" -maxdepth 3 -name .git -not -path '*/node_modules/*' -prune 2>/dev/null
done; } | sed 's#/\\.git$##' | grep -v -e '/\\.herdr/' -e '/worktrees/' | sort -u | head -n 400 | while IFS= read -r r; do
  u=$(git -C "$r" config --get remote.origin.url 2>/dev/null)
  if [ -d "$r/.git" ]; then b=$(sed -n 's#^ref: refs/heads/##p' "$r/.git/HEAD" 2>/dev/null); [ -n "$b" ] || b=detached
  else b=$(git -C "$r" symbolic-ref --short -q HEAD 2>/dev/null || echo detached); fi
  printf 'repo\\t%s\\t%s\\t%s\\n' "$r" "$u" "$b"
done; true`;

/** "this mac" and every non-temporary machine, in Herdr's order. */
const nsMachines = () => [{ name: null, label: "this mac" },
  ...machines().filter((x) => x.name && !x.temporary).map((x) => ({ name: x.name, label: x.name, unavailable: x.layout === "unavailable" }))];

/** A folder's real path (symlinks resolved) on its machine: { real }, { missing } when it isn't a
 *  folder there, or { error } when the machine didn't answer. */
const realPath = async (dir, machine) => {
  const r = await execSafe("sh", ["-c", 'cd "$1" 2>/dev/null || exit 3; pwd -P', "real", dir], { ...onOf(machine), timeout: 8000 });
  return r.code === 0 ? { real: r.stdout.trim() } : r.code === 3 ? { missing: true } : { error: failLine(r) };
};

/** The space already in a folder (by path or real path) on that machine, if any. */
const spaceIn = (machine, dir, real) => spaces().find((s) => onMachine(s, machine) && s.folder && [dir, real].includes(norm(s.folder)));

export function initNewSpace(m, cx, InputState) {
  m.ns = { machine: null, scans: {}, shep: {}, sel: null, folder: "", start: false, error: null, busy: false };
  m.nsFilter = InputState.new({ placeholder: "code/…, or a path" });
  m.nsFilter.on("change", (_e, cx) => { m.ns.error = null; cx.notify(); });
  m.nsFilter.on("submit", (_e, cx) => { const r = nsRows(m)[0]; if (r) { m.ns.sel = r.path; addSpace(m, cx); } });
  cx.spawn(async () => { m.nsFilter.focus(); });
  // `shepherd.new-space:<machine>` opens it on that machine.
  const want = props()?.machine ?? null;
  pickMachine(m, cx, nsMachines().some((x) => x.name === want) ? want : null);
}

/** Shows a machine's repos: scans it the first time (one exec there with a short timeout), and asks
 *  once whether start.sh can run there. A scan or check that couldn't reach the machine is dropped
 *  when it's picked again (or Retry), so it asks again. An unavailable machine isn't asked at all. */
function pickMachine(m, cx, machine) {
  const key = keyOf(machine);
  m.ns = { ...m.ns, machine, sel: null, error: null };
  if (m.ns.scans[key]?.error) delete m.ns.scans[key];
  if (m.ns.shep[key]?.unreachable) delete m.ns.shep[key];
  const shep = m.ns.shep[key];
  if (m.ns.start && shep && !shep.dir) m.ns.start = false;
  cx.notify();
  if (nsMachines().find((x) => x.name === machine)?.unavailable) {
    const why = `${machine} is unavailable: Herdr can't reach its core right now.`;
    m.ns.scans[key] = { repos: [], home: null, error: why };
    m.ns.shep[key] = { reason: why.replace(/\.$/, ""), unreachable: true };
    m.ns.start = false;
    return;
  }
  if (!m.ns.scans[key]) {
    m.ns.scans[key] = { repos: null, home: null, error: null };
    cx.spawn(async (cx) => {
      const parents = spaces().filter((s) => onMachine(s, machine) && s.folder).map((s) => norm(s.folder).replace(/\/[^/]+$/, ""));
      const timeout = machine ? SCAN_MS.remote : SCAN_MS.local;
      const r = await execSafe("sh", ["-c", SCAN, "scan", ...new Set(parents)], { ...onOf(machine), timeout });
      const lines = (r.stdout ?? "").split("\n").map((l) => l.split("\t"));
      const home = lines.find((l) => l[0] === "home")?.[1] ?? null;
      if (!home) {
        const why = failLine(r);
        m.ns.scans[key] = { repos: [], home: null, error: `Couldn't reach ${machine ?? "this mac"}: ${/time/i.test(why) ? `no answer in ${timeout / 1000} s` : why}` };
        cx.notify();
        return;
      }
      const have = new Set(spaces().filter((s) => onMachine(s, machine)).map((s) => norm(s.folder)).filter(Boolean));
      const repos = lines.filter((l) => l[0] === "repo" && l[1] && !have.has(l[1])).map(([, path, url, branch]) => ({
        path, rel: path.startsWith(`${home}/`) ? path.slice(home.length + 1) : path, remote: normRemote(url || null), branch: branch ?? "",
      })).sort((a, b) => a.rel.localeCompare(b.rel));
      m.ns.scans[key] = { repos, home, error: null };
      cx.notify();
    });
  }
  if (!(key in m.ns.shep)) {
    m.ns.shep[key] = null; // checking
    cx.spawn(async (cx) => {
      m.ns.shep[key] = await shepherdOn(m, machine).catch((e) => ({ reason: String(e) }));
      cx.notify();
    });
  }
}

/** The typed text as a path on the picked machine: absolute, ~/…, or under its home. */
function typedPath(m) {
  const q = m.nsFilter.value().trim();
  const home = m.ns.scans[keyOf(m.ns.machine)]?.home;
  if (!q || !home) return null;
  const p = q.startsWith("/") ? q : q === "~" ? home : q.startsWith("~/") ? `${home}/${q.slice(2)}` : `${home}/${q}`;
  return norm(p.replace(/\/{2,}/g, "/")) || "/";
}

/** The repos matching the filter, then the typed text as a folder when it looks like a path (a /, or
 *  a leading ~) or no repo matches, and no repo has that path. */
function nsRows(m) {
  const scan = m.ns.scans[keyOf(m.ns.machine)];
  const raw = m.nsFilter.value().trim();
  const q = raw.toLowerCase();
  const rows = (scan?.repos ?? []).filter((r) => !q || r.rel.toLowerCase().includes(q) || r.path.toLowerCase() === q);
  const typed = typedPath(m);
  const pathy = raw.includes("/") || raw.startsWith("~");
  if (typed && (pathy || !rows.length) && !rows.some((r) => r.path === typed)) rows.push({ path: typed, rel: null, typed: true });
  return rows;
}

/** space.new on the picked machine (--machine for another one) in the picked folder, after checking
 *  it's a folder there. A folder that already is a space on that machine selects that space instead.
 *  run() names nothing back, so the sidebar finds the new space (an id that wasn't there before, on
 *  that machine, in this folder) and files it / starts its Shepherd (sidebar.js placeNewSpace). */
function addSpace(m, cx) {
  const dir = norm(m.ns.sel);
  const machine = m.ns.machine;
  if (!dir || m.ns.busy) return;
  m.ns = { ...m.ns, busy: true, error: null };
  cx.notify();
  cx.spawn(async (cx) => {
    const rp = await realPath(dir, machine);
    if (!rp.real) {
      const where = machine ?? "this mac";
      m.ns = { ...m.ns, busy: false, error: rp.missing ? `${dir} isn't a folder on ${where}.` : `Couldn't reach ${where}: ${rp.error}` };
      cx.notify();
      return;
    }
    const { real } = rp;
    const old = spaceIn(machine, dir, real);
    if (old) {
      run("space.select", { id: old.id });
      notify({ title: `${old.name} is already a space`, body: "Selected it instead of making another.", level: "info" });
    } else {
      const start = m.ns.start && Boolean(m.ns.shep[keyOf(machine)]?.dir);
      setShared(NEW_SPACE, { machine, folder: dir, real, before: spaces().map((s) => s.id), group: m.ns.folder || null, start, at: Date.now() });
      run("space.new", { folder: real, machine: machine ?? "" });
    }
    closeOverlay(props()?.overlay);
  });
}

/** For the sidebar: the space New space just made, if it has shown up. */
export function findNewSpace(p) {
  const before = new Set(p.before ?? []);
  return spaces().find((s) => !before.has(s.id) && onMachine(s, p.machine)
    && [p.folder, p.real].includes(norm(s.folder))) ?? null;
}

export function renderNewSpace(m, folders) {
  const t = palette();
  const machine = m.ns.machine;
  const where = machine ?? "this mac";
  const scan = m.ns.scans[keyOf(machine)];
  const rows = nsRows(m);
  const shep = m.ns.shep[keyOf(machine)];
  const canStart = Boolean(shep?.dir);
  // A ticked Start Shepherd waits for the check on this machine, so it's never dropped unseen.
  const pending = m.ns.start && shep == null;
  const ok = Boolean(m.ns.sel) && !m.ns.busy && !pending;
  const row = (r) => h_flex().id(`ns-${r.path}`).gap(10).px(8).py(6).rounded(6).border(1).cursor_pointer()
    .border_color(m.ns.sel === r.path ? t.input : t.surface).bg(m.ns.sel === r.path ? t.hover : t.surface)
    .hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => { m.ns.sel = r.path; m.ns.error = null; cx.notify(); })
    .child(svg("mods/shepherd/icons/folder.svg").w(14).h(12).flex_none().text_color(t.muted))
    .child(v_flex().flex_1().min_w(0)
      .child(div().text_size(12.5).truncate().child(r.typed ? r.path : `~/${r.rel}`))
      .child(div().font_family(MONO).text_size(10.5).text_color(t.dim).truncate()
        .child(r.typed ? `a folder on ${where} · checked when you add it` : r.remote ?? "no remote · local only")))
    .when(!r.typed, (el) => el.child(div().font_family(MONO).text_size(10.5).text_color(t.dim).child(r.branch)));
  const startBox = check(t, "ns-start", "Start Shepherd", m.ns.start,
    (_e, cx) => { m.ns.start = !m.ns.start; cx.notify(); }, { disabled: !canStart && !pending });
  const retry = (_e, cx) => pickMachine(m, cx, machine);
  const retryLink = div().id("ns-retry").text_size(12).text_color(t.accent).cursor_pointer().hover((s) => s.underline())
    .on_click(retry).child("Retry");
  return v_flex().id("new-space").size_full().bg(t.surface).text_color(t.foreground)
    .child(v_flex().px(18).pt(16).pb(10).gap(4)
      .child(div().text_size(15).font_semibold().child("New space"))
      .child(div().text_size(12).text_color(t.dim).child(`Pick a folder on ${where}. Herdr reads its git remote; Shepherd can start there too.`)))
    .child(h_flex().mx(18).mb(10).gap(6).items_center().flex_wrap()
      .child(div().w(22).text_size(12).text_color(t.muted).child("On"))
      .children(nsMachines().map((x) => chip(t, `ns-m-${x.name ?? "local"}`, x.unavailable ? `${x.label} · unavailable` : x.label,
        machine === x.name, (_e, cx) => pickMachine(m, cx, x.name), { dim: x.unavailable }))))
    .child(h_flex().mx(18).h(32).px(8).gap(4).items_center().rounded(6).border(1).border_color(t.input).bg(t.background)
      .when(!/^[/~]/.test(m.nsFilter.value().trim()), (el) => el.child(div().font_family(MONO).text_size(12).text_color(t.dim).child("~/")))
      .child(Input.new(m.nsFilter).flex_1().text_size(13)))
    .child(v_flex().id(`ns-list-${keyOf(machine)}`).flex_1().min_h(0).mx(18).my(8).gap(2).overflow_y_scrollbar()
      .when(!scan || scan.home == null && !scan.error, (el) => el.child(div().p(16).text_size(12).text_color(t.dim)
        .child(machine ? `reading ${machine}…` : "Looking for git repos…")))
      .when(Boolean(scan?.error), (el) => el.child(h_flex().p(16).gap(10).items_center()
        .child(div().flex_1().min_w(0).text_size(12).text_color(t.ansi1).child(scan.error)).child(retryLink)))
      .when(scan?.home != null, (el) => el.children(rows.map(row))
        .when(!rows.length, (el) => el.child(div().p(16).text_size(12).text_color(t.dim)
          .child(scan.repos.length ? "No folders match." : `No git repos found on ${where}: type a path.`)))))
    .when(Boolean(m.ns.error), (el) => el.child(div().mx(18).mb(8).text_size(12).text_color(t.ansi1).child(m.ns.error)))
    .child(h_flex().mx(18).mb(10).gap(8).items_center().flex_wrap()
      .child(div().text_size(12).text_color(t.muted).child("Put in"))
      .child(chip(t, "ns-nofolder", "No folder", !m.ns.folder, (_e, cx) => { m.ns.folder = ""; cx.notify(); }, { mono: false }))
      .children(folders.map((f) => chip(t, `ns-f-${f.id}`, f.name, m.ns.folder === f.id, (_e, cx) => { m.ns.folder = f.id; cx.notify(); }, { mono: false })))
      .child(div().flex_1())
      .child(startBox))
    .when(!canStart, (el) => el.child(h_flex().mx(18).mb(10).gap(10).items_center()
      .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.dim).truncate()
        .child(shep == null ? `Checking whether Shepherd can start on ${where}…` : `Can't start Shepherd on ${where}: ${shep.reason}.`))
      .when(Boolean(shep?.unreachable) && !scan?.error, (el) => el.child(retryLink))))
    .child(h_flex().px(18).py(12).gap(8).items_center().border_t(1).border_color(t.border)
      .when(!machine, (el) => el.child(div().id("ns-finder").px(10).h(28).flex().items_center().rounded(5).border(1).border_color(t.input).cursor_pointer()
        .text_size(12).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => cx.spawn(async (cx) => {
          const dir = await pickFolder({ prompt: "Add space" }).catch(() => null);
          if (dir) { m.ns.sel = dir; addSpace(m, cx); }
        }))
        .child("Choose in Finder…")))
      .child(div().flex_1())
      .child(footerButton(t, "ns-cancel", "Cancel", false, true, () => closeOverlay(props()?.overlay)))
      .child(footerButton(t, "ns-add", m.ns.busy ? "Adding…" : "Add space", true, ok, (_e, cx) => addSpace(m, cx))));
}
