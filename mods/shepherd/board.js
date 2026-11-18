// The board: ten stage columns of cards.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, shared, setShared } from "herdr";
import { GROUPS, STAGES, MONO, SELECTED, statusFilters, groupColor, groupLabel, age, palette, stuckColor, tint, kTokens, taskTokens, statusColor as statusOf, loopDots as dots } from "./common.js";
import { hoverPeek, trackPeek, withPeek, closePeek } from "./peek.js";

const COL_MIN = 172;

export function renderBoard(m) {
  const t = palette();
  const all = m.cards();
  const shown = m.filtered(all);
  // A peek whose card left the board (stage change, filter, space switch) stops reading and stops
  // taking S / T / ↵. Hover-out never comes for a card that's gone.
  if (m.peek && !shown.some((c) => c.key === m.peek.key)) closePeek(m);
  const selected = shared(SELECTED);
  const now = Date.now();
  // BUILD LOOP · MAX n from the spaces shown: each space's own (its orchestra.json wins); All spaces
  // with different ones shows the range, "MAX 3–5" (each card's dots keep its own task's).
  const loops = [...new Set(m.scopeSpaces().map((s) => m.settings(s).maxLoops))].sort((a, b) => a - b);
  const maxLoops = loops.length > 1 ? `${loops[0]}–${loops[loops.length - 1]}` : loops[0] ?? m.settings().maxLoops;

  const header = statusFilters(m, t, all, m.header("pipeline", `${m.scopeName()} · ${all.length} task${all.length === 1 ? "" : "s"}`));

  const loopDots = (c) => dots(t, c);

  const card = (c) => {
    const isSel = selected === c.key;
    const isKf = m.kf === c.key && !isSel;
    const blocked = c.status === "blocked";
    const inBuild = GROUPS[1].stages.includes(c.stage);
    const border = isSel ? t.accent : c.stuck ? tint(stuckColor(t), 0.6) : blocked ? tint(t.blocked, 0.55) : t.border;
    const minutes = (now - c.since) / 60000;
    const timeColor = c.stuck ? stuckColor(t) : blocked && minutes > 30 ? t.blocked : t.dim;
    // ⋯, S or right-click: the steer menu for a task; a label-only card just peeks at its terminal.
    const steer = () => { closePeek(m); return c.task ? m.openSteer(c._ref) : c.address && run("terminal.peek", { terminal: c.address }); };
    return withPeek(m, t, c, v_flex().id(`card-${c.key}`).relative().flex_none().gap(6).p(10).rounded(6)
      .bg(isSel ? t.hover : blocked ? tint(t.blocked, 0.07) : t.surface).border(1).border_color(isKf ? t.accent : border)
      .hover((s) => s.bg(t.hover).border_color(isSel || isKf ? t.accent : t.input))
      .on_hover((on, cx) => hoverPeek(m, c, on, cx))
      .on_mouse_move((e) => trackPeek(m, c, e))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); steer(); })
      .on_click(() => {
        // Opening the detail shifts the board under the pointer, and no hover-out follows: close here.
        closePeek(m);
        m.kf = c.key;
        setShared(SELECTED, isSel ? null : c.key);
        // Task cards open the detail pane; a label-only card has no task to show.
        if (!isSel && c.key.startsWith("task-")) run("layout.show", { id: "detail" });
        if (isSel) run("layout.hide", { id: "detail" });
      })
      .child(h_flex().gap(6).items_center()
        .child(div().flex_none().font_family(MONO).text_size(11).text_color(t.muted).child(c.id))
        // All spaces: the card's space (ids repeat across spaces), cut before the skill is.
        .when(Boolean(m.spaceTag(c)), (el) => el.child(div().id(`tag-${c.key}`).max_w(96).truncate().font_family(MONO).text_size(10.5)
          .text_color(t.dim).tooltip(m.spaceTag(c)).child(m.spaceTag(c))))
        .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(10.5).text_color(t.dim)
          .child(c.skill ?? ""))
        .when(inBuild, (el) => el.child(loopDots(c)))
        .when(Boolean(c.task || c.address), (el) => el.child(div().id(`steer-${c.key}`).px(3).rounded(4).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); steer(); })
          .child("⋯"))))
      .child(div().text_size(13).line_height(1.35).text_color(t.foreground).child(String(c.title ?? c.id)))
      .child(h_flex().gap(6).items_center()
        .child(c.status === "working"
          ? div().size(6).rounded(3).bg(t.working).loop("opacity", { from: 0.35, to: 1, period: 1200 })
          : div().size(6).rounded(3).bg(statusOf(t, c.status)))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(String(c.note ?? "")))
        .child(div().id(`time-${c.key}`).font_family(MONO).text_size(10.5).text_color(timeColor)
          .tooltip(timeTooltip(c, now)).child(age(now - c.since))))
      .when(Boolean(c.stuckText), (el) => el.child(h_flex().gap(6).items_center()
        .child(div().size(5).bg(stuckColor(t)))
        .child(div().text_size(11).text_color(stuckColor(t)).child(c.stuckText))))
      // What waits on this card ("blocks T-5"), else what it waits on (a queued ticket says that in its note).
      .when((c.blocks ?? []).length > 0 || (c.after.length > 0 && c.status !== "idle"), (el) => el.child(
        div().font_family(MONO).text_size(10.5).text_color(t.dim)
          .child((c.blocks ?? []).length ? `blocks ${c.blocks.join(", ")}` : `after ${c.after.join(", ")}`)))
      .when(c.asked, (el) => el.child(
        div().text_size(11).text_color(t.blocked).child("↳ asked you via shepherd"))), now);
  };

  const column = (stage, group, first) => {
    const cards = shown.filter((c) => c.stage === stage);
    const color = groupColor(t, group.key);
    return v_flex().id(`col-${stage}`).flex_1().min_w(COL_MIN).gap(8)
      .child(div().h(14).text_size(10.5).font_semibold().text_color(color).child(first ? groupLabel(group, maxLoops) : ""))
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

/** The card time's tooltip: "34m in Code review · 12k tokens so far" / "Total time 2h 5m · 55k tokens". */
function timeTooltip(c, now) {
  const runs = c.task?.history ?? [];
  const tokens = taskTokens(c.task);
  const tok = tokens ? ` · ${kTokens(tokens)} tokens` : "";
  if (c.stage === "done") {
    const total = runs.reduce((n, r) => n + Math.max(0, (Date.parse(r.end ?? "") || now) - (Date.parse(r.start ?? "") || now)), 0);
    return `Total time ${age(total || now - c.since)}${tok}`;
  }
  return `${age(now - c.since)} in ${STAGES[c.stage]?.title ?? c.stage}${tok ? `${tok} so far` : ""}`;
}

