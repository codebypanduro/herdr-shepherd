// The tab bar (panel "tabs", 36px): the space's tabs as pills, then the view switch, Digest, ⌘K
// and ⚙ Workflow. This layout has no terminal area, so a pill opens its terminal in a window.

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { terminals, run, shared, setShared, exec } from "herdr";
import { MONO, localId, machineOf, palette } from "./common.js";

const VIEW = "shepherd.view";
const SWITCH = [["board", "Board"], ["pipeline", "Pipeline"], ["deps", "Dependencies"], ["needs", "Needs you"]];

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

  const pill = (id, children, { selected = false, onClick, onClose } = {}) => h_flex().id(id).h(24).pl(10).pr(onClose ? 4 : 10).gap(7)
    .items_center().rounded(12).cursor_pointer().text_size(12).text_color(t.foreground)
    .when(selected, (el) => el.bg(t.hover))
    .hover((s) => s.bg(t.hover))
    .on_click(onClick)
    .children(children)
    .when(Boolean(onClose), (el) => el.child(div().id(`${id}-x`).size(16).flex().items_center().justify_center().rounded(8)
      .text_size(10).text_color(t.dim).hover((s) => s.bg(t.raised).text_color(t.foreground))
      .on_mouse_down("left", stop)
      .on_click((_e, cx) => { cx.stop_propagation(); onClose(); })
      .child("✕")));
  const dot = (status) => div().size(6).rounded(3).flex_none().bg(t[status] ?? t.idle)
    .when(status === "working", (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1200 }));

  const pills = [];
  // Shepherd first, whether or not its tab sorts first.
  if (sh) {
    pills.push(pill("tab-shepherd", [dot(sh.status), div().child(`shepherd · ${space?.name ?? "—"}`)],
      { selected: true, onClick: () => m.openTerminal(sh.address, null) }));
  }
  for (const tab of space?.tabs ?? []) {
    const ts = termsOf(tab);
    if (sh && ts.some((x) => x.address === sh.address)) continue;
    const first = ts[0];
    const task = first?.labels?.["shepherd.task"];
    if (task) {
      // A sub-agent kept as a tab: its address and task; ✕ parks it (it keeps running).
      pills.push(pill(`tab-${tab.id}`, [dot(first.status),
        div().font_family(MONO).text_size(11).child(first.address),
        div().text_color(t.dim).child(task)],
      { onClick: () => m.openTerminal(first.address, task), onClose: () => run("terminal.park", { terminal: first.address }) }));
    } else {
      pills.push(pill(`tab-${tab.id}`, [dot(tab.status), div().text_color(t.muted).child(tab.named ? tab.name : "shell")],
        { onClick: () => first && m.openTerminal(first.address, null) }));
    }
  }

  const seg = h_flex().p(2).rounded(6).bg(t.canvas).border(1).border_color(t.border)
    .children(SWITCH.map(([key, label]) => h_flex().id(`view-${key}`).h(22).px(10).gap(6).items_center().rounded(4)
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
  const workflow = m.repo()?.workflow;

  return h_flex().id("shepherd-tabs").size_full().px(10).gap(6).items_center().bg(t.chrome)
    .border_b(1).border_color(t.border)
    .children(pills)
    .child(div().id("tab-new").size(24).flex().items_center().justify_center().rounded(12).cursor_pointer()
      .text_size(15).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => space && run("tab.new", { space: space.id }))
      .child("+"))
    .child(div().flex_1())
    .child(seg)
    .child(button("open-digest", [div().child("Digest"), div().font_family(MONO).text_size(10.5).text_color(t.dim).child("D")], () => m.openDigest()))
    .child(button("open-palette", [div().font_family(MONO).text_size(11).text_color(t.muted).child("⌘K")], () => run("app.palette")))
    .child(button("open-workflow", [div().font_family(MONO).text_color(t.dim).child("⚙"), div().child("Workflow")],
      // Until the Workflow settings overlay exists, the file itself (this computer's spaces only).
      () => workflow && !space?.machine && exec("open", ["-t", workflow]).catch(() => null)));
}
