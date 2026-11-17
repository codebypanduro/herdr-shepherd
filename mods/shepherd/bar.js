// The floating Shepherd bar: the oldest open question on top, then a line to talk to Shepherd.

import { div } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { theme, setShared } from "herdr";
import { MONO, VIEW, palette } from "./common.js";
import { answerButton } from "./needs.js";

const WIDTH = 780;

export function renderBar(m) {
  const t = palette();
  const qs = m.questions();
  const q = qs[0];
  const sh = m.shepherd();
  const status = sh?.status ?? null;
  const space = m.space();
  const openNeeds = () => setShared(VIEW, "needs");

  // Short options (Merge, Send back) sit on the question's line; longer ones (a grilling
  // question's) get a row of their own under it and shrink with … to fit the bar.
  const opts = (q?.options ?? []).slice(0, 3);
  // Characters of option text that still fit on the question's line beside the task id, the
  // "recommended" mark, the "N waiting" chip and some of the question (Approve / Merge them / Split them = 28).
  const INLINE_CHARS = 36;
  const inline = opts.join("").length <= INLINE_CHARS;
  const buttons = opts.map((o, i) => answerButton(t, `bar-o${i}`, o, o === q.recommended, () => m.answer(q, o), { fit: !inline }));
  const line = q && h_flex().w_full().gap(8).items_center()
    .child(div().size(18).flex_none().rounded(9).bg(t.blocked).text_color(t.background)
      .text_size(11).font_semibold().flex().items_center().justify_center().child("?"))
    .child(div().flex_none().font_family(MONO).text_size(11).text_color(t.blocked).child(q.task))
    .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(q.text))
    .when(inline, (el) => el.children(buttons))
    .when(opts.length === 0, (el) => el.child(answerButton(t, "bar-answer", "Answer…", false, openNeeds)))
    .when(qs.length > 1, (el) => el.child(
      div().id("bar-waiting").px(7).h(22).flex().items_center().rounded(5).cursor_pointer()
        .bg(t.blocked).text_color(t.background).text_size(11).font_semibold()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(openNeeds).child(`${qs.length} waiting`)));
  const strip = q && v_flex().id("bar-q").w_full().px(14).py(9).gap(7)
    .bg(t.raised).border_b(1).border_color(t.blocked)
    .child(line)
    .when(!inline, (el) => el.child(h_flex().w_full().min_w(0).pl(26).gap(6).items_center().children(buttons)));

  const dot = div().absolute().right(-2).bottom(-2).size(9).rounded(5).border(2).border_color(t.popover)
    .bg(!sh ? t.idle : t[status] ?? t.idle)
    .when(status === "working", (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1200 }));
  const avatar = div().relative().size(32).flex_none().rounded(8).bg(t.accent).text_color(t.accent_foreground)
    .flex().items_center().justify_center().text_size(16).child("✻").child(dot);

  const sub = sh
    ? `shepherd · ${space?.name ?? "—"} · ${m.lastEvent() ?? "ready"}`
    : "no Shepherd in this space · run shepherd/start.sh in a terminal here";

  const main = h_flex().w_full().h(56).px(12).gap(12).items_center()
    .child(avatar)
    .child(v_flex().flex_1().min_w(0).gap(2)
      // A press the bar doesn't stop starts dragging the floating block: stop it here and focus
      // the field ourselves, so clicking the line types instead of moving the bar.
      .child(div().id("bar-input").w_full()
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); m.barInput.focus(); })
        .child(Input.new(m.barInput).w_full().h(24).text_size(15).text_color(t.foreground)))
      .child(div().id("bar-sub").truncate().font_family(MONO).text_size(10.5).text_color(t.dim).cursor_pointer()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => m.toggleHistory(true))
        .child(sub)))
    .child(h_flex().id("bar-history").flex_none().h(32).px(10).gap(6).items_center().rounded(8).cursor_pointer()
      .border(1).border_color(t.input).text_size(12).text_color(t.foreground)
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => m.toggleHistory())
      .child("History")
      .child(div().px(4).rounded(3).border(1).border_color(t.input).font_family(MONO).text_size(10.5).text_color(t.dim).child("⌘J")));

  return v_flex().id("shepherd-bar").w(WIDTH).text_color(t.foreground)
    .when(Boolean(strip), (el) => el.child(strip))
    .child(main);
}
