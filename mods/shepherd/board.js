// The board: nine stage columns of cards.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, run, shared, setShared } from "herdr";
import { GROUPS, STAGES, MONO, groupColor, age, palette } from "./common.js";
import { tint } from "./detail.js";

const COL_MIN = 172;
const SELECTED = "shepherd.selected";
const FILTERS = "shepherd.filters";

export function renderBoard(m) {
  const t = palette();
  const all = m.cards();
  const filters = shared(FILTERS) ?? [];
  const shown = filters.length ? all.filter((c) => filters.includes(c.status)) : all;
  const selected = shared(SELECTED);
  const now = Date.now();
  const statusColor = (s) => t[s] ?? t.idle;

  const toggle = (s) => {
    const f = shared(FILTERS) ?? [];
    setShared(FILTERS, f.includes(s) ? f.filter((x) => x !== s) : [...f, s]);
  };
  const filter = (s, label) => {
    const n = all.filter((c) => c.status === s).length;
    const on = filters.includes(s);
    return h_flex().id(`filter-${s}`).gap(5).items_center().px(7).h(22).rounded(5)
      .when(on, (el) => el.bg(t.selected))
      .hover((el) => el.bg(t.hover))
      .on_click(() => toggle(s))
      .child(div().size(6).rounded(3).bg(statusColor(s)))
      .child(div().text_color(on ? t.foreground : t.muted).child(`${n} ${label}`));
  };

  const header = m.header("pipeline", `${m.space()?.name ?? "—"} · ${all.length} task${all.length === 1 ? "" : "s"}`)
    .child(filter("working", "working"))
    .child(filter("blocked", "need you"))
    .child(filter("done", "done"))
    .when(filters.length > 0, (el) => el.child(
      div().id("filter-clear").px(7).h(22).flex().items_center().rounded(5).text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => setShared(FILTERS, []))
        .child("✕ clear")));

  const loopDots = (c) => h_flex().gap(3).children(Array.from({ length: c.maxLoops }, (_, i) => {
    const n = i + 1;
    const color = n < c.loop ? t.muted : n === c.loop ? statusColor(c.status) : t.raised;
    return div().size(6).rounded(1).bg(color);
  }));

  const card = (c) => {
    const isSel = selected === c.key;
    const blocked = c.status === "blocked";
    const border = isSel ? t.accent : blocked ? t.blocked : t.border;
    const inBuild = GROUPS[1].stages.includes(c.stage);
    return v_flex().id(`card-${c.key}`).flex_none().gap(6).p(10).rounded(6)
      .bg(blocked ? tint(t.blocked, 0.07) : t.surface).border(1).border_color(isSel ? t.accent : blocked ? tint(t.blocked, 0.55) : t.border)
      .hover((s) => s.border_color(isSel ? t.accent : t.input))
      .on_click(() => {
        setShared(SELECTED, isSel ? null : c.key);
        // Task cards open the detail pane; a label-only card has no task to show.
        if (!isSel && c.key.startsWith("task-")) run("layout.show", { id: "detail" });
        if (isSel) run("layout.hide", { id: "detail" });
      })
      .child(h_flex().gap(6).items_center()
        .child(div().font_family(MONO).text_size(11).text_color(t.muted).child(c.id))
        .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(10.5).text_color(t.dim)
          .child(STAGES[c.stage].skill))
        .when(inBuild, (el) => el.child(loopDots(c)))
        .when(Boolean(c.address), (el) => el.child(div().id(`peek-${c.key}`).px(3).rounded(4).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); run("terminal.peek", { terminal: c.address }); })
          .child("⋯"))))
      .child(div().text_size(13).line_height(1.35).text_color(t.foreground).child(c.title))
      .child(h_flex().gap(6).items_center()
        .child(c.status === "working"
          ? div().size(6).rounded(3).bg(t.working).loop("opacity", { from: 0.35, to: 1, period: 1200 })
          : div().size(6).rounded(3).bg(statusColor(c.status)))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(c.note))
        .child(div().font_family(MONO).text_size(10.5).text_color(t.dim).child(age(now - c.since))))
      .when(c.after.length > 0 && c.status !== "idle", (el) => el.child(
        div().font_family(MONO).text_size(10.5).text_color(t.dim).child(`after ${c.after.join(", ")}`)))
      .when(c.asked, (el) => el.child(
        div().text_size(11).text_color(t.blocked).child("↳ asked you via shepherd")));
  };

  const column = (stage, group, first) => {
    const cards = shown.filter((c) => c.stage === stage);
    const color = groupColor(t, group.key);
    return v_flex().id(`col-${stage}`).flex_1().min_w(COL_MIN).gap(8)
      .child(div().h(14).text_size(10.5).font_semibold().text_color(color).child(first ? group.label : ""))
      .child(h_flex().h(24).items_center().justify_between().border_b(2).border_color(color)
        .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(STAGES[stage].title))
        .child(div().text_size(11).text_color(t.dim).child(String(cards.length))))
      .child(v_flex().id(`cards-${stage}`).flex_1().min_h(0).gap(8).overflow_y_scrollbar()
        .when(cards.length === 0, (el) => el.child(
          div().h(40).flex().items_center().justify_center().rounded(6).border(1).border_dashed()
            .border_color(t.border).text_size(11).text_color(t.dim).child("empty")))
        .children(cards.map(card)));
  };

  const columns = GROUPS.flatMap((g) => g.stages.map((s, i) => column(s, g, i === 0)));

  return v_flex().id("shepherd-board").size_full().bg(t.surface).text_size(12).text_color(t.foreground)
    .child(header)
    .child(div().id("board-scroll").flex_1().min_h(0).overflow_x_scrollbar()
      .child(h_flex().h_full().min_w(COL_MIN * 9 + 8 * 10 + 24).px(12).py(10).gap(10).items_stretch()
        .children(columns)));
}
