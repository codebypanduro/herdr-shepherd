// Needs you: one card per open question, answered with buttons or free text.

import { div } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { theme } from "herdr";
import { STAGES, KINDS, MONO, groupColor, age, palette, tint, kindIcon, refOf } from "./common.js";

export function answerButton(t, id, text, recommended, onClick, { fit = false, solid = null, icon = null } = {}) {
  // fit: shrink to share a row and cut the text with … (the bar); the full text shows on hover.
  // solid: a filled button in that color (the PR card's Squash and merge), with an optional icon.
  return h_flex().id(id).h(28).px(11).gap(6).items_center().rounded(6).cursor_pointer()
    .when(fit, (el) => el.min_w(0).flex_shrink(1).tooltip(text))
    .when(!solid, (el) => el.border(1).border_color(recommended ? t.accent : t.input)
      .bg(recommended ? t.selected : t.raised).text_color(t.foreground).hover((s) => s.bg(t.hover)))
    .when(Boolean(solid), (el) => el.border(1).border_color(solid).bg(solid).text_color(t.background).font_semibold()
      .hover((s) => s.opacity(0.9)))
    .text_size(12)
    .when(Boolean(icon), (el) => el.child(icon))
    // In the floating bar an unstopped press would drag the bar instead of clicking.
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click(onClick)
    .child(fit ? div().min_w(0).truncate().child(text) : text)
    .when(recommended, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.accent).child("recommended")));
}

/** Why the asker recommends its pick (grilling questions carry one). */
export const whyLine = (t, q) => div().text_size(11.5).text_color(t.dim).child(q.why);

/** An open grilling round from before the Grill step (q.questions): read-only, answered in free text. */
export function oldRound(t, q) {
  return v_flex().gap(6)
    .children(q.questions.map((g, i) => v_flex().gap(2)
      .child(h_flex().gap(8)
        .child(div().font_family(MONO).text_size(11).text_color(t.dim).child(`${i + 1}.`))
        .child(div().flex_1().text_size(12.5).line_height(1.4).child(g.q ?? "")))
      .child(div().pl(18).text_size(11.5).text_color(t.muted)
        .child((g.options ?? []).map((o) => (o === g.recommended ? `${o} (recommended)` : o)).join(" · ")))))
    .child(div().text_size(11.5).text_color(t.dim).child("An old grilling round: reply with your answers in order, as 1. … 2. …"));
}

/** The reply field's placeholder by kind, as the design words it. */
export const placeholderFor = (q) => (q.kind === "merge" ? "Or send it back with a note…"
  : q.kind === "escalate" ? "Or tell shepherd how to fix it…" : "Or answer in your own words…");

/** "❯ <placeholder>" + Send, like the Overview's Ask field: InputState can't change its placeholder,
 *  so the field has none and the kind's is drawn under it while it's empty (the slot re-renders on
 *  change). Enter (the slot's submit) or Send answers. A press stops here, so the pane's own
 *  mouse-down (the detail's, which takes the 1–6 keys) doesn't take the keyboard from it. */
function replyField(t, id, input, placeholder, send) {
  const empty = !input.value();
  return h_flex().id(`${id}-reply`).gap(8).px(10).py(7).items_center().rounded(6).border(1)
    .border_color(t.input).bg(t.background)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .child(div().font_family(MONO).text_size(12).text_color(t.accent).child("❯"))
    .child(div().relative().flex_1().min_w(0).h(18)
      .when(empty, (el) => el.child(div().absolute().inset_0().flex().items_center().truncate()
        .font_family(MONO).text_size(12).text_color(t.dim).child(placeholder)))
      .child(Input.new(input).absolute().inset_0().font_family(MONO).text_size(12).text_color(t.foreground)))
    .child(div().id(`${id}-send`).px(10).py(3).rounded(4).bg(t.raised).cursor_pointer()
      .text_size(11).text_color(empty ? t.dim : t.foreground)
      .hover((s) => s.bg(t.hover))
      .on_click(send)
      .child("Send"));
}

/** Proposed tickets and what each waits on. */
function ticketList(q, t) {
  const byKey = new Map(q.tickets.map((k) => [k.key, k]));
  return v_flex().gap(1).rounded(6).border(1).border_color(t.border)
    .children(q.tickets.map((k, i) => h_flex().px(10).py(7).gap(10).items_start()
      .when(i > 0, (el) => el.border_t(1).border_color(t.border))
      .child(div().w(22).font_family(MONO).text_size(11).text_color(t.muted).child(k.key))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().text_size(12.5).child(k.title))
        .when(Boolean(k.brief), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(k.brief))))
      .child(div().font_family(MONO).text_size(10.5).text_color(k.blockedBy.length ? t.muted : t.done)
        .child(k.blockedBy.length ? `after ${k.blockedBy.map((b) => byKey.get(b)?.key ?? b).join(", ")}` : "ready"))));
}

/** One open question with its answers: a Needs you card, and the top of its task's Overview
 *  (`id` prefixes element ids, so both can be built in one frame). */
export function questionCard(m, q, t, { id = "q", now = Date.now(), viewTask = true } = {}) {
  const kind = KINDS[q.kind] ?? KINDS.ask;
  const color = groupColor(t, kind.group);
  const task = q.taskObj;
  const where = task
    ? `${STAGES[task.stage]?.title ?? task.stage}${["implement", "review", "ci", "proof"].includes(task.stage) ? ` · loop ${task.loop ?? 1}/${task.maxLoops ?? 3}` : ""}${q.grillNo ? ` · question ${q.grillNo}` : ""}`
    : "";
  const finding = (task?.findings ?? []).filter((f) => f.state !== "resolved").slice(-1)[0];
  const input = m.replyInput(q._ref);
  // Ids repeat across spaces: elements go by the question's ref ("<space id>/<id>").
  const qk = q._ref ?? q.id;
  // All spaces: the question's space after its task's title (the design's spaceTag).
  const tag = m.spaceTag(q);
  return v_flex().id(`${id}-${qk}`).w_full().max_w(760).gap(10).p(14).rounded(8)
    .bg(t.surface).border(1).border_color(t.blocked)
    .child(h_flex().gap(8).items_center()
      .child(h_flex().gap(5).pl(6).pr(8).h(20).items_center().rounded(10).border(1).border_color(tint(color, 0.35))
        .bg(tint(color, 0.14)).text_size(11).text_color(color)
        .child(kindIcon(kind, color)).child(kind.label))
      .child(div().font_family(MONO).text_size(11).text_color(t.muted).child(q.task))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(task?.title ?? ""))
      .when(Boolean(tag), (el) => el.child(div().flex_none().font_family(MONO).text_size(11).text_color(t.dim).child(tag)))
      .child(div().text_size(11).text_color(t.dim).child(where))
      .child(div().font_family(MONO).text_size(10.5).text_color(t.dim).child(age(now - (Date.parse(q.asked) || now)))))
    .child(div().text_size(14).line_height(1.4).text_color(t.foreground).child(q.text))
    .child(div().text_size(11.5).text_color(t.dim)
      .child(`asked by ${q.from ?? "shepherd"}${finding ? ` · last finding: ${finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""} ` : ""}${finding.text}` : ""}`))
    .when(Array.isArray(q.questions), (el) => el.child(oldRound(t, q)))
    .when(q.kind === "approve" && Array.isArray(q.tickets), (el) => el.child(ticketList(q, t)))
    // The answers, then "View task" (not in the task's own Overview).
    .when((q.options ?? []).length > 0 || viewTask, (el) => el.child(h_flex().gap(8).flex_wrap().items_center()
      .children((q.options ?? []).map((o, i) => answerButton(t, `${id}-${qk}-o${i}`, o, o === q.recommended, () => m.answer(q, o))))
      .when(viewTask, (row) => row.child(div().id(`${id}-${qk}-view`).h(28).px(11).flex().items_center().rounded(6)
        .text_size(12).text_color(t.muted).cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click(() => m.openTask(refOf(q._sid, q.task)))
        .child("View task")))))
    // Why the asker recommends its pick (grilling questions carry one).
    .when(Boolean(q.why), (el) => el.child(whyLine(t, q)))
    .when(Boolean(input), (el) => el.child(replyField(t, `${id}-${qk}`, input, placeholderFor(q), () => m.answer(q, input.value()))));
}

export function renderNeeds(m) {
  const t = palette();
  const qs = m.questions();
  const now = Date.now();
  const card = (q) => questionCard(m, q, t, { now });

  return v_flex().id("shepherd-needs").size_full().bg(t.surface).text_size(12).text_color(t.foreground)
    .child(m.header("needs you", `${m.isAll() ? "all spaces" : m.space()?.name ?? "—"} · ${qs.length} open`))
    .child(v_flex().id("needs-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(12).items_center()
      .when(qs.length === 0, (el) => el.child(
        div().pt(40).text_size(13).text_color(t.dim).child(m.isAll() ? "No space has open questions." : "Nothing needs you. Shepherd will ask here when it does.")))
      .children(qs.map(card)));
}
