// The tab bar (panel "tabs", 36px): ✻ Shepherd, then the space's own tabs as pills, then (on ✻
// Shepherd only) the view switch, Digest, ⌘K and ⚙ Workflow. A pill swaps the whole work area for
// its tab's terminals; ✻ Shepherd shows the views with Shepherd's terminal under them (mode.js).
// Pills carry their program's icon; + opens a menu of what a new tab can run, and selects it.
// The bar also keeps the layout and Herdr's selected tab in step with the mode (syncMode).

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { terminals, run, setShared, knownAgents, openOverlay, closeOverlay, props } from "herdr";
import { openWorkflow, button } from "./ui.js";
import { shepherdMark, programIcon } from "./start.js";
import { MONO, VIEW, VIEW_LIST, palette } from "./common.js";
import { spaceTabs, modeOf, showMode, isShep } from "./mode.js";

/** The + menu: Shepherd (when the space has none), Terminal, and each agent installed on the space's
 *  machine (knownAgents, at most 6 s; Herdr caches it a minute per machine), opened once known. */
function openNewTab(m, cx, space) {
  if (!space || m.newTabAsking) return;
  m.newTabAsking = true;
  m.askStartable(cx, space); // whether Shepherd can start there, if not known yet
  cx.spawn(async (cx) => {
    let agents = null, error = null, timer = null;
    try {
      agents = await new Promise((resolve, reject) => {
        timer = cx.timer.after(6000, () => reject(new Error("timed out")));
        knownAgents({ on: space.machine ?? null }).then(resolve, reject);
      });
    } catch (e) { error = `Couldn't list agents${space.machine ? ` on ${space.machine}` : ""}: ${e?.message ?? e}`; }
    timer?.cancel();
    m.newTabAsking = false;
    const list = (agents ?? []).filter((a) => a.installed && Array.isArray(a.run) && a.run.length)
      .map((a) => ({ key: a.key, name: a.name, icon: a.icon, tint: a.tint, run: a.run }));
    openOverlay({ mod: "shepherd", kind: "popup", width: 260, props: { panel: "newtab", space: space.id, agents: list, error } });
    cx.notify();
  });
}


/** Closes a tab (`tab.close`) or one pane of Shepherd's tab (`pane.close`). Asks first, in the
 *  closetab dialog, when something besides a shell still runs there (a program in the foreground, or
 *  an agent working or waiting), as Herdr's own tabs do, and when it's the space's last tab, which
 *  closes the space. Never closes Shepherd: a tab holding it is refused. */
function closeTarget({ space, tab, pane, terms, name }) {
  if (terms.some(isShep)) return; // stopping Shepherd is its own, explicit thing
  const busy = terms.filter((x) => (x.program && !x.program.shell) || ["working", "blocked"].includes(x.status));
  const last = !pane && (space?.tabs?.length ?? 0) <= 1;
  const cmd = pane ? { name: "pane.close", args: { pane } } : { name: "tab.close", args: { id: tab.id, confirmed: true } };
  if (!busy.length && !last) { run(cmd.name, cmd.args); return; }
  const what = [...new Set(busy.map((x) => x.program?.name ?? x.address))].join(", ");
  openOverlay({ mod: "shepherd", kind: "dialog", width: 400, height: 160,
    props: { panel: "closetab", cmd, name, what, space: last ? space?.name ?? "this space" : null } });
}

/** "Close <name>?" before closing a tab or pane that still runs something, or the space's last tab
 *  (panel "closetab"; props.cmd is the command to run). */
export function renderCloseTab() {
  const t = palette();
  const p = props() ?? {};
  const close = () => closeOverlay(p.overlay);
  const why = [
    p.what ? `${p.what} is still running in it, and closing it ends ${p.what.includes(",") ? "them" : "it"}.` : null,
    p.space ? `It's the last tab in ${p.space}: closing it closes the space.` : null,
  ].filter(Boolean).join(" ");
  return v_flex().id("shepherd-closetab").size_full().p(16).gap(8).bg(t.background).text_color(t.foreground)
    .child(div().text_size(14).font_semibold().child(`Close ${p.name ?? "this tab"}?`))
    .child(div().flex_1().text_size(12).text_color(t.muted).line_height(1.45).child(why))
    .child(h_flex().gap(8).justify_end()
      .child(button(t, "ct-cancel", "Cancel", close))
      .child(button(t, "ct-close", p.space ? "Close tab and space" : "Close", () => { if (p.cmd) run(p.cmd.name, p.cmd.args); close(); }, { danger: true })));
}

export function renderTabBar(m) {
  const t = palette();
  const space = m.space();
  const view = m.view();
  const nq = m.questions().length;
  const sh = m.shepherd();
  const all = terminals();
  const stop = (_e, cx) => cx.stop_propagation();


  // A pill with onClose shows ✕ while hovered (its room is kept, so pills don't shift) and closes on a
  // middle click.
  const pill = (id, children, { selected = false, onClick, onClose, closeTip } = {}) => h_flex().id(id).h(24).pl(10).pr(onClose ? 4 : 10).gap(7)
    .items_center().rounded(12).cursor_pointer().text_size(12).text_color(t.foreground)
    .when(selected, (el) => el.bg(t.hover))
    .hover((s) => s.bg(t.hover))
    .on_click(onClick)
    .children(children)
    .when(Boolean(onClose), (el) => el
      .on_hover((on, cx) => { if (on) m.hoverTab = id; else if (m.hoverTab === id) m.hoverTab = null; cx.notify(); })
      .on_mouse_down("middle", (_e, cx) => { cx.stop_propagation(); onClose(); })
      .child(div().id(`${id}-x`).size(16).flex().items_center().justify_center().rounded(8)
        .text_size(10).text_color(t.dim).hover((s) => s.bg(t.raised).text_color(t.foreground))
        .when(Boolean(closeTip), (x) => x.tooltip(closeTip))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { cx.stop_propagation(); onClose(); })
        .child(m.hoverTab === id ? "✕" : "")));
  const dot = (status) => div().size(6).rounded(3).flex_none().bg(t[status] ?? t.idle)
    .when(status === "working", (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1200 }));
  // What a terminal runs, for its pill: its program's name, else "shell".
  const progName = (x) => (x?.program && !x.program.shell && x.program.name ? x.program.name : "shell");
  // An agent's pill shows what it works on: the terminal title it sets (Claude Code names it after the
  // conversation), minus spinner glyphs; else its program's name. Shells keep "shell" (their titles are paths).
  const termName = (x) => {
    const title = String(x?.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
    return x?.program && !x.program.shell && title && title !== x.program.name ? title : progName(x);
  };

  const st = spaceTabs(space, all);
  const mode = space ? modeOf(space, st) : "shepherd";
  const onShep = mode === "shepherd";
  const pills = [];
  // ✻ Shepherd first: the views and Shepherd's terminal under them; with no Shepherd, the same place
  // says so and offers Start Shepherd.
  pills.push(pill("tab-shepherd", [shepherdMark(t, 16), div().child("Shepherd"), sh && space && m.isRestarting(space) ? div().text_color(t.dim).text_size(11).child("restarting…")
    : sh ? dot(sh.status) : div().text_color(t.dim).text_size(11).child("not running")],
    { selected: onShep, onClick: () => showMode(m, "shepherd", space) }));
  // The space's own tabs (Claude sessions, shells, agents opened with +). Shepherd's tab and tabs holding
  // only Shepherd's agents (task agents and what they started) never get one.
  for (const { tab, terms } of st.own) {
    const first = terms[0];
    // Named by the tab's name, else what its agent works on, else what it runs (Claude Code, Codex, sleep), else "shell".
    const name = tab.named ? tab.name : termName(first);
    pills.push(pill(`tab-${tab.id}`, [programIcon(t, first?.program), dot(tab.status), div().max_w(220).truncate().text_color(t.muted).child(name)],
      { selected: mode === tab.id, onClick: () => showMode(m, tab.id, space), onClose: () => closeTarget({ space, tab, terms, name }) }));
  }

  const seg = h_flex().p(2).rounded(6).bg(t.canvas).border(1).border_color(t.border)
    .children(VIEW_LIST.map(([key, label]) => h_flex().id(`view-${key}`).h(22).px(10).gap(6).items_center().rounded(4)
      .cursor_pointer().text_size(12)
      .bg(view === key ? t.selected : t.canvas).text_color(view === key ? t.foreground : t.dim)
      .hover((s) => s.text_color(t.foreground))
      .on_click(() => setShared(VIEW, key))
      .child(label)
      .when(key === "needs" && nq > 0, (el) => el.child(div().min_w(16).h(16).px(4).flex().items_center().justify_center()
        .rounded(8).bg(t.blocked).text_color(t.background).text_size(10).font_semibold().child(String(nq))))));

  const button = (id, children, onClick) => h_flex().id(id).h(26).px(10).gap(6).items_center().rounded(6)
    .border(1).border_color(t.border).cursor_pointer().text_size(12).text_color(t.foreground)
    .hover((s) => s.bg(t.hover))
    .on_click(onClick)
    .children(children);

  return h_flex().id("shepherd-tabs").size_full().px(10).gap(6).items_center().bg(t.chrome)
    .border_b(1).border_color(t.border)
    .children(pills)
    .child(div().id("tab-new").size(24).flex().items_center().justify_center().rounded(12).cursor_pointer()
      .text_size(15).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => openNewTab(m, cx, space))
      .child("+"))
    .child(div().flex_1())
    // The views, Digest, ⌘K and Workflow belong to ✻ Shepherd: a pill's terminal has the whole area.
    .when(onShep, (el) => el
      .child(seg)
      .child(button("open-digest", [div().child("Digest"), div().font_family(MONO).text_size(10.5).text_color(t.dim).child("D")], () => m.toggleDigest()))
      .child(button("open-palette", [div().font_family(MONO).text_size(11).text_color(t.muted).child("⌘K")], () => m.togglePalette()))
      .child(button("open-workflow", [div().font_family(MONO).text_color(t.dim).child("⚙"), div().child("Workflow")],
        () => openWorkflow())));
}
