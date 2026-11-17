// The tab bar (panel "tabs", 36px): the space's tabs as pills, then the view switch, Digest, ⌘K
// and ⚙ Workflow. This layout has no terminal area, so a pill opens its terminal in a window.
// The first pill is always Shepherd (✻): its terminal, or Start Shepherd when the space has none.
// The other pills carry their program's icon; + opens a menu of what a new tab can run.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { terminals, run, setShared, knownAgents, openOverlay, closeOverlay, props } from "herdr";
import { openWorkflow } from "./ui.js";
import { shepherdMark, programIcon, startAction } from "./start.js";
import { MONO, VIEW, VIEW_LIST, localId, machineOf, palette } from "./common.js";

/** The + menu: Shepherd (when the space has none), Terminal, and each agent installed on the space's
 *  machine (knownAgents, at most 6 s; Herdr caches it a minute per machine), opened once known. */
function openNewTab(m, cx, space) {
  if (!space || m.newTabAsking) return;
  m.newTabAsking = true;
  m.startState(space, cx); // asks whether Shepherd can start there, if not known yet
  cx.spawn(async (cx) => {
    let agents = null, error = null;
    try {
      agents = await new Promise((resolve, reject) => {
        cx.timer.after(6000, () => reject(new Error("timed out")));
        knownAgents({ on: space.machine ?? null }).then(resolve, reject);
      });
    } catch (e) { error = `Couldn't list agents${space.machine ? ` on ${space.machine}` : ""}: ${e?.message ?? e}`; }
    m.newTabAsking = false;
    const list = (agents ?? []).filter((a) => a.installed && Array.isArray(a.run) && a.run.length)
      .map((a) => ({ key: a.key, name: a.name, icon: a.icon, tint: a.tint, run: a.run }));
    openOverlay({ mod: "shepherd", kind: "popup", width: 260, props: { panel: "newtab", space: space.id, agents: list, error } });
    cx.notify();
  });
}

/** Closes a tab with Herdr's tab.close. A tab still running something besides its shell (a program
 *  in the foreground, or an agent working or waiting) asks first, as Herdr's own tabs do. */
function closeTab(tab, ts, name) {
  const busy = ts.filter((x) => (x.program && !x.program.shell) || ["working", "blocked"].includes(x.status));
  if (!busy.length) { run("tab.close", { id: tab.id, confirmed: true }); return; }
  const what = [...new Set(busy.map((x) => x.program?.name ?? x.address))].join(", ");
  openOverlay({ mod: "shepherd", kind: "dialog", width: 400, height: 150, props: { panel: "closetab", tab: tab.id, name, what } });
}

/** "Close <name>?" for a tab with a program still running (panel "closetab"). */
export function renderCloseTab() {
  const t = palette();
  const p = props() ?? {};
  const close = () => closeOverlay(p.overlay);
  const button = (id, label, danger, onClick) => div().id(id).px(12).h(28).flex().items_center().rounded(5).cursor_pointer()
    .text_size(12).font_semibold()
    .when(danger, (el) => el.bg(t.ansi1).text_color(t.background))
    .when(!danger, (el) => el.border(1).border_color(t.input).text_color(t.foreground).hover((s) => s.bg(t.hover)))
    .on_click(onClick).child(label);
  return v_flex().id("shepherd-closetab").size_full().p(16).gap(8).bg(t.background).text_color(t.foreground)
    .child(div().text_size(14).font_semibold().child(`Close ${p.name ?? "this tab"}?`))
    .child(div().flex_1().text_size(12).text_color(t.muted).line_height(1.45)
      .child(`${p.what || "A program"} is still running in it. Closing the tab ends it.`))
    .child(h_flex().gap(8).justify_end()
      .child(button("ct-cancel", "Cancel", false, close))
      .child(button("ct-close", "Close tab", true, () => { run("tab.close", { id: p.tab, confirmed: true }); close(); })));
}

export function renderTabBar(m, cx) {
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

  const pills = [];
  // Shepherd first, whether or not its tab sorts first; without one, its pill starts one.
  if (sh) {
    pills.push(pill("tab-shepherd", [shepherdMark(t, 16), div().child("Shepherd"), dot(sh.status)],
      { selected: true, onClick: () => m.openTerminal(sh.address, null) }));
  } else if (space) {
    pills.push(h_flex().id("tab-shepherd").h(24).pl(4).pr(10).gap(7).min_w(0).flex_shrink(1).items_center().rounded(12)
      .border(1).border_color(t.border).text_size(12)
      .child(div().opacity(0.6).child(shepherdMark(t, 16)))
      .child(div().flex_none().text_color(t.dim).child("Shepherd"))
      .child(startAction(m, cx, t, space, "tab-shep")));
  }
  for (const tab of space?.tabs ?? []) {
    const ts = termsOf(tab);
    if (sh && ts.some((x) => x.address === sh.address)) continue;
    const first = ts[0];
    const task = first?.labels?.["shepherd.task"];
    if (task) {
      // A sub-agent kept as a tab: its address and task; ✕ parks it: the tab goes, the task's agent
      // keeps running (closing would end it mid-task).
      pills.push(pill(`tab-${tab.id}`, [programIcon(t, first.program), dot(first.status),
        div().font_family(MONO).text_size(11).child(first.address),
        div().text_color(t.dim).child(task)],
      { onClick: () => m.openTerminal(first.address, task, `${task}'s agent`), onClose: () => run("terminal.park", { terminal: first.address }),
        closeTip: "Put away: the agent keeps running" }));
    } else {
      // Named by the tab's name, else what it runs (Claude Code, Codex, shell).
      const name = tab.named ? tab.name : first?.program && !first.program.shell && first.program.key !== "program" ? first.program.name : "shell";
      pills.push(pill(`tab-${tab.id}`, [programIcon(t, first?.program), dot(tab.status), div().text_color(t.muted).child(name)],
        { onClick: () => first && m.openTerminal(first.address, null, `The ${name} tab`), onClose: () => closeTab(tab, ts, name) }));
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
    .child(button("open-palette", [div().font_family(MONO).text_size(11).text_color(t.muted).child("⌘K")], () => run("app.palette")))
    .child(button("open-workflow", [div().font_family(MONO).text_color(t.dim).child("⚙"), div().child("Workflow")],
      () => openWorkflow()));
}
