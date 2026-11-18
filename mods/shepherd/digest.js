// The digest (D, a 720px dialog): today's shipped, in flight, waiting on you and tokens, then
// Shipped, Stuck, Most expensive and Needed more than one loop. "Today" is local midnight on.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay } from "herdr";
import { STAGES, MONO, age, palette, stuckColor, kTokens, runTokens } from "./common.js";

export function renderDigest(m) {
  const t = palette();
  const p = props() ?? {};
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const today = (iso) => (Date.parse(iso ?? "") || 0) >= midnight.getTime();
  const cards = m.cards().filter((c) => c.task);
  if (m.repo() && !m.state().settings) return v_flex().size_full().bg(t.surface).items_center().justify_center()
    .child(div().text_color(t.dim).child("Reading tasks…"));

  // Each task's runs today and their tokens; a task counts when it did anything today.
  const rows = cards.map((c) => {
    const runs = (c.task.history ?? []).filter((r) => today(r.start) || today(r.end));
    const last = (c.task.history ?? []).slice(-1)[0];
    return {
      c, runs,
      tokens: runTokens(runs),
      shipped: c.stage === "done" && today(last?.end ?? last?.start),
    };
  }).filter((x) => x.runs.length);

  const shipped = rows.filter((x) => x.shipped);
  const inFlight = cards.filter((c) => c.status === "working");
  // Waiting on you: an open question, or Ready to merge (not an agent that is merely blocked).
  const waiting = cards.filter((c) => c.asked || c.stage === "merge");
  const oldest = waiting.reduce((a, c) => Math.max(a, Date.now() - c.since), 0);
  const tokens = rows.reduce((n, x) => n + x.tokens, 0);
  const stuck = cards.filter((c) => c.stuck);
  // Most expensive: the most tokens today (tokens only, no $).
  const heaviest = rows.filter((x) => x.tokens > 0).sort((a, b) => b.tokens - a.tokens).slice(0, 4);
  const top = heaviest[0]?.tokens || 1;
  const loops = rows.filter((x) => (x.c.task.loop ?? 1) > 1);

  const open = (id) => { closeOverlay(p.overlay); m.openTask(id); };
  const stat = (value, label, color, first) => v_flex().flex_1().min_w(0).px(18).py(14).gap(3)
    .when(!first, (el) => el.border_l(1).border_color(t.border))
    .child(div().text_size(22).font_semibold().text_color(color).child(value))
    .child(div().truncate().text_size(11.5).text_color(t.muted).child(label));
  const row = (key, c, meta, color, bar) => h_flex().id(key).gap(8).items_center().px(6).py(6).rounded(5).cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .on_click(() => open(c.id))
    .child(div().w(56).flex_none().font_family(MONO).text_size(11).text_color(t.muted).child(c.id))
    .child(v_flex().flex_1().min_w(0).gap(3)
      .child(div().truncate().text_size(12.5).child(c.title))
      .when(bar != null, (el) => el.child(div().h(3).w_full().rounded(2).bg(t.border)
        .child(div().h_full().w(`${Math.round(bar * 100)}%`).rounded(2).bg(t.accent)))))
    .child(div().flex_none().font_family(MONO).text_size(11).text_color(color).child(meta));
  const section = (title, items, empty, i) => v_flex().flex_1().min_w(0).px(18).py(14).gap(2)
    .when(i % 2 === 1, (el) => el.border_l(1).border_color(t.border))
    .child(div().pb(6).text_size(11).text_color(t.dim).child(title))
    .when(items.length === 0, (el) => el.child(div().text_size(12).text_color(t.dim).child(empty)))
    .children(items);

  const d = new Date();
  const date = `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${d.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]}`;
  return v_flex().id("shepherd-digest").size_full().bg(t.surface).text_color(t.foreground).text_size(12)
    .child(h_flex().flex_none().px(18).py(16).gap(10).items_center().border_b(1).border_color(t.border)
      .child(div().text_size(15).font_semibold().child("Today"))
      .child(div().text_color(t.dim).child(`${m.space()?.name ?? "—"} · ${date}`))
      .child(div().flex_1())
      .child(div().px(6).py(2).rounded(4).border(1).border_color(t.input).font_family(MONO).text_size(10.5).text_color(t.dim).child("esc")))
    .child(h_flex().flex_none().border_b(1).border_color(t.border)
      .child(stat(String(shipped.length), "shipped", t.done, true))
      .child(stat(String(inFlight.length), "in flight", t.working))
      .child(stat(String(waiting.length), `waiting on you${waiting.length ? ` · oldest ${age(oldest)}` : ""}`, t.blocked))
      .child(stat(tokens > 0 ? kTokens(tokens) : "—", "tokens today", t.foreground)))
    .child(v_flex().id("digest-scroll").flex_1().min_h(0).overflow_y_scrollbar()
      .child(h_flex().items_start()
        .child(section("SHIPPED", shipped.map((x, i) => row(`dg-s-${i}`, x.c, `loop ${x.c.task.loop ?? 1}${x.tokens ? ` · ${kTokens(x.tokens)} tokens` : ""}`, t.done)), "Nothing shipped yet today.", 0))
        .child(section("STUCK", stuck.map((c, i) => row(`dg-k-${i}`, c, `${age(Date.now() - c.since)} in ${STAGES[c.stage]?.title ?? c.stage}`, stuckColor(t))), "Nothing is stuck.", 1)))
      .child(h_flex().items_start().border_t(1).border_color(t.border)
        .child(section("MOST EXPENSIVE", heaviest.map((x, i) => row(`dg-e-${i}`, x.c, `${kTokens(x.tokens)} tokens`, t.foreground, x.tokens / top)), "No tokens recorded today.", 2))
        .child(section("NEEDED MORE THAN ONE LOOP", loops.map((x, i) => row(`dg-l-${i}`, x.c, `${x.c.task.loop} loops`, t.blocked)), "Everything passed review first time.", 3))));
}
