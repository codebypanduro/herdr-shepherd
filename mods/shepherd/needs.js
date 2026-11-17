// Needs you: one card per open question, answered with buttons or free text.

import { div } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { theme } from "herdr";
import { STAGES, KINDS, MONO, groupColor, age } from "./common.js";

export function answerButton(t, id, text, recommended, onClick) {
  return h_flex().id(id).h(28).px(11).gap(6).items_center().rounded(6).cursor_pointer()
    .border(1).border_color(recommended ? t.accent : t.input)
    .bg(recommended ? t.selected : t.raised).text_color(t.foreground).text_size(12)
    .hover((s) => s.bg(t.hover))
    .on_click(onClick)
    .child(text)
    .when(recommended, (el) => el.child(div().text_size(10.5).text_color(t.accent).child("recommended")));
}

export function renderNeeds(m) {
  const t = theme();
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
