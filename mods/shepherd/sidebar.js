// The Spaces sidebar (panel "spaces", 240px): SPACES with + (New space, New folder), folders,
// one row per space (org avatar with its open-question badge, name, machine · branch · worktrees,
// status dot with open tasks, ⚙ Space settings), and a footer with every machine, + Add machine
// and the weekly usage. Folders are the sidebar's own (shared state); drag a space onto one.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { spaces, terminals, shared, setShared, exec, appHome, run, openOverlay, closeOverlay, props } from "herdr";
import { MONO, palette } from "./common.js";
import {
  FOLDERS, SPACE_FOLDERS, machineList, machineByName, machineIcon, agentIcon, usageRows, startProbes,
} from "./machines.js";

const INFO_MS = 60000; // org and worktree count per space
const AVATARS = "data/shepherd-avatars"; // under the app's home: image() reads only there

export const folders = () => shared(FOLDERS) ?? [];
export const folderOf = (spaceId) => {
  const f = (shared(SPACE_FOLDERS) ?? {})[spaceId];
  return f && folders().some((x) => x.id === f) ? f : null;
};
export function setFolder(spaceId, folderId) {
  const map = { ...(shared(SPACE_FOLDERS) ?? {}) };
  if (folderId) map[spaceId] = folderId; else delete map[spaceId];
  setShared(SPACE_FOLDERS, map);
  if (folderId) setShared(FOLDERS, folders().map((f) => (f.id === folderId ? { ...f, open: true } : f)));
}

export function initSidebar(m, cx, InputState) {
  m.spaceInfo = {}; // space id -> { org, worktrees, at }
  m.avatars = {}; // org -> "ok" | "none" | "loading"
  m.drag = null; // { id, y, moved }
  m.newFolder = false;
  m.folderInput = InputState.new({ placeholder: "Folder name" });
  m.folderInput.on("submit", (_e, cx) => { createFolder(m); cx.notify(); });
  m.folderInput.on("blur", (_e, cx) => { if (m.newFolder) { createFolder(m); cx.notify(); } });
  startProbes(m, cx);
  cx.timer.every(INFO_MS, (cx) => refreshSpaces(m, cx));
  refreshSpaces(m, cx);
  // Every space's tasks.json, for the badges and counts (the board loads only the shown one).
  cx.timer.every(5000, (cx) => loadAll(m, cx));
  loadAll(m, cx);
}

function loadAll(m, cx) {
  cx.spawn(async (cx) => {
    // Only spaces with a Shepherd have a tasks.json.
    const all = terminals();
    for (const s of spaces()) {
      if (!m.shepherd(s, all)) continue;
      const repo = m.repo(s, all);
      if (repo) await m.load(repo).catch(() => null);
    }
    placeNewSpace(m);
    cx.notify();
  });
}

/** A space New space made: put it in the folder picked there, and start its Shepherd if asked. */
function placeNewSpace(m) {
  const p = shared("shepherd.newSpace");
  if (!p) return;
  if (Date.now() - p.at > 60000) { setShared("shepherd.newSpace", null); return; }
  const s = spaces().find((x) => !x.machine && x.folder === p.folder);
  if (!s) return;
  setShared("shepherd.newSpace", null);
  if (p.group) setFolder(s.id, p.group);
  if (p.start) m.startShepherd(s);
}

/** The org (for the avatar) and worktree count of each space, from git on its machine. */
function refreshSpaces(m, cx) {
  cx.spawn(async (cx) => {
    for (const s of spaces()) {
      const dir = m.repo(s)?.dir;
      if (!dir) continue;
      const r = await exec("sh", ["-c", 'git -C "$1" remote get-url origin 2>/dev/null; echo "--"; git -C "$1" worktree list --porcelain 2>/dev/null | grep -c "^worktree "', "info", dir],
        { on: s.machine, timeout: 10000 }).catch(() => null);
      if (!r) continue;
      const [url = "", count = ""] = r.stdout.split("--\n");
      const org = url.trim().match(/github\.com[:/]([^/]+)\//)?.[1] ?? null;
      m.spaceInfo[s.id] = { org, worktrees: Math.max(0, (parseInt(count, 10) || 1) - 1), at: Date.now() };
      if (org) fetchAvatar(m, org, cx);
    }
    cx.notify();
  });
}

/** The GitHub org's image, saved once under the app's home. */
function fetchAvatar(m, org, cx) {
  if (m.avatars[org] || !/^[\w.-]+$/.test(org)) return;
  m.avatars[org] = "loading";
  const file = `${appHome()}/${AVATARS}/${org}.png`;
  cx.spawn(async (cx) => {
    const r = await exec("sh", ["-c", '[ -s "$1" ] || { mkdir -p "$(dirname "$1")" && curl -sfL --max-time 15 -o "$1.tmp" "$2" && mv "$1.tmp" "$1"; }', "avatar", file,
      `https://github.com/${org}.png?size=64`], { timeout: 20000 }).catch(() => null);
    m.avatars[org] = r?.code === 0 ? "ok" : "none";
    cx.notify();
  });
}

function createFolder(m) {
  const name = m.folderInput.value().trim();
  m.newFolder = false;
  m.folderInput.set_value("");
  if (!name) return;
  setShared(FOLDERS, [...folders(), { id: `f-${Date.now().toString(36)}`, name, open: true }]);
}

export function startNewFolder(m) {
  m.newFolder = true;
  m.folderInput.set_value("");
  m.folderInput.focus();
}

export const openNewSpace = () => openOverlay({ mod: "shepherd", kind: "dialog", width: 560, height: 540, props: { panel: "newspace" } });
export const openAddMachine = () => openOverlay({ mod: "shepherd", kind: "dialog", width: 540, height: 560, props: { panel: "addmachine" } });
export const openSpaceSettings = (id) => openOverlay({ mod: "shepherd", kind: "dialog", width: 600, height: 0.85, props: { panel: "spacesettings", space: id } });

/** Open questions and open tasks of a space, from its tasks.json. */
export function spaceCounts(m, s, all = terminals()) {
  const repo = m.repo(s, all);
  const d = repo ? m.data[repo.key] : null;
  const q = (d?.questions ?? []).filter((x) => x.answer == null).length;
  const tasks = (d?.tasks ?? []).filter((x) => x.stage !== "done" && x.status !== "parked");
  const working = tasks.some((x) => x.status === "working");
  return { q, open: tasks.length, status: q ? "blocked" : working ? "working" : tasks.length ? "idle" : (s.status ?? "idle") };
}

export function renderSidebar(m) {
  const t = palette();
  const all = spaces();
  const fs = folders();
  const stop = (_e, cx) => cx.stop_propagation();
  const dragging = m.drag?.moved ? m.drag.id : null;
  const dragFolder = dragging ? folderOf(dragging) : null;
  // Read once per render: terminals() and the machine list are big host calls.
  const terms = terminals();
  const ms = machineList();
  const mcOf = (name) => ms.find((x) => x.name === (name ?? null)) ?? null;
  const counts = new Map(all.map((s) => [s.id, spaceCounts(m, s, terms)]));

  const avatar = (s, q) => {
    const org = m.spaceInfo[s.id]?.org;
    const initial = (s.name || "?").replace(/^[^a-z0-9]*/i, "").charAt(0).toUpperCase() || "?";
    return div().relative().size(24).flex_none()
      .child(div().absolute().inset_0().rounded(6).bg(t.raised).flex().items_center().justify_center()
        .text_size(11).font_semibold().text_color(t.muted).child(initial))
      .when(m.avatars[org] === "ok", (el) => el.child(image(`${AVATARS}/${org}.png`).absolute().inset_0().size(24).rounded(6)))
      .when(q > 0, (el) => el.child(div().absolute().top(-5).right(-6).min_w(15).h(15).px(4).rounded(8).bg(t.blocked)
        .border(2).border_color(t.chrome).text_color(t.background).text_size(9.5).font_semibold()
        .flex().items_center().justify_center().child(String(q))));
  };

  const spaceRow = (s, inFolder) => {
    const c = counts.get(s.id);
    const info = m.spaceInfo[s.id] ?? {};
    const mc = mcOf(s.machine);
    const wt = info.worktrees ? ` · ⑂ ${info.worktrees}` : "";
    const dot = div().size(6).rounded(3).flex_none().bg(t[c.status] ?? t.idle)
      .when(c.status === "working", (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1200 }));
    return h_flex().id(`space-${s.id}`).gap(10).py(6).pr(8).pl(inFolder ? 26 : 8).rounded(6).cursor_pointer()
      .when(s.active, (el) => el.bg(t.hover))
      .when(dragging === s.id, (el) => el.opacity(0.4))
      .hover((st) => st.bg(t.hover))
      .on_mouse_down("left", (e, cx) => { m.drag = { id: s.id, y: e.position?.y ?? 0, moved: false }; cx.notify(); })
      .on_click((_e, cx) => {
        // A drag released on its own row isn't a click.
        const dragged = m.drag?.moved || Date.now() - (m.dragEndedAt ?? 0) < 300;
        m.drag = null;
        if (!dragged) run("space.select", { id: s.id });
        cx.notify();
      })
      .child(avatar(s, c.q))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(13).truncate().text_color(s.active ? t.foreground : t.muted).child(s.name))
        .child(h_flex().gap(4).min_w(0).font_family(MONO).text_size(10.5).text_color(t.dim)
          .child(h_flex().id(`space-mc-${s.id}`).gap(3).flex_none().items_center()
            .on_mouse_down("left", stop)
            .on_click((_e, cx) => { cx.stop_propagation(); openMachine(s.machine, true); })
            .when(Boolean(mc), (el) => el.child(div().w(14).h(11).child(machineIcon(t, mc, { size: 0.78 }))))
            .child(mc?.label ?? s.machine ?? "this mac"))
          .child(div().truncate().child(`· ${s.branch ?? "—"}${wt}`))))
      .child(h_flex().gap(5).items_center().font_family(MONO).text_size(10.5).text_color(t.dim).child(dot).child(String(c.open)))
      .child(div().id(`space-gear-${s.id}`).size(22).mr(-4).flex().items_center().justify_center().rounded(4)
        .text_color(t.dim).hover((st) => st.bg(t.raised).text_color(t.foreground))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { cx.stop_propagation(); openSpaceSettings(s.id); })
        .child(svg("mods/shepherd/icons/gear.svg").size(13)));
  };

  const folderRow = (f, kids) => {
    const q = kids.reduce((n, s) => n + counts.get(s.id).q, 0);
    const over = dragging && m.dragOver === f.id;
    return h_flex().id(`folder-${f.id}`).h(30).px(8).gap(7).items_center().rounded(6).cursor_pointer().border(1)
      .border_color(over ? t.accent : t.chrome).when(over, (el) => el.bg(t.hover))
      .hover((st) => st.bg(t.hover))
      .on_mouse_move((_e, cx) => { if (dragging && m.dragOver !== f.id) { m.dragOver = f.id; cx.notify(); } })
      .on_mouse_up("left", (_e, cx) => {
        if (!dragging) return;
        setFolder(dragging, f.id);
        m.drag = null; m.dragOver = null; m.dragEndedAt = Date.now();
        cx.stop_propagation(); cx.notify();
      })
      .on_click(() => setShared(FOLDERS, folders().map((x) => (x.id === f.id ? { ...x, open: !x.open } : x))))
      .child(div().w(10).text_size(8).text_color(t.dim).flex().justify_center().child(f.open ? "▼" : "▶"))
      .child(svg("mods/shepherd/icons/folder.svg").w(14).h(12).flex_none().text_color(f.open ? t.accent : t.muted))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(f.name))
      .when(q > 0 && !f.open, (el) => el.child(badge(t, q)))
      .when(!kids.length, (el) => el.child(div().id(`folder-x-${f.id}`).px(4).rounded(4).text_size(10).text_color(t.dim)
        .hover((st) => st.bg(t.raised).text_color(t.foreground))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { cx.stop_propagation(); setShared(FOLDERS, folders().filter((x) => x.id !== f.id)); })
        .child("✕")))
      .child(div().font_family(MONO).text_size(10.5).text_color(t.dim).child(String(kids.length)));
  };

  const rows = [];
  if (m.newFolder) {
    rows.push(h_flex().id("new-folder").h(30).px(8).gap(8).items_center().rounded(6).bg(t.popover).border(1).border_color(t.input)
      .child(svg("mods/shepherd/icons/folder.svg").w(14).h(12).flex_none().text_color(t.muted))
      .child(Input.new(m.folderInput).flex_1().text_size(13))
      .on_key_down((e, cx) => { if (e.key === "escape") { m.newFolder = false; m.folderInput.set_value(""); cx.stop_propagation(); cx.notify(); } }));
  }
  for (const f of fs) {
    const kids = all.filter((s) => folderOf(s.id) === f.id);
    rows.push(folderRow(f, kids));
    if (f.open) {
      for (const s of kids) rows.push(spaceRow(s, true));
      if (!kids.length) rows.push(div().pl(34).pr(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Drag spaces here"));
    }
  }
  for (const s of all.filter((x) => !folderOf(x.id))) rows.push(spaceRow(s, false));
  if (dragFolder) {
    const over = m.dragOver === "root";
    rows.push(div().id("root-drop").mt(4).h(34).flex().items_center().justify_center().rounded(6).border(1).border_dashed()
      .border_color(over ? t.accent : t.input).when(over, (el) => el.bg(t.hover))
      .text_size(11.5).text_color(over ? t.foreground : t.dim)
      .on_mouse_move((_e, cx) => { if (m.dragOver !== "root") { m.dragOver = "root"; cx.notify(); } })
      .on_mouse_up("left", (_e, cx) => { setFolder(dragging, null); m.drag = null; m.dragOver = null; m.dragEndedAt = Date.now(); cx.stop_propagation(); cx.notify(); })
      .child("Drop here to take it out of the folder"));
  }

  const usage = usageRows();
  const footer = h_flex().px(10).py(8).gap(2).items_center().border_t(1).border_color(t.border)
    .children(ms.map((mc) => div().id(`mc-${mc.key || "local"}`).w(28).h(26).flex().items_center().justify_center().rounded(5)
      .cursor_pointer().hover((st) => st.bg(t.hover))
      .on_click(() => openMachine(mc.name, true))
      .child(machineIcon(t, mc))))
    .child(div().id("add-machine").w(24).h(26).flex().items_center().justify_center().rounded(5).cursor_pointer()
      .text_size(14).text_color(t.dim).hover((st) => st.bg(t.hover).text_color(t.foreground))
      .on_click(() => openAddMachine()).child("+"))
    .child(div().flex_1())
    .when(usage.length > 0, (el) => el.child(h_flex().id("usage").h(26).px(6).gap(8).items_center().rounded(5).cursor_pointer()
      .hover((st) => st.bg(t.hover))
      .on_click(() => openUsage(true))
      .children(usage.map((u) => h_flex().gap(4).items_center().font_family(MONO).text_size(11)
        .text_color(u.pct >= 80 ? t.ansi1 : t.muted).child(agentIcon(t, u.key)).child(`${u.pct}%`)))));

  return v_flex().id("shepherd-spaces").size_full().bg(t.chrome).text_color(t.foreground)
    .on_mouse_move((e, cx) => {
      if (!m.drag || m.drag.moved) return;
      if (Math.abs((e.position?.y ?? 0) - m.drag.y) > 4) { m.drag.moved = true; cx.notify(); }
    })
    .on_mouse_up("left", (_e, cx) => {
      // Released anywhere else: the drag ends. Folder rows and the drop area act first (they stop it).
      if (m.drag?.moved) m.dragEndedAt = Date.now();
      if (m.drag) { m.drag = null; m.dragOver = null; cx.notify(); }
    })
    .child(h_flex().pt(14).pb(4).pl(14).pr(8).items_center()
      .child(div().flex_1().text_size(11).text_color(t.dim).child("SPACES"))
      .child(div().id("spaces-plus").size(22).flex().items_center().justify_center().rounded(4).cursor_pointer()
        .text_size(15).text_color(t.muted).hover((st) => st.bg(t.hover).text_color(t.foreground))
        .on_click(() => openOverlay({ mod: "shepherd", kind: "popup", width: 210, height: 76, props: { panel: "plus" } }))
        .child("+")))
    .child(v_flex().id("space-list").flex_1().min_h(0).px(8).gap(2).overflow_y_scrollbar().children(rows))
    .child(footer);
}

const badge = (t, n) => div().min_w(15).h(15).px(4).rounded(8).bg(t.blocked).text_color(t.background)
  .text_size(9.5).font_semibold().flex().items_center().justify_center().child(String(n));

/** Popovers open at the pointer when clicked; from a key or command, near the sidebar's foot. */
const popAt = (atPointer) => (atPointer ? {} : { at: { x: 248, y: 520 } });
export function openMachine(name, atPointer = false) {
  openOverlay({ mod: "shepherd", kind: "popup", width: 260, height: 236, props: { panel: "machine", machine: name ?? null }, ...popAt(atPointer) });
}
export function openUsage(atPointer = false) {
  openOverlay({ mod: "shepherd", kind: "popup", width: 260, height: 150, props: { panel: "usage" }, ...popAt(atPointer) });
}
export const openWorkflow = () => openOverlay({ mod: "shepherd", kind: "dialog", width: 680, height: 0.85, props: { panel: "workflow" } });

/** The + menu: New space from folder… (N) and New folder (F). */
export function renderPlus() {
  const t = palette();
  const item = (id, icon, label, key, onClick) => h_flex().id(id).h(30).px(8).gap(9).items_center().rounded(5).cursor_pointer()
    .text_size(12.5).hover((st) => st.bg(t.hover)).on_click(onClick)
    .child(svg(`mods/shepherd/icons/${icon}.svg`).w(14).h(12).flex_none().text_color(t.muted))
    .child(div().flex_1().child(label))
    .child(div().font_family(MONO).text_size(10).text_color(t.dim).child(key));
  return v_flex().id("spaces-plus-menu").size_full().p(4).bg(t.popover).text_color(t.foreground)
    .child(item("plus-space", "folder-plus", "New space from folder…", "N", () => { closeOverlay(props()?.overlay); openNewSpace(); }))
    .child(item("plus-folder", "folder-outline", "New folder", "F", () => { closeOverlay(props()?.overlay); run("shepherd.new-folder"); }));
}
