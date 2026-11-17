// Pipeline (one row per task, a cell per stage) and Dependencies (chains of tickets).

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { shared } from "herdr";
import { STAGES, ORDER, MONO, SELECTED, palette, stuckColor, tint, statusColor, loopDots } from "./common.js";

/** Rows react like cards: click opens the task, right-click steers it. */
const rowActions = (m, el, c) => el
  .on_click(() => { m.kf = c.key; m.openTask(c.id); })
  .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); m.openSteer(c.id); });

export function renderPipeline(m) {
  const t = palette();
  const cards = m.pipelineOrder(m.cards().filter((c) => c.task));
  const selected = shared(SELECTED);
  const CELL = 64;
  const TASK_W = 240;

  const head = h_flex().flex_none().h(28).gap(4).items_center().border_b(1).border_color(t.border)
    .text_size(11).text_color(t.dim)
    .child(div().w(TASK_W).flex_none().child("task"))
    .children(ORDER.map((s) => div().flex_1().min_w(CELL).truncate().child(STAGES[s].title)))
    .child(div().w(54).flex_none().flex().justify_end().child("loop"));

  const cell = (c, s) => {
    const i = ORDER.indexOf(s), at = ORDER.indexOf(c.stage);
    const base = div().flex_1().min_w(CELL).h(22).px(7).flex().items_center().rounded(4)
      .font_family(MONO).text_size(11).border(1);
    if (c.stage === "done") {
      return s === "done" ? base.bg(tint(t.done, 0.14)).border_color(tint(t.done, 0.4)).text_color(t.done).child("✓")
        : base.bg(t.raised).border_color(t.raised).text_color(t.dim).child("✓");
    }
    if (i < at) return base.bg(t.raised).border_color(t.raised).text_color(t.dim).child("✓");
    if (i > at) return base.border_color(t.border);
    const col = c.stuck ? stuckColor(t) : statusColor(t, c.status);
    const text = c.asked || c.status === "blocked" ? "needs you" : c.paused ? "paused"
      : c.task.status === "queued" ? "ready" : c.task.status === "parked" ? "parked" : c.address ?? "running";
    return base.bg(tint(col, 0.16)).border_color(tint(col, 0.5)).text_color(col).truncate().child(text);
  };

  const row = (c) => rowActions(m, h_flex().id(`pipe-${c.key}`).flex_none().py(8).gap(4).items_center()
    .border_b(1).border_color(t.border).cursor_pointer()
    .when(selected === c.key || m.kf === c.key, (el) => el.bg(t.raised))
    .hover((s) => s.bg(t.raised)), c)
    .child(v_flex().w(TASK_W).flex_none().min_w(0).gap(3).pr(8)
      .child(h_flex().gap(8).items_center().min_w(0)
        .child(div().flex_none().font_family(MONO).text_size(11).text_color(t.muted).child(c.id))
        .child(div().flex_1().min_w(0).truncate().text_size(13).child(c.title)))
      .child(div().truncate().text_size(11.5).text_color(c.stuck ? stuckColor(t) : c.status === "blocked" ? t.blocked : t.muted)
        .child(c.stuckText ?? c.note)))
    .children(ORDER.map((s) => cell(c, s)))
    .child(h_flex().w(54).flex_none().justify_end().child(loopDots(t, c, 2)));

  return v_flex().id("shepherd-pipeline").size_full().bg(t.surface).text_size(12).text_color(t.foreground)
    .child(m.header("pipeline", `${m.space()?.name ?? "—"} · ${cards.length} task${cards.length === 1 ? "" : "s"}`))
    .child(div().id("pipe-scroll").flex_1().min_h(0).overflow_x_scrollbar()
      .child(v_flex().id("pipe-rows").h_full().min_w(TASK_W + ORDER.length * (CELL + 4) + 80).px(10).pt(6).pb(10)
        .overflow_y_scrollbar()
        .child(head)
        .when(cards.length === 0, (el) => el.child(div().pt(40).text_color(t.dim).child("No tasks in this space yet.")))
        .children(cards.map(row))));
}

/** Every chain of tasks that wait on each other: from a task nothing in the space holds, along
 *  "after" edges to the end. A task waiting on two others shows in both chains. */
export function chains(tasks) {
  const ids = new Set(tasks.map((x) => x.id));
  const kids = (id) => tasks.filter((x) => (x.blockedBy ?? []).includes(id));
  const roots = tasks.filter((x) => !(x.blockedBy ?? []).some((b) => ids.has(b)) && kids(x.id).length);
  const out = [];
  const walk = (x, path) => {
    if (path.includes(x)) return; // a cycle: stop rather than loop
    const k = kids(x.id);
    if (!k.length) { out.push([...path, x]); return; }
    for (const c of k) walk(c, [...path, x]);
  };
  for (const r of roots) walk(r, []);
  return out;
}

export function renderDeps(m) {
  const t = palette();
  const cards = m.cards().filter((c) => c.task);
  const byId = new Map(cards.map((c) => [c.id, c]));
  const rows = chains(cards.map((c) => c.task)).map((path) => {
    const nodes = path.map((x) => byId.get(x.id));
    // What holds the chain up: its first task that isn't done.
    const head = nodes.find((c) => c.stage !== "done");
    const yours = Boolean(head && (head.asked || head.status === "blocked"));
    const waiting = head ? nodes.length - nodes.indexOf(head) - 1 : 0;
    return { nodes, yours, cleared: !head, waiting };
  }).sort((a, b) => (b.yours - a.yours) || (a.cleared - b.cleared));

  const node = (c, id) => {
    const yours = c.asked || c.status === "blocked";
    return v_flex().id(id).w(210).gap(6).px(10).py(9).rounded(6).cursor_pointer()
      .bg(t.raised).border(1).border_color(yours ? tint(t.blocked, 0.45) : t.border)
      .hover((s) => s.bg(t.hover))
      .on_click(() => { m.kf = c.key; m.openTask(c.id); })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); m.openSteer(c.id); })
      .child(h_flex().gap(6).items_center()
        .child(div().size(6).rounded(3).bg(statusColor(t, c.status)))
        .child(div().font_family(MONO).text_size(11).text_color(t.muted).child(c.id))
        .child(div().flex_1())
        .child(div().text_size(10.5).text_color(t.muted).child(STAGES[c.stage]?.title ?? c.stage)))
      .child(div().text_size(12.5).line_height(1.35).child(c.title))
      .child(div().truncate().text_size(11).text_color(yours ? t.blocked : c.stuck ? stuckColor(t) : t.muted)
        .child(yours ? "waiting on you" : c.stuckText ?? c.note));
  };

  const chain = (r, i) => v_flex().id(`chain-${i}`).gap(8).p(12).rounded(7).bg(t.surface)
    .border(1).border_color(r.yours ? tint(t.blocked, 0.35) : t.border)
    .child(div().text_size(11).text_color(r.yours ? t.blocked : t.dim)
      .child(`${r.yours ? "HELD UP BY YOU" : r.cleared ? "CLEARED" : "IN PROGRESS"} · ${r.waiting} waiting`))
    .child(h_flex().gap(6).flex_wrap().items_stretch()
      .children(r.nodes.flatMap((c, j) => (j === 0 ? [node(c, `dep-${i}-${j}`)]
        : [div().flex().items_center().px(2).font_family(MONO).text_size(13).text_color(t.dim).child("→"), node(c, `dep-${i}-${j}`)]))));

  return v_flex().id("shepherd-deps").size_full().bg(t.surface).text_size(12).text_color(t.foreground)
    .child(m.header("dependencies", `${m.space()?.name ?? "—"} · ${cards.length} task${cards.length === 1 ? "" : "s"}`))
    .child(v_flex().id("deps-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(14).gap(10)
      .child(div().text_size(12).text_color(t.muted).child("Tickets that wait on other tickets. A chain only moves when the ticket on the left is done."))
      .when(rows.length === 0, (el) => el.child(div().pt(40).flex().justify_center().text_size(13).text_color(t.dim)
        .child("No tickets wait on others in this space.")))
      .children(rows.map(chain)));
}
