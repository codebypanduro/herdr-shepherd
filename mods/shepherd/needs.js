// Needs you: one card per open question, answered with buttons or free text.

import { div } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { theme } from "herdr";
import { STAGES, KINDS, MONO, groupColor, age, palette } from "./common.js";

export function answerButton(t, id, text, recommended, onClick) {
  return h_flex().id(id).h(28).px(11).gap(6).items_center().rounded(6).cursor_pointer()
    .border(1).border_color(recommended ? t.accent : t.input)
    .bg(recommended ? t.selected : t.raised).text_color(t.foreground).text_size(12)
    .hover((s) => s.bg(t.hover))
    // In the floating bar an unstopped press would drag the bar instead of clicking.
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click(onClick)
    .child(text)
    .when(recommended, (el) => el.child(div().text_size(10.5).text_color(t.accent).child("recommended")));
}

/** A grilling round: each question with its options, the recommended one picked until you change it. */
function grillRound(m, q, t) {
  return v_flex().gap(12)
    .children(q.questions.map((g, i) => {
      const pick = m.grillPick(q.id, i, g);
      return v_flex().gap(6)
        .child(h_flex().gap(8)
          .child(div().font_family(MONO).text_size(11).text_color(t.dim).child(`${i + 1}.`))
          .child(div().flex_1().text_size(13).line_height(1.4).child(g.q)))
        .child(h_flex().pl(18).gap(6).flex_wrap().children(g.options.map((o, j) => {
          const on = o === pick;
          return h_flex().id(`g-${q.id}-${i}-${j}`).h(26).px(10).gap(6).items_center().rounded(6).cursor_pointer()
            .border(1).border_color(on ? t.accent : t.input).bg(on ? t.selected : t.raised)
            .text_size(12).text_color(on ? t.foreground : t.muted)
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { m.setGrillPick(q.id, i, o); cx.notify(); })
            .child(on ? "● " + o : o)
            .when(o === g.recommended, (el) => el.child(div().text_size(10.5).text_color(t.accent).child("recommended")));
        })))
        .when(Boolean(g.why) && pick === g.recommended, (el) => el.child(
          div().pl(18).text_size(11.5).text_color(t.dim).child(g.why)));
    }))
    .child(h_flex().child(answerButton(t, `g-${q.id}-send`, `Send round ${q.round ?? 1} answers`, false, () => m.sendRound(q))));
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

export function renderNeeds(m) {
  const t = palette();
  const qs = m.questions();
  const now = Date.now();

  const card = (q) => {
    const kind = KINDS[q.kind] ?? KINDS.ask;
    const color = groupColor(t, kind.group);
    const task = q.taskObj;
    const where = task
      ? `${STAGES[task.stage]?.title ?? task.stage}${["implement", "review", "ci", "proof"].includes(task.stage) ? ` · loop ${task.loop ?? 1}/${task.maxLoops ?? 3}` : ""}`
      : "";
    const finding = (task?.findings ?? []).filter((f) => f.state !== "resolved").slice(-1)[0];
    const input = m.replyInput(q.id);
    return v_flex().id(`q-${q.id}`).w_full().max_w(760).gap(10).p(14).rounded(8)
      .bg(t.surface).border(1).border_color(t.blocked)
      .child(h_flex().gap(8).items_center()
        .child(h_flex().gap(5).px(7).h(20).items_center().rounded(5).border(1).border_color(color)
          .text_size(11).text_color(color)
          .child(kind.icon).child(kind.label))
        .child(div().font_family(MONO).text_size(11).text_color(t.muted).child(q.task))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(task?.title ?? ""))
        .child(div().text_size(11).text_color(t.dim).child(where))
        .child(div().font_family(MONO).text_size(10.5).text_color(t.dim).child(age(now - (Date.parse(q.asked) || now)))))
      .child(div().text_size(14).line_height(1.4).text_color(t.foreground).child(q.text))
      .child(div().text_size(11.5).text_color(t.dim)
        .child(`asked by ${q.from ?? "shepherd"}${finding ? ` · last finding: ${finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""} ` : ""}${finding.text}` : ""}`))
      .when(q.kind === "grill" && Array.isArray(q.questions), (el) => el.child(grillRound(m, q, t)))
      .when(q.kind === "approve" && Array.isArray(q.tickets), (el) => el.child(ticketList(q, t)))
      .when((q.options ?? []).length > 0, (el) => el.child(h_flex().gap(8).flex_wrap().children(
        q.options.map((o, i) => answerButton(t, `q-${q.id}-o${i}`, o, o === q.recommended, () => m.answer(q, o))))))
      .when(Boolean(input), (el) => el.child(h_flex().gap(8).items_center()
        .child(Input.new(input).flex_1().h(30).px(9).rounded(6).border(1).border_color(t.input)
          .bg(t.background).text_size(12.5).text_color(t.foreground))
        .child(answerButton(t, `q-${q.id}-send`, "Send", false, () => m.answer(q, input.value())))));
  };

  return v_flex().id("shepherd-needs").size_full().bg(t.surface).text_size(12).text_color(t.foreground)
    .child(m.header("needs you", `${m.space()?.name ?? "—"} · ${qs.length} open`))
    .child(v_flex().id("needs-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(12).items_center()
      .when(qs.length === 0, (el) => el.child(
        div().pt(40).text_size(13).text_color(t.dim).child("Nothing needs you. Shepherd will ask here when it does.")))
      .children(qs.map(card)));
}
