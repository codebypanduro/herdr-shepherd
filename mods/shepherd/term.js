// The task detail's Terminal tab when the agent's own terminal can't be put under the header (mode.js:
// a terminal with no agent status, such as CI, an ended one, or one whose agent couldn't be chosen):
// a mirror that reads the screen with `hc read` every TERM_REFRESH_MS while it's shown and the
// terminal is live, presses keys with `hc keys` and types with `hc send`. All of it lives on the detail copy's `m.termTab`
// (initTerm); render only notices what should be mirrored and leaves the switch to a task (syncTerm).

import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, ScrollHandle } from "gpui-base";
import { hc, terminals, run } from "herdr";
import { MONO, currentTab, screenLines } from "./common.js";

const TERM_REFRESH_MS = 1000;
/** Ticks without a change before a redraw is asked for anyway, to learn whether the pane still shows. */
const PROBE_TICKS = 5;
const KEYS = [["↑", "up"], ["↓", "down"], ["Enter", "enter"], ["Esc", "esc"], ["Tab", "tab"], ["1", "1"], ["2", "2"]];

/** The detail copy's Terminal tab state, made in init (InputState and ScrollHandle can't be made in
 *  render): { scroll, input, focused, inputTask, switching, mirror, last }. `mirror` is what's mirrored
 *  now, with its timer; `last` keeps the last lines read ({ address, lines }) for one terminal only. */
export function initTerm(m) {
  const tt = {
    scroll: ScrollHandle.new(),
    input: InputState.new({ placeholder: "" }), // "Type to <address>…" is drawn under it while empty
    focused: false, inputTask: null, switching: undefined, mirror: null, last: null,
  };
  tt.input.on("submit", (_e, cx) => sendTerm(m, tt.inputTask, cx));
  tt.input.on("change", (_e, cx) => cx.notify());
  tt.input.on("focus", () => { tt.focused = true; });
  tt.input.on("blur", () => { tt.focused = false; });
  m.termTab = tt;
}

/** The task's agent terminal as hc names it: `<machine>/<t>` in a space on another machine. */
export function termAddress(m, task) {
  const t = task?.terminal;
  if (!t) return null;
  const machine = m.spaceOf(task)?.machine ?? null; // the task's space: All spaces shows several
  return machine && !String(t).includes("/") ? `${machine}/${t}` : String(t);
}

/** The terminal's entry in the core ({state, status, …}), or null when it isn't there. */
const termOf = (address) => (address ? terminals().find((x) => x.address === address) ?? null : null);
const isLive = (address) => termOf(address)?.state === "live";

/** The task's agent terminal as this window sees it: "none" (no terminal), "live", "unknown"
 *  (another machine's terminal the core doesn't list: maybe only out of reach) or "ended". */
export function termState(m, task) {
  const address = termAddress(m, task);
  const x = termOf(address);
  const state = !address ? "none" : x?.state === "live" ? "live" : !x && address.includes("/") ? "unknown" : "ended";
  return { address, state };
}

/** Whether the task's agent waits on the person (a permission or trust prompt): the tab's amber dot. */
export const termBlocked = (m, task) => {
  const x = termOf(termAddress(m, task));
  return x?.state === "live" && x.status === "blocked";
};

/** A task as the tab keys it: its ref (`<space id>/<id>`), since ids repeat across spaces in All spaces. */
const keyOf = (task) => task?._ref ?? task?.id ?? null;

/** What should be mirrored: the open task's terminal while its Terminal tab shows, else nothing. */
const wantOf = (m, task) => (currentTab() === "terminal" && task ? `${keyOf(task)}@${termAddress(m, task) ?? ""}` : null);

/** One hc call: { ok, code, stdout, error } (error: the first line hc wrote, or why it didn't run). */
async function hcRun(args) {
  try {
    const r = await hc(args);
    return { ok: r.code === 0, code: r.code, stdout: r.stdout,
      error: r.code === 0 ? null : (r.stderr || "").trim().split("\n")[0] || `hc ${args[0]} exited ${r.code}` };
  } catch (e) {
    return { ok: false, code: -1, stdout: "", error: String(e?.message ?? e) };
  }
}

/** Called from the detail's render. A change is made after this frame in a task of its own (render
 *  can't notify). Every render also tells the mirror its last redraw came. */
export function syncTerm(m, task, cx) {
  const tt = m.termTab;
  if (!tt) return;
  const want = wantOf(m, task);
  if (tt.mirror) tt.mirror.rendered = true;
  if ((tt.mirror?.want ?? null) === want || tt.switching === want) return;
  tt.switching = want;
  cx.spawn(async (cx) => {
    await cx.sleep(0);
    tt.switching = undefined;
    const task2 = m.termMode && m.termMode !== "mirror" ? null : m.selectedTask(); // the real terminal shows: no mirror
    const now = wantOf(m, task2);
    if ((tt.mirror?.want ?? null) === now) return;
    stopTerm(m);
    // The field's text was for that task's agent: another task starts empty.
    if (keyOf(task2) !== tt.inputTask) { tt.input.set_value(""); tt.inputTask = keyOf(task2); }
    if (now) startTerm(m, task2, now, cx);
    cx.notify();
  });
}

/** Starts mirroring. A live terminal is read at once and every TERM_REFRESH_MS; an ended one is read
 *  once for its last lines and gets no timer. */
function startTerm(m, task, want, cx) {
  const tt = m.termTab;
  const address = termAddress(m, task);
  if (tt.last && tt.last.address !== address) tt.last = null;
  const term = { want, address, taskId: keyOf(task), lines: tt.last?.lines ?? null, error: null,
    reading: false, again: false, rendered: true, quiet: 0, tick: null, sending: false, scrollTo: false };
  tt.mirror = term;
  if (!address) return;
  readTerm(m, term, cx, true);
  if (!isLive(address)) return;
  term.tick = cx.timer.every(TERM_REFRESH_MS, (cx) => {
    if (tt.mirror !== term) return;
    // A redraw was asked for and none came: the pane is hidden (close() isn't called for that). Stop;
    // the next render starts it again.
    if (!term.rendered) { stopTerm(m); return; }
    // It ended: stop reading, keep its last lines, and redraw once for the ended state.
    if (!isLive(address)) { term.tick?.cancel(); term.tick = null; cx.notify(); return; }
    readTerm(m, term, cx);
  });
}

/** Cancels the mirror's timer and drops it. Never notifies, so it's safe from render and close().
 *  A field that goes away may never send blur, so it no longer counts as focused. */
export function stopTerm(m) {
  const tt = m.termTab;
  if (!tt) return;
  tt.mirror?.tick?.cancel();
  tt.mirror = null;
  tt.focused = false;
}

/** One `hc read` of the mirrored terminal, in a task of its own (a timer's or click's cx isn't kept).
 *  Redraws on a change, and every PROBE_TICKS quiet ticks to find out whether the pane still shows.
 *  A forced read asked for while one runs (a key's "read at once") runs again right after it. */
function readTerm(m, term, cx, force = false) {
  const tt = m.termTab;
  if (tt.mirror !== term) return;
  if (term.reading) { if (force) term.again = true; return; }
  term.reading = true;
  cx.spawn(async (cx) => {
    let changed = force;
    const r = await hcRun(["read", term.address]);
    if (r.ok) {
      const lines = screenLines(r.stdout);
      if (lines.join("\n") !== (term.lines ?? []).join("\n") || term.error) changed = true;
      term.lines = lines;
      term.error = null;
      tt.last = { address: term.address, lines };
    } else {
      if (r.error !== term.error) changed = true;
      term.error = r.error;
    }
    term.reading = false;
    if (tt.mirror !== term) return;
    if (term.again) { term.again = false; readTerm(m, term, cx, true); return; }
    term.quiet = changed ? 0 : term.quiet + 1;
    if (changed || term.quiet >= PROBE_TICKS) {
      term.quiet = 0;
      term.rendered = false;
      if (changed) term.scrollTo = true; // in render, so the request runs after the new rows' layout
      cx.notify();
    }
  });
}

/** The mirror a button on `taskId`'s tab acts on: none while the switch to another task is pending. */
const mirrorFor = (m, taskId) => {
  const term = m.termTab?.mirror;
  return term?.address && term.taskId === taskId ? term : null;
};

/** A key button: `hc keys <address> <key>`, then a read at once. */
function pressKey(m, taskId, key, cx) {
  const term = mirrorFor(m, taskId);
  if (!term) return;
  cx.spawn(async (cx) => {
    const r = await hcRun(["keys", term.address, key]);
    if (m.termTab.mirror !== term) return;
    if (!r.ok) { term.error = r.error; cx.notify(); return; }
    readTerm(m, term, cx, true);
  });
}

/** Send (or Enter in the field): `hc send <address> -- <text>` (`--`: a line starting with "-" is text,
 *  not an option), which waits for a draft the person is typing in that terminal, then a read at once. */
function sendTerm(m, taskId, cx) {
  const tt = m.termTab;
  const term = mirrorFor(m, taskId);
  const text = String(tt.input.value() ?? "").trim();
  if (!term || !text || term.sending) return;
  term.sending = true;
  tt.input.set_value("");
  cx.notify();
  cx.spawn(async (cx) => {
    const r = await hcRun(["send", term.address, "--", text]);
    term.sending = false;
    if (tt.mirror !== term) return;
    if (!r.ok) {
      // hc send refuses while the agent is blocked (exit 9): its prompt takes keys, not a line.
      term.error = r.code === 9 ? "it waits on a prompt: answer with the keys" : r.error;
      if (!tt.input.value()) tt.input.set_value(text); // keep what didn't go
      cx.notify();
      return;
    }
    readTerm(m, term, cx, true);
  });
}

export function renderTerm(m, task, t) {
  const tt = m.termTab;
  const term = tt?.mirror?.taskId === keyOf(task) ? tt.mirror : null;
  const { address, state } = termState(m, task);
  const lines = term?.lines ?? (tt?.last?.address === address ? tt.last.lines : null);
  const root = v_flex().id("term-tab").flex_1().min_h(0).p(14).gap(8);

  // Not live: it ended. The core may list it as finished or not at all; another machine's terminal
  // it doesn't list may only be out of reach, so that one isn't running as far as this window knows.
  const empty = state === "none" ? `No agent runs for ${task.id} right now.`
    : state === "unknown" ? `${address} isn't running`
    : state === "ended" ? `${address} has ended`
    : null;
  // To the last row after a read changed the screen; the request runs after this frame's layout.
  if (term?.scrollTo && lines?.length && tt.scroll) { term.scrollTo = false; tt.scroll.scroll_to_item(lines.length - 1); }
  const screen = v_flex().id("term-screen").flex_1().min_h(0).overflow_y_scrollbar()
    .when(Boolean(tt?.scroll), (el) => el.track_scroll(tt.scroll))
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
        .when(Boolean(address) && state !== "none", (el) => el.child(openButton(address, t))))
      .when(Boolean(lines?.length), (el) => el.child(shown));
  }

  const keyBtn = ([label, key]) => div().id(`term-key-${key}`).px(9).h(24).flex().items_center().rounded(5)
    .bg(t.raised).cursor_pointer().font_family(MONO).text_size(11).text_color(t.foreground)
    .hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => pressKey(m, keyOf(task), key, cx))
    .child(label);
  const keys = h_flex().flex_none().gap(4).items_center()
    .children(KEYS.map(keyBtn))
    .child(div().flex_1())
    .when(Boolean(term?.error) && Boolean(lines?.length), (el) => el.child(
      div().truncate().min_w(0).font_family(MONO).text_size(10.5).text_color(t.ansi1).child(term.error)))
    .child(openButton(address, t));

  const draft = !(tt?.input.value() ?? "");
  const field = h_flex().id("term-field").flex_none().gap(8).px(10).py(8).items_center().rounded(6).border(1)
    .border_color(t.input).bg(t.background)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .child(div().font_family(MONO).text_size(12).text_color(t.accent).child("❯"))
    .child(div().relative().flex_1().min_w(0).h(18)
      .when(draft, (el) => el.child(div().absolute().inset_0().flex().items_center().truncate()
        .font_family(MONO).text_size(12).text_color(t.dim).child(`Type to ${address}…`)))
      .when(Boolean(tt), (el) => el.child(Input.new(tt.input).absolute().inset_0()
        .font_family(MONO).text_size(12).text_color(t.foreground))))
    .child(div().id("term-send").px(10).py(3).rounded(4).bg(t.raised).cursor_pointer()
      .text_size(11).text_color(draft || term?.sending ? t.dim : t.foreground)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => sendTerm(m, keyOf(task), cx))
      .child(term?.sending ? "Sending…" : "Send"));

  return root.child(shown).child(keys).child(field);
}

/** The real terminal, peeked over the tab (Herdr's peek: keep it as a tab, or close it): for what the
 *  Terminal tab can only mirror (CI, an agent with a tab of its own, another space's task). */
const openButton = (address, t) => div().id("term-open").flex_none().px(9).h(24).flex().items_center().rounded(5)
  .border(1).border_color(t.border).cursor_pointer().text_size(11).text_color(t.foreground)
  .hover((s) => s.bg(t.hover))
  .on_click(() => run("terminal.peek", { terminal: address }))
  .child("Open terminal ↗");
