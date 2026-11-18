// The tab bar (panel "tabs", 36px): the space's tabs as pills, then the view switch, Digest, ⌘K
// and ⚙ Workflow. This layout has no terminal area, so a pill opens its terminal in a window.
// The first pill is always Shepherd (✻): its terminal, or Start Shepherd when the space has none.
// The other pills carry their program's icon; + opens a menu of what a new tab can run.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { terminals, panes, run, setShared, knownAgents, openOverlay, closeOverlay, props } from "herdr";
import { openWorkflow, button } from "./ui.js";
import { shepherdMark, programIcon, startAction } from "./start.js";
import { MONO, VIEW, VIEW_LIST, localId, machineOf, palette } from "./common.js";

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

const isShepherd = (x) => x.labels?.["herdr.role"] === "shepherd";

/** Closes a tab (`tab.close`) or one pane of Shepherd's tab (`pane.close`). Asks first, in the
 *  closetab dialog, when something besides a shell still runs there (a program in the foreground, or
 *  an agent working or waiting), as Herdr's own tabs do, and when it's the space's last tab, which
 *  closes the space. Never closes Shepherd: a tab holding it is refused. */
function closeTarget({ space, tab, pane, terms, name }) {
  if (terms.some(isShepherd)) return; // stopping Shepherd is its own, explicit thing
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

  // A tab's terminals: the live ones labelled with its id, on the space's machine.
  const termsOf = (tab) => all.filter((x) => x.state === "live" && x.labels?.["herdr.tab"] === localId({ id: tab.id, machine: space?.machine })
    && machineOf(x) === (space?.machine ?? null));

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

  const pills = [];
  // Shepherd first, whether or not its tab sorts first; without one, its pill starts one.
  if (sh) {
    pills.push(pill("tab-shepherd", [shepherdMark(t, 16), div().child("Shepherd"), dot(sh.status)],
      { selected: true, onClick: () => m.openTerminal(sh.address, null) }));
  } else if (space) {
    pills.push(h_flex().id("tab-shepherd").h(24).pl(4).pr(10).gap(7).flex_none().items_center().rounded(12)
      .border(1).border_color(t.border).text_size(12)
      .child(div().opacity(0.6).child(shepherdMark(t, 16)))
      .child(div().flex_none().text_color(t.dim).child("Shepherd"))
      .child(startAction(m, t, space, "tab-shep")));
  }
  const paneOf = (x) => panes().find((p) => p.terminal === x.address)?.pane ?? null;
  for (const tab of space?.tabs ?? []) {
    const ts = termsOf(tab);
    // Shepherd's tab (by its label, whether or not m.shepherd() matched it) is the Shepherd pill and
    // never closes; anything split beside Shepherd gets a pill of its own, closed by its pane.
    if (ts.some(isShepherd)) {
      for (const x of ts.filter((y) => !isShepherd(y))) {
        const name = termName(x);
        const pane = paneOf(x);
        pills.push(pill(`tab-${tab.id}-${x.address}`, [programIcon(t, x.program), dot(x.status), div().max_w(220).truncate().text_color(t.muted).child(name)],
          { onClick: () => m.openTerminal(x.address, null, `The ${name} beside Shepherd`),
            onClose: pane ? () => closeTarget({ space, pane, terms: [x], name }) : null }));
      }
      continue;
    }
    const first = ts[0];
    const task = first?.labels?.["shepherd.task"];
    if (task) {
      // A sub-agent kept as a tab: its address and task. ✕ parks every terminal in the tab: the tab
      // goes, the agents keep running (closing would end a task's agent mid-task).
      pills.push(pill(`tab-${tab.id}`, [programIcon(t, first.program), dot(first.status),
        div().font_family(MONO).text_size(11).child(first.address),
        div().text_color(t.dim).child(task)],
      { onClick: () => m.openTerminal(first.address, task, `${task}'s agent`),
        onClose: () => { for (const x of ts) run("terminal.park", { terminal: x.address }); },
        closeTip: "Put away: the tab goes, its agents keep running" }));
    } else {
      // Named by the tab's name, else what its agent works on, else what it runs (Claude Code, Codex, sleep), else "shell".
      const name = tab.named ? tab.name : termName(first);
      pills.push(pill(`tab-${tab.id}`, [programIcon(t, first?.program), dot(tab.status), div().max_w(220).truncate().text_color(t.muted).child(name)],
        { onClick: () => first && m.openTerminal(first.address, null, `The ${name} tab`), onClose: () => closeTarget({ space, tab, terms: ts, name }) }));
    }
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
    .child(seg)
    .child(button("open-digest", [div().child("Digest"), div().font_family(MONO).text_size(10.5).text_color(t.dim).child("D")], () => m.toggleDigest()))
    .child(button("open-palette", [div().font_family(MONO).text_size(11).text_color(t.muted).child("⌘K")], () => m.togglePalette()))
    .child(button("open-workflow", [div().font_family(MONO).text_color(t.dim).child("⚙"), div().child("Workflow")],
      () => openWorkflow()));
}
