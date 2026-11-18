// The board's hover peek: resting the pointer on a card for PEEK_MS opens a 340px popup beside it with
// the card's agent (address, role · model · id, time in stage), its last terminal lines and the
// S / T / ↵ footer. Moving off closes it. One peek per board copy (m.peek); the lines are read with
// `hc read` when the pointer lands and every PEEK_REFRESH_MS while it stays.

import { div } from "gpui-kit";
import { v_flex, h_flex, Popup } from "gpui-base";
import { hc } from "herdr";
import { STAGES, ROLE, MONO, age, kTokens, statusColor } from "./common.js";

export const PEEK_MS = 380;
const PEEK_REFRESH_MS = 1500;
const PEEK_LINES = 5;
const PEEK_W = 340;

/** The pointer entered (on) or left a card: start the delay and the reads, or close. */
export function hoverPeek(m, c, on, cx) {
  if (on) {
    if (m.peek?.key === c.key) return;
    closePeek(m);
    const peek = { key: c.key, address: c.address, shown: false, lines: null, error: null };
    m.peek = peek;
    const read = (cx) => {
      if (m.peek !== peek || !peek.address || peek.reading) return;
      peek.reading = true;
      hc(["read", peek.address]).then((r) => {
        peek.reading = false;
        if (r.code === 0) { peek.lines = screenTail(r.stdout); peek.error = null; }
        else peek.error = (r.stderr || "").trim().split("\n")[0] || `hc read exited ${r.code}`;
        if (m.peek === peek && peek.shown) cx.notify();
      }).catch((e) => { peek.reading = false; peek.error = String(e?.message ?? e); });
    };
    if (c.address && c.live) {
      read(cx);
      m.peekTick = cx.timer.every(PEEK_REFRESH_MS, (cx) => { if (peek.shown) read(cx); });
    }
    m.peekTimer = cx.timer.after(PEEK_MS, (cx) => {
      if (m.peek !== peek || m.steerOpen?.()) return;
      peek.shown = true;
      cx.notify();
    });
  } else if (m.peek?.key === c.key) {
    closePeek(m);
    cx.notify();
  }
}

export function closePeek(m) {
  m.peekTimer?.cancel();
  m.peekTick?.cancel();
  m.peekTimer = m.peekTick = null;
  m.peek = null;
}

/** The task key S / T / ↵ act on while a peek is up. */
export const peekedKey = (m) => (m.peek?.shown ? m.peek.key : null);

/** The last lines of a terminal screen, without Claude Code's input box and status line under it
 *  (between the last two rules) and without blank or right-aligned notice lines. */
export function screenTail(text, n = PEEK_LINES) {
  let lines = String(text ?? "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  const rule = (l) => /^\s*[─━═]{8,}\s*$/.test(l);
  const last = lines.findLastIndex(rule);
  if (last >= 0) {
    const top = lines.slice(0, last).findLastIndex(rule);
    lines = lines.slice(0, top >= 0 && last - top <= 8 ? top : last);
  }
  return lines.filter((l) => l.trim() && !rule(l) && !/^\s{24,}\S/.test(l)).slice(-n);
}

/** What a card's peek says when there's no screen to show: the design's lines per status. */
function statusLines(t, c, m) {
  const L = (text, fg = t.foreground) => ({ text, fg });
  if (c.paused) return [L("⏸ paused by you", t.muted), L(`  last step: ${c.task?.history?.slice(-1)[0]?.note ?? c.note}`, t.dim)];
  if (c.status === "blocked") {
    const q = m.questions().find((x) => x.task === c.id);
    return [L("⏺ waiting for an answer", t.muted), L(`? ${q?.text ?? c.note}`, t.blocked)];
  }
  if (c.stage === "done" || c.status === "done") return [L(`✓ ${c.note}`, t.done)];
  if (!c.address) return [L("○ no agent", t.dim), L(`  ${c.note}`, t.dim)];
  return [L(`○ ${c.address} has ended`, t.dim), L(`  ${c.note}`, t.dim)];
}

/** A screen line's color: tool results dim, a spinner line (✻ Thinking…) in the working color. */
function lineColor(t, l) {
  if (/^\s*⎿/.test(l)) return t.dim;
  if (/^\s*[✻✶✳✢✽·*]\s.*…/.test(l)) return t.working;
  return t.foreground;
}

/** The card wrapped in its peek popup (open once the delay has passed). */
export function withPeek(m, t, c, cardEl, now) {
  const open = m.peek?.key === c.key && m.peek.shown;
  return Popup.new(`peek-${c.key}`, cardEl).flex_none().anchor("top_left")
    .when(open, (el) => el.content(peekBox(m, t, c, now)));
}

function peekBox(m, t, c, now) {
  const p = m.peek;
  const task = c.task;
  const runs = task?.history ?? [];
  const cur = [...runs].reverse().find((r) => r.stage === c.stage);
  const model = cur?.model ?? m.settings().stages?.[c.stage]?.model ?? null;
  const who = [ROLE[c.stage] ?? "done", model, c.id].filter(Boolean).join(" · ");
  const tokens = runs.reduce((n, r) => n + (r.tokens ?? 0), 0);
  const lines = c.live && c.address
    ? (p.lines?.length ? p.lines.map((l) => ({ text: l, fg: lineColor(t, l) }))
      : [{ text: p.error ? `can't read ${c.address}: ${p.error}` : p.lines ? "(empty screen)" : "reading…", fg: t.dim }])
    : statusLines(t, c, m);
  const foot = task
    ? ["S steer", c.address ? "T terminal" : null, "↵ open", tokens ? `${kTokens(tokens)} tokens` : null].filter(Boolean).join(" · ")
    : "⋯ or right-click opens its terminal";
  const dot = div().size(6).rounded(3).flex_none().bg(statusColor(t, c.status))
    .when(c.status === "working", (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1200 }));
  // Beside the card, right of it when the window has room, else left: the popup pins its top-left
  // to the card's bottom-left, so it's lifted by the card's height and moved past its width (the
  // card's bounds come from its last mouse move, board.js).
  const b = p.bounds;
  const vw = globalThis.window?.viewport_size?.().width ?? Infinity;
  const dx = !b ? 0 : b.x + b.width + 8 + PEEK_W + 8 <= vw ? b.width + 8 : -(PEEK_W + 8);
  // Offsets, not margins: a margin would change the size the popup measures and places.
  return v_flex().w(PEEK_W).relative().left(dx).top(b ? -b.height : 0).rounded(8).border(1).border_color(t.input)
    .bg(t.background).shadow_lg().overflow_hidden().text_color(t.foreground)
    .child(h_flex().gap(7).items_center().px(10).py(7).bg(t.chrome).border_b(1).border_color(t.border).text_size(11)
      .child(dot)
      .child(div().flex_none().font_family(MONO).child(c.address ?? c.id))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(who))
      .child(div().flex_none().font_family(MONO).text_color(t.dim).child(age(now - c.since))))
    .child(v_flex().gap(2).px(10).pt(8).pb(10).font_family(MONO).text_size(11).line_height(1.55)
      .children(lines.map((l) => div().truncate().text_color(l.fg).child(l.text))))
    .child(div().px(10).py(6).border_t(1).border_color(t.border).font_family(MONO).text_size(10.5).text_color(t.dim)
      .child(foot));
}

/** Header text for the card's time: "34m in Code review · 12k tokens so far" / "Total time 2h 5m". */
export function timeTooltip(c, now) {
  const runs = c.task?.history ?? [];
  const tokens = runs.reduce((n, r) => n + (r.tokens ?? 0), 0);
  const tok = tokens ? ` · ${kTokens(tokens)} tokens` : "";
  if (c.stage === "done") {
    const total = runs.reduce((n, r) => n + Math.max(0, (Date.parse(r.end ?? "") || now) - (Date.parse(r.start ?? "") || now)), 0);
    return `Total time ${age(total || now - c.since)}${tok}`;
  }
  return `${age(now - c.since)} in ${STAGES[c.stage]?.title ?? c.stage}${tok ? `${tok} so far` : ""}`;
}

/** The card's bounds in the window, for placing its peek. */
export function trackPeek(m, c, e) {
  if (m.peek?.key === c.key && e?.bounds) m.peek.bounds = e.bounds;
}
