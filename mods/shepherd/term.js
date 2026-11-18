// The task detail's Terminal tab: a live mirror of the task's agent terminal. Herdr can't put a
// terminal in a mod block, so the tab reads the screen with `hc read` every TERM_REFRESH_MS while
// it's shown, presses keys with `hc keys` and types with `hc send`. "Open terminal ↗" opens the real
// one (T). The detail copy holds one mirror (m.term) with its own timer; render only notices what
// should be mirrored and leaves the switch to a task (syncTerm).

import { div } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { hc, terminals } from "herdr";
import { MONO } from "./common.js";

const TERM_REFRESH_MS = 1000;
/** Ticks without a change before a redraw is asked for anyway, to learn whether the pane still shows. */
const PROBE_TICKS = 5;
const KEYS = [["↑", "up"], ["↓", "down"], ["Enter", "enter"], ["Esc", "esc"], ["Tab", "tab"], ["1", "1"], ["2", "2"]];

/** The task's agent terminal as hc names it: `<machine>/<t>` in a space on another machine. */
export function termAddress(m, task) {
  const t = task?.terminal;
  if (!t) return null;
  const machine = m.space()?.machine ?? null;
  return machine && !String(t).includes("/") ? `${machine}/${t}` : String(t);
}

/** The terminal's live entry ({state, status, …}), or null when the core has none. */
const termOf = (address) => (address ? terminals().find((x) => x.address === address) ?? null : null);

/** Whether the task's agent waits on the person (a permission or trust prompt): the tab's amber dot. */
export const termBlocked = (m, task) => {
  const x = termOf(termAddress(m, task));
  return x?.state === "live" && x.status === "blocked";
};

/** A screen as lines: ANSI stripped, trailing spaces and the blank rows under the last text gone. */
export function screenLines(text) {
  const lines = String(text ?? "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r/g, "")
    .split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines;
}

/** Called from the detail's render: what should be mirrored now (the Terminal tab of the open task,
 *  or nothing). A change is made after this frame in a task of its own (render can't notify). */
export function syncTerm(m, task, tab, cx, currentTab) {
  const want = tab === "terminal" && task ? `${task.id}@${termAddress(m, task) ?? ""}` : null;
  if (m.term) m.term.rendered = true;
  if ((m.term?.want ?? null) === want || m.termSwitching === want) return;
  m.termSwitching = want;
  cx.spawn(async (cx) => {
    await cx.sleep(0);
    m.termSwitching = undefined;
    const task2 = m.selectedTask();
    const tab2 = currentTab();
    const now = tab2 === "terminal" && task2 ? `${task2.id}@${termAddress(m, task2) ?? ""}` : null;
    if ((m.term?.want ?? null) === now) return;
    stopTerm(m);
    // The field's text was for that task's agent: another task starts empty.
    if (task2?.id !== m.termInputTask) { m.termInput?.set_value(""); m.termInputTask = task2?.id ?? null; }
    if (now) startTerm(m, task2, now, cx);
    cx.notify();
  });
}

/** Starts mirroring: reads at once, then every TERM_REFRESH_MS while the terminal is live. */
function startTerm(m, task, want, cx) {
  const address = termAddress(m, task);
  m.termLines ??= {}; // address -> last lines read, shown once the terminal has ended
  const term = { want, address, taskId: task.id, lines: address ? m.termLines[address] ?? null : null,
    error: null, reading: false, rendered: true, quiet: 0, tick: null, sending: false };
  m.term = term;
  if (!address) return;
  readTerm(m, term, cx, true);
  term.tick = cx.timer.every(TERM_REFRESH_MS, (cx) => {
    if (m.term !== term) return;
    // A redraw was asked for and none came: the pane is hidden (close() isn't called for that). Stop;
    // the next render starts it again.
    if (!term.rendered) { stopTerm(m); return; }
    if (termOf(address)?.state !== "live") return; // ended: keep its last lines, read no more
    readTerm(m, term, cx);
  });
}

/** Cancels the mirror's timer and drops it. Never notifies, so it's safe from render and close(). */
export function stopTerm(m) {
  m.term?.tick?.cancel();
  m.term = null;
}

/** One `hc read` of the mirrored terminal, in a task of its own (a timer's or click's cx isn't kept).
 *  Redraws on a change, and every PROBE_TICKS quiet ticks to find out whether the pane still shows. */
export function readTerm(m, term, cx, force = false) {
  if (m.term !== term || term.reading) return;
  term.reading = true;
  cx.spawn(async (cx) => {
    let changed = force;
    try {
      const r = await hc(["read", term.address]);
      if (r.code === 0) {
        const lines = screenLines(r.stdout);
        if (lines.join("\n") !== (term.lines ?? []).join("\n") || term.error) changed = true;
        term.lines = lines;
        term.error = null;
        m.termLines[term.address] = lines;
      } else {
        const error = (r.stderr || "").trim().split("\n")[0] || `hc read exited ${r.code}`;
        if (error !== term.error) changed = true;
        term.error = error;
      }
    } catch (e) {
      term.error = String(e?.message ?? e);
      changed = true;
    }
    term.reading = false;
    if (m.term !== term) return;
    term.quiet = changed ? 0 : term.quiet + 1;
    if (changed || term.quiet >= PROBE_TICKS) {
      term.quiet = 0;
      term.rendered = false;
      if (changed && term.lines?.length) m.termScroll?.scroll_to_item(term.lines.length - 1);
      cx.notify();
    }
  });
}

/** A key button: `hc keys <address> <key>`, then a read at once. */
function pressKey(m, key, cx) {
  const term = m.term;
  if (!term?.address) return;
  cx.spawn(async (cx) => {
    const r = await hc(["keys", term.address, key]).catch((e) => ({ code: -1, stderr: String(e?.message ?? e) }));
    if (m.term !== term) return;
    if (r.code !== 0) { term.error = (r.stderr || "").trim().split("\n")[0] || `hc keys exited ${r.code}`; cx.notify(); return; }
    readTerm(m, term, cx, true);
  });
}

/** Send (or Enter in the field): `hc send <address> <text>`, which waits for a draft the person is
 *  typing in that terminal, then a read at once. */
export function sendTerm(m, cx) {
  const term = m.term;
  const text = String(m.termInput?.value() ?? "").trim();
  if (!term?.address || !text || term.sending) return;
  term.sending = true;
  m.termInput.set_value("");
  cx.notify();
  cx.spawn(async (cx) => {
    const r = await hc(["send", term.address, text]).catch((e) => ({ code: -1, stderr: String(e?.message ?? e) }));
    term.sending = false;
    if (m.term !== term) return;
    if (r.code !== 0) {
      // hc send refuses while the agent is blocked (exit 9): its prompt takes keys, not a line.
      term.error = r.code === 9 ? "it waits on a prompt: answer with the keys" : (r.stderr || "").trim().split("\n")[0] || `hc send exited ${r.code}`;
      if (!m.termInput.value()) m.termInput.set_value(text); // keep what didn't go
      cx.notify();
      return;
    }
    readTerm(m, term, cx, true);
  });
}

export function renderTerm(m, task, t) {
  const term = m.term?.taskId === task.id ? m.term : null;
  const address = termAddress(m, task);
  const x = termOf(address);
  const live = x?.state === "live";
  const lines = term?.lines ?? m.termLines?.[address] ?? null;
  const root = v_flex().id("term-tab").flex_1().min_h(0).p(14).pb(120).gap(8);

  const empty = !address ? `No agent runs for ${task.id} right now.`
    : !live ? `${address} has ended`
    : null;
  const screen = v_flex().id("term-screen").flex_1().min_h(0).overflow_y_scrollbar()
    .when(Boolean(m.termScroll), (el) => el.track_scroll(m.termScroll))
    .px(10).py(8).rounded(6).border(1).border_color(t.border).bg(t.background)
    .font_family(MONO).text_size(11.5).line_height(1.45);
  const shown = lines?.length
    ? screen.children(lines.map((l) => div().truncate().text_color(empty ? t.dim : t.foreground).child(l || " ")))
    : screen.child(div().text_color(t.dim).child(
      empty ? "" : term?.error ? `can't read ${address}: ${term.error}` : lines ? "(empty screen)" : "reading…"));

  if (empty) {
    return root
      .child(h_flex().gap(8).items_center().text_color(t.dim)
        .child(div().flex_1().child(empty))
        .when(Boolean(address), (el) => el.child(openButton(m, task, t))))
      .when(Boolean(lines?.length), (el) => el.child(shown));
  }

  const keyBtn = ([label, key]) => div().id(`term-key-${key}`).px(9).h(24).flex().items_center().rounded(5)
    .bg(t.raised).cursor_pointer().font_family(MONO).text_size(11).text_color(t.foreground)
    .hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => pressKey(m, key, cx))
    .child(label);
  const keys = h_flex().flex_none().gap(4).items_center()
    .children(KEYS.map(keyBtn))
    .child(div().flex_1())
    .when(Boolean(term?.error) && Boolean(lines?.length), (el) => el.child(
      div().truncate().min_w(0).font_family(MONO).text_size(10.5).text_color(t.ansi1).child(term.error)))
    .child(openButton(m, task, t));

  const draft = !(m.termInput?.value() ?? "");
  const field = h_flex().id("term-field").flex_none().gap(8).px(10).py(8).items_center().rounded(6).border(1)
    .border_color(t.input).bg(t.background)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .child(div().font_family(MONO).text_size(12).text_color(t.accent).child("❯"))
    .child(div().relative().flex_1().min_w(0).h(18)
      .when(draft, (el) => el.child(div().absolute().inset_0().flex().items_center().truncate()
        .font_family(MONO).text_size(12).text_color(t.dim).child(`Type to ${address}…`)))
      .when(Boolean(m.termInput), (el) => el.child(Input.new(m.termInput).absolute().inset_0()
        .font_family(MONO).text_size(12).text_color(t.foreground))))
    .child(div().id("term-send").px(10).py(3).rounded(4).bg(t.raised).cursor_pointer()
      .text_size(11).text_color(draft || term?.sending ? t.dim : t.foreground)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => sendTerm(m, cx))
      .child(term?.sending ? "Sending…" : "Send"));

  return root.child(shown).child(keys).child(field);
}

const openButton = (m, task, t) => div().id("term-open").flex_none().px(9).h(24).flex().items_center().rounded(5)
  .border(1).border_color(t.border).cursor_pointer().text_size(11).text_color(t.foreground)
  .hover((s) => s.bg(t.hover))
  .on_click(() => m.openTerminal(task.terminal, task.id))
  .child("Open terminal ↗");
