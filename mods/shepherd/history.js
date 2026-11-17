// History (⌘J, a 760px dialog, props {panel:"history"}): the whole chat with Shepherd, oldest first.
// Your lines (tinted box, ❯) and Shepherd's (⏺) come from chat.jsonl (shep say); events (⎿ and the
// task id in its tone) from each task's stage runs; questions inline with their answer buttons.

import { div } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { props, closeOverlay, setShared } from "herdr";
import { STAGES, KINDS, MONO, VIEW, palette, groupColor, tint } from "./common.js";
import { answerButton } from "./needs.js";

const toneOf = (t, result) => (result === "pass" ? t.done : result === "fail" ? t.ansi1 : result === "ask" ? t.blocked : t.working);

/** Every line of the History, sorted by time. */
export function historyItems(m) {
  const { tasks = [], questions = [], chat = [] } = m.state();
  const items = chat.map((c) => ({ at: Date.parse(c.at) || 0, kind: c.from === "you" ? "you" : "shepherd", text: c.text, task: c.task ?? null }));
  for (const task of tasks) {
    for (const r of task.history ?? []) {
      const title = STAGES[r.stage]?.title ?? r.stage;
      const start = Date.parse(r.start ?? "") || 0;
      const who = [r.model].filter(Boolean).join(" ");
      items.push({ at: start, kind: "event", task: task.id, result: "running",
        text: `${title} started${r.loop > 1 ? ` · loop ${r.loop}` : ""}${who ? ` (${who})` : ""}` });
      if (r.end) {
        items.push({ at: Date.parse(r.end) || start, kind: "event", task: task.id, result: r.result,
          text: `${title} ${r.result}${r.note ? ` · ${r.note}` : ""}` });
      }
    }
  }
  for (const q of questions) items.push({ at: Date.parse(q.asked) || 0, kind: "question", q, task: q.task });
  return items.sort((a, b) => a.at - b.at);
}

export function renderHistory(m) {
  const t = palette();
  const p = props() ?? {};
  const items = historyItems(m);
  const sh = m.shepherd();
  const waiting = m.questions().length;
  const close = () => closeOverlay(p.overlay);
  // Newest at the bottom: scroll there when lines arrive.
  if (items.length !== m.historyCount) { m.historyCount = items.length; if (items.length) m.historyScroll.scroll_to_item(items.length - 1); }

  const mono = (el) => el.font_family(MONO).text_size(12.5).line_height(1.55);
  const line = (it, i) => {
    if (it.kind === "you") {
      return mono(h_flex().id(`h-${i}`).gap(8).px(10).py(8).rounded(5).bg(t.raised).items_start())
        .child(div().text_color(t.accent).child("❯"))
        .child(div().flex_1().min_w(0).text_color(t.foreground).child(it.text));
    }
    if (it.kind === "shepherd") {
      return mono(h_flex().id(`h-${i}`).gap(8).items_start())
        .child(div().text_color(t.foreground).child("⏺"))
        .child(div().flex_1().min_w(0).text_color(t.muted).child(it.task ? `${it.text}` : it.text));
    }
    if (it.kind === "event") {
      return h_flex().id(`h-${i}`).gap(8).pl(2).items_start().font_family(MONO).text_size(11.5)
        .child(div().text_color(t.dim).child("⎿"))
        .child(div().flex_none().text_color(toneOf(t, it.result)).child(it.task))
        .child(div().flex_1().min_w(0).text_color(t.muted).child(it.text));
    }
    const q = it.q;
    const open = q.answer == null;
    const kind = KINDS[q.kind] ?? KINDS.ask;
    const grill = q.kind === "grill" && Array.isArray(q.questions);
    return v_flex().id(`h-${i}`).gap(8).px(12).py(10).rounded(6).border(1)
      .border_color(open ? tint(t.blocked, 0.45) : t.border).bg(open ? tint(t.blocked, 0.05) : t.surface)
      .child(h_flex().gap(8).items_center().font_family(MONO).text_size(11).text_color(t.muted)
        .child(div().text_color(t.blocked).child("?"))
        .child(div().text_color(groupColor(t, kind.group)).child(kind.label))
        .child(div().child(q.from ?? "shepherd"))
        .child(div().text_color(t.dim).child(`· ${q.task}`)))
      .child(div().text_size(13).line_height(1.45).text_color(t.foreground).child(q.text))
      .when(grill, (el) => el.child(v_flex().gap(4).children(q.questions.map((g, j) => h_flex().gap(8)
        .child(div().font_family(MONO).text_size(11).text_color(t.dim).child(`${j + 1}.`))
        .child(div().flex_1().text_size(12.5).text_color(t.muted).child(g.q))))))
      .when(Array.isArray(q.tickets), (el) => el.child(v_flex().gap(3).children(q.tickets.map((k) => h_flex().gap(8).text_size(11.5)
        .child(div().w(22).font_family(MONO).text_color(t.dim).child(k.key))
        .child(div().flex_1().text_color(t.muted).child(k.title))
        .child(div().font_family(MONO).text_color(t.dim).child(k.blockedBy?.length ? `after ${k.blockedBy.join(", ")}` : ""))))))
      .when(open && grill, (el) => el.child(h_flex().child(answerButton(t, `h-${i}-round`, `Answer round ${q.round ?? 1} in Needs you →`, false,
        () => { setShared(VIEW, "needs"); close(); }))))
      .when(open && !grill && (q.options ?? []).length > 0, (el) => el.child(h_flex().gap(6).flex_wrap().children(
        q.options.map((o, j) => answerButton(t, `h-${i}-o${j}`, o, o === q.recommended, () => m.answer(q, o))))))
      .when(!open, (el) => el.child(h_flex().gap(4).text_size(11.5).text_color(t.muted)
        .child("↳ you:").child(div().text_color(t.foreground).child(q.answer))));
  };

  const status = sh?.status ?? null;
  return v_flex().id("shepherd-history").size_full().bg(t.background).text_color(t.foreground).text_size(12.5)
    .child(h_flex().flex_none().h(44).px(14).gap(8).items_center().bg(t.surface).border_b(1).border_color(t.border)
      .child(div().size(7).rounded(4).bg(t[status] ?? t.idle)
        .when(status === "working", (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1200 })))
      .child(div().font_semibold().child(`Shepherd · ${m.space()?.name ?? "—"}`))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`${sh?.address ?? "not running"} · ${items.length} messages`))
      .when(waiting > 0, (el) => el.child(div().id("h-waiting").px(8).py(2).rounded(10).cursor_pointer()
        .bg(tint(t.blocked, 0.14)).text_color(t.blocked).text_size(11)
        .on_click(() => { setShared(VIEW, "needs"); close(); })
        .child(`${waiting} waiting on you`)))
      .child(div().px(6).py(2).rounded(4).border(1).border_color(t.input).font_family(MONO).text_size(10.5).text_color(t.dim).child("esc")))
    .child(v_flex().id("h-log").flex_1().min_h(0).px(14).pt(14).pb(8).gap(12).overflow_y_scrollbar().track_scroll(m.historyScroll)
      .when(items.length === 0, (el) => el.child(div().pt(40).flex().justify_center().text_color(t.dim)
        .child("Nothing yet. Tell Shepherd what to build.")))
      .children(items.map(line)))
    .child(div().flex_none().p(10).border_t(1).border_color(t.border)
      .child(h_flex().gap(8).px(11).py(9).items_center().rounded(6).border(1).border_color(t.input).bg(t.surface)
        .child(div().font_family(MONO).text_size(13).text_color(t.accent).child("❯"))
        .child(Input.new(m.historyInput).flex_1().h(20).font_family(MONO).text_size(13).text_color(t.foreground))));
}
