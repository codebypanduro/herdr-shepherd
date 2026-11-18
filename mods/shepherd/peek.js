// The board's hover peek: resting the pointer on a card for PEEK_MS opens a 340px popup beside it with
// the card's agent (address, role · model · id, time in stage), its last terminal lines and the
// S / T / ↵ footer. Moving off closes it. One peek per board copy (m.peek), holding its own timers;
// the lines are read with `hc read` once the delay has passed and every PEEK_REFRESH_MS while it's up.

import { div } from "gpui-kit";
import { v_flex, h_flex, Popup } from "gpui-base";
import { hc, shared } from "herdr";
import { ROLE, MONO, STEER_OPEN, age, kTokens, statusColor, taskTokens } from "./common.js";

export const PEEK_MS = 380;
const PEEK_REFRESH_MS = 1500;
const PEEK_LINES = 5;
const PEEK_W = 340;
const PEEK_GAP = 8;

/** The pointer entered (on) or left a card: start the delay, or close. */
export function hoverPeek(m, c, on, cx) {
  if (!on) {
    if (m.peek?.key === c.key) { closePeek(m); cx.notify(); }
    return;
  }
  if (m.peek?.key === c.key) return;
  closePeek(m);
  // { key, address, live, shown, lines, error, reading, bounds, timer, tick }
  const peek = { key: c.key, address: c.address, live: Boolean(c.address && c.live), shown: false, lines: null, error: null };
  m.peek = peek;
  peek.timer = cx.timer.after(PEEK_MS, (cx) => {
    // Not over the steer menu (the design skips the peek while it's open).
    if (m.peek !== peek || shared(STEER_OPEN)) return;
    peek.shown = true;
    cx.notify();
    if (!peek.live) return;
    readPeek(m, peek, cx);
    peek.tick = cx.timer.every(PEEK_REFRESH_MS, (cx) => readPeek(m, peek, cx));
  });
}

/** One `hc read` of the peeked terminal, in a task of its own (a callback's cx isn't kept). */
function readPeek(m, peek, cx) {
  if (m.peek !== peek || peek.reading) return;
  peek.reading = true;
  cx.spawn(async (cx) => {
    try {
      const r = await hc(["read", peek.address]);
      if (r.code === 0) { peek.lines = screenTail(r.stdout); peek.error = null; }
      else peek.error = (r.stderr || "").trim().split("\n")[0] || `hc read exited ${r.code}`;
    } catch (e) {
      peek.error = String(e?.message ?? e);
    }
    peek.reading = false;
    if (m.peek === peek) cx.notify();
  });
}

/** Cancels the peek's timers and drops it. Never notifies, so it's safe from render. */
export function closePeek(m) {
  m.peek?.timer?.cancel();
  m.peek?.tick?.cancel();
  m.peek = null;
}

/** The task S / T / ↵ act on while a peek is up: a task card's key, never a label-only card's. */
export const peekedKey = (m) => (m.peek?.shown && m.peek.key.startsWith("task-") ? m.peek.key : null);

/** The card's bounds in the window (its last mouse move), to pick the peek's side. */
export function trackPeek(m, c, e) {
  if (m.peek?.key === c.key && e?.bounds) m.peek.bounds = e.bounds;
}

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
  if (c.task?.status === "queued") return [L("○ not started", t.dim), L(`  ${c.note}`, t.dim)];
  if (!c.address) return [L("○ no agent", t.dim), L(`  ${c.note}`, t.dim)];
  return [L(`○ ${c.address} has ended`, t.dim), L(`  ${c.note}`, t.dim)];
}

/** A screen line's color: tool results dim, a spinner line (✻ Thinking…) in the working color. */
function lineColor(t, l) {
  if (/^\s*⎿/.test(l)) return t.dim;
  if (/^\s*[✻✶✳✢✽·*]\s.*…/.test(l)) return t.working;
  return t.foreground;
}

/** Which side of the card the peek opens on: right when the window has room for it, else left. */
export const peekSide = (b, vw) => (!b || b.x + b.width + PEEK_GAP + PEEK_W + PEEK_GAP <= vw ? "right" : "left");

/** The card with its peek: the Popup is a 1px element PEEK_GAP beside the card's top corner, so
 *  the popup pins its own top corner there and the window clamp only acts at a real edge
 *  (offsetting the content instead stacked on the clamp). `cardEl` must be `relative()`. */
export function withPeek(m, t, c, cardEl, now) {
  const p = m.peek?.key === c.key ? m.peek : null;
  const open = Boolean(p?.shown);
  const vw = globalThis.window?.viewport_size?.().width ?? Infinity;
  const right = peekSide(p?.bounds, vw) === "right";
  // The Popup element itself sits absolutely at that point (a trigger nested in it isn't laid out).
  // `.when` has no else branch: pick the side's offset here.
  const at = Popup.new(`peek-${c.key}`, div().size(1)).absolute().top(0).size(1);
  return cardEl.child((right ? at.right(-PEEK_GAP - 1) : at.left(-PEEK_GAP - 1))
    .anchor(right ? "top_left" : "top_right")
    .when(open, (el) => el.content(peekBox(m, t, c, p, now))));
}

function peekBox(m, t, c, p, now) {
  const task = c.task;
  const runs = task?.history ?? [];
  const cur = [...runs].reverse().find((r) => r.stage === c.stage);
  const model = cur?.model ?? m.settings().stages?.[c.stage]?.model ?? null;
  const who = [ROLE[c.stage] ?? "done", model, c.id].filter(Boolean).join(" · ");
  const tokens = taskTokens(task);
  const lines = p.live
    ? (p.lines?.length ? p.lines.map((l) => ({ text: l, fg: lineColor(t, l) }))
      : [{ text: p.error ? `can't read ${c.address}: ${p.error}` : p.lines ? "(empty screen)" : "reading…", fg: t.dim }])
    : statusLines(t, c, m);
  const foot = task
    ? ["S steer", c.address ? "T terminal" : null, "↵ open", tokens ? `${kTokens(tokens)} tokens` : null].filter(Boolean).join(" · ")
    : "⋯ or right-click opens its terminal";
  const dot = div().size(6).rounded(3).flex_none().bg(statusColor(t, c.status))
    .when(c.status === "working", (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1200 }));
  return v_flex().w(PEEK_W).rounded(8).border(1).border_color(t.input)
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
