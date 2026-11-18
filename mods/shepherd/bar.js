// The floating Shepherd bar: the oldest open question on top, then a line to talk to Shepherd.

import { div } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { theme, setShared } from "herdr";
import { MONO, VIEW, palette, stateColor } from "./common.js";
import { answerButton } from "./needs.js";
import { startAction, programIcon } from "./start.js";
import { waitsText } from "./ui.js";

const WIDTH = 780;

export function renderBar(m) {
  const t = palette();
  const qs = m.questions();
  const q = qs[0];
  const sh = m.shepherd();
  const status = sh?.status ?? null;
  const space = m.space();
  const openNeeds = () => setShared(VIEW, "needs");
  // All spaces: questions and events come from every space (tagged with it); the line still goes to
  // the shown space's Shepherd, the last one selected.
  const isAll = m.isAll();
  const tagOf = (x) => m.spaceTag(x);
  const qTag = m.spaceTag(q);

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
    .when(Boolean(qTag), (el) => el.child(div().flex_none().font_family(MONO).text_size(11).text_color(t.dim).child(qTag)))
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
  // The agent Shepherd runs, by its program icon (Claude Code's, Codex's), as the design draws it;
  // the ✻ mark until there is one.
  const avatar = (sh?.program?.icon
    ? div().relative().size(32).flex_none().rounded(8).bg(t.raised).border(1).border_color(t.border)
      .flex().items_center().justify_center().child(programIcon(t, sh.program, 20))
    : div().relative().size(32).flex_none().rounded(8).bg(t.accent).text_color(t.accent_foreground)
      .flex().items_center().justify_center().text_size(16).child("✻"))
    .id("bar-avatar").cursor_pointer().tooltip(sh ? `Shepherd · ${sh.program?.name ?? "agent"}: open its terminal` : "Shepherd")
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click(() => { if (sh) m.openTerminal(sh.address, null, "Shepherd"); })
    .child(dot);

  // Without a Shepherd: Start Shepherd (or why not), and the lines that wait for it.
  const waiting = m.queued(space).length;
  const waits = waiting ? `${waitsText(waiting)} for it` : null;
  // "shepherd · <space> · T-2 code review fail · 1 finding", the task id in its result's tone.
  const ev = sh && !waiting ? m.lastEvent() : null;
  const sub = sh
    ? h_flex().min_w(0).gap(6).items_center()
      .child(div().flex_none().text_color(t.muted).child(isAll ? "shepherds" : "shepherd"))
      .child(div().flex_none().child("·"))
      .child(div().flex_none().child(isAll ? `replies go to ${space?.name ?? "—"}` : space?.name ?? "—"))
      .child(div().flex_none().child("·"))
      .when(Boolean(tagOf(ev)), (el) => el.child(div().flex_none().child(tagOf(ev))))
      .when(Boolean(ev?.task), (el) => el.child(div().flex_none().text_color(stateColor(t, ev.result, t.working)).child(ev.task)))
      .child(div().flex_1().min_w(0).truncate()
        .child(waiting ? `sending ${waiting} waiting message${waiting > 1 ? "s" : ""}…` : ev?.text ?? "ready"))
    : h_flex().min_w(0).gap(6).items_center()
      .when(m.isStarting(space), (el) => el.child(div().flex_none().child("Starting Shepherd…")))
      .when(!m.isStarting(space), (el) => el.child(div().flex_none().child("no Shepherd in this space"))
        .child(div().flex_none().child("·"))
        .child(startAction(m, t, space, "bar-shep", { size: 10.5 })))
      .when(Boolean(waits), (el) => el.child(div().flex_none().child("·")).child(div().flex_none().text_color(t.blocked).child(waits))
        .child(div().id("bar-discard").flex_none().text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); m.discardQueued(space); cx.notify(); })
          .child("Discard")));

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
        // Shepherd's own terminal (Claude as it runs); History stays on its button and ⌘J.
        .on_click(() => { if (sh) m.openTerminal(sh.address, null, "Shepherd"); else m.toggleHistory(true); })
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
