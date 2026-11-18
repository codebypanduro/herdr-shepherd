// What the work area shows (slice 10k): ✻ Shepherd (the views and the detail on top, Shepherd's tab
// under them) or one of the space's own tabs, full size. Each space remembers its last one in shared
// LAST_TAB; a new space starts on ✻ Shepherd.
//
// Herdr has no block whose terminal a mod can point anywhere, so the layout works with what it has:
// - `term` is a `{tab: "active"}` block: with ✻ Shepherd it shows Shepherd's tab (selected here), with
//   a pill that tab. It shares the `bottom` stack with `noshep`, which stands in for it (at the same,
//   dragged size) when the space has no Shepherd. `main` (views + detail) shows only with ✻ Shepherd.
// - The detail's Terminal tab is an `{agent: "focused"}` block (`taskterm`, see syncTaskTerm). While it
//   shows, Herdr keeps the chosen agent's own tab selected, so only agents without a tab (Shepherd's
//   sub-agents) go there; focusing another agent's pane (clicking Shepherd) takes the block.
// A tab that holds only Shepherd or task agents (and what they started) never gets a pill.

import { terminals, panes, spaces, run, shared, setShared, focused, layout } from "herdr";
import { TAB, SELECTED, ROLE, currentTab, localId } from "./common.js";

export const LAST_TAB = "shepherd.lastTab"; // {space id: "shepherd" | tab id}
export const TERM_OPEN = "shepherd.termOpen"; // a task ref whose Terminal tab was just opened: choose its agent
const SELECT_RETRY_MS = 700; // a tab.select not taken yet isn't asked again sooner
const CHOOSE_GRACE_MS = 1500; // after agent.focus, the block stays up this long while Herdr takes the choice
export const BOARD_BACK_MS = 300; // a command for the board, re-sent once ✻ Shepherd shows it again

const ROLES = new Set(["shepherd", ...Object.values(ROLE)]);
export const isShep = (x) => x?.labels?.["herdr.role"] === "shepherd";
/** Shepherd, a task's agent (by its labels), or something one of them started (by `parent`). */
function isShepherds(x, byAddr, depth = 0) {
  if (!x || depth > 6) return false;
  const l = x.labels ?? {};
  if (ROLES.has(l["herdr.role"]) || l["shepherd.task"] || l["shepherd.stage"]) return true;
  return x.parent ? isShepherds(byAddr.get(x.parent), byAddr, depth + 1) : false;
}

/** The id start.sh gives Shepherd's tab (`herdr.tab=shepherd-<space>`), as the app names it. */
const shepTabId = (space) => `${space.machine ? `${space.machine}/` : ""}shepherd-${localId(space)}`;

/** The space's tabs as the bar shows them: Shepherd's tab (the one holding a live Shepherd), the
 *  person's own tabs (pills), and the hidden ones (only Shepherd's agents, and Shepherd's own tab by
 *  its id even before its terminal is listed). */
export function spaceTabs(space, all = terminals(), ps = panes()) {
  const byAddr = new Map(all.map((x) => [x.address, x]));
  const out = { shep: null, own: [], hidden: new Set() };
  for (const tab of space?.tabs ?? []) {
    const ts = ps.filter((p) => p.tab === tab.id && p.terminal).map((p) => byAddr.get(p.terminal)).filter(Boolean);
    if (ts.some((x) => isShep(x) && x.state === "live")) { out.shep ??= tab; out.hidden.add(tab.id); continue; }
    if (tab.id === shepTabId(space) || (ts.length && ts.every((x) => isShepherds(x, byAddr)))) { out.hidden.add(tab.id); continue; }
    out.own.push({ tab, terms: ts });
  }
  return out;
}

/** "shepherd" or the id of one of the space's own tabs. */
export function modeOf(space, st = spaceTabs(space)) {
  const v = (shared(LAST_TAB) ?? {})[space?.id];
  return v && v !== "shepherd" && st.own.some((o) => o.tab.id === v) ? v : "shepherd";
}

/** Remembers the space's mode; drops the entries of spaces that are gone. */
export function setMode(space, which) {
  if (!space) return;
  const cur = shared(LAST_TAB) ?? {};
  const alive = new Set(spaces().map((s) => s.id));
  const kept = Object.fromEntries(Object.entries(cur).filter(([id]) => alive.has(id)));
  if (cur[space.id] === which && Object.keys(kept).length === Object.keys(cur).length) return;
  setShared(LAST_TAB, { ...kept, [space.id]: which });
}

/** The tab Herdr should have selected: the pill's, else Shepherd's; with no Shepherd, the first own
 *  tab when a hidden one is selected (it would hold the keyboard out of sight), else none. */
function wantedTab(space, st, mode, active) {
  if (mode !== "shepherd") return mode;
  if (st.shep) return st.shep.id;
  return active && st.hidden.has(active) ? st.own[0]?.tab.id ?? null : null;
}

/** Called from the tab bar copy's render (one per window): puts the layout and Herdr's selected tab
 *  in line with the shown space's mode, after the frame. A selection the person made some other way
 *  (Herdr's keys, `tab.new` from +) becomes the mode when it's one of their own tabs; anything else
 *  (Shepherd's or a task agent's tab, which layout reloads select; a neighbour Herdr selects after a
 *  close) is put back. The layout's shown/hidden state is asked again when the layout file reloads. */
export function syncMode(m, cx) {
  const space = m.shownSpace();
  if (!space) return;
  const ms = (m.modeSync ??= { seen: {}, selectAsked: null, layoutKey: null, layoutSig: null });
  const sig = JSON.stringify(layout() ?? null);
  if (sig !== ms.layoutSig) { ms.layoutSig = sig; ms.layoutKey = null; }
  const st = spaceTabs(space);
  const mode = modeOf(space, st);
  const tabs = space.tabs ?? [];
  const active = tabs.find((t) => t.active)?.id ?? null;
  const before = ms.seen[space.id];
  ms.seen = Object.fromEntries(Object.entries(ms.seen).filter(([id]) => spaces().some((s) => s.id === id)));
  ms.seen[space.id] = active;
  // A pick: the selection moved from a tab that still exists to one of the person's own.
  const picked = before !== undefined && before !== active && tabs.some((t) => t.id === before)
    && active && st.own.some((o) => o.tab.id === active);
  const next = picked ? active : mode;
  const want = wantedTab(space, st, next, active);
  const layoutKey = `${next === "shepherd"}|${next !== "shepherd" || Boolean(st.shep)}`;
  const doSelect = want && active !== want
    && (ms.selectAsked?.id !== want || Date.now() - ms.selectAsked.at > SELECT_RETRY_MS);
  if (next === mode && layoutKey === ms.layoutKey && !doSelect) return;
  cx.spawn(async (cx) => {
    await cx.sleep(0); // render can't change state: after this frame
    if (next !== mode) setMode(space, next);
    if (layoutKey !== ms.layoutKey) {
      ms.layoutKey = layoutKey;
      const [main, term] = layoutKey.split("|").map((x) => x === "true");
      run(main ? "layout.show" : "layout.hide", { id: "main" });
      run("layout.select", { stack: "bottom", child: term ? "term" : "noshep" });
      run(main ? "layout.show" : "layout.hide", { id: "status" }); // a pill: only the sidebar and the tab bar stay
    }
    if (doSelect) { ms.selectAsked = { id: want, at: Date.now() }; run("tab.select", { id: want }); }
  });
}

/** Whether the board shows (as the tab bar copy last laid it out): commands reach shown copies only. */
export const boardShown = (m) => m.modeSync?.layoutKey?.startsWith("true") ?? true;

/** Shows a mode in a space: a pill's tab or ✻ Shepherd. */
export function showMode(m, which, space = m.shownSpace()) {
  if (!space) return;
  setMode(space, which);
  const want = which === "shepherd" ? spaceTabs(space).shep?.id : which;
  if (want) run("tab.select", { id: want });
}

/** Puts the `taskterm` block up under the detail's measured header, or takes it down. */
function placeTaskTerm(m, on) {
  const tt = taskTermState(m);
  const key = on ? `on|${Math.ceil(m.headH ?? 0)}` : "off";
  if (key === tt.key) return;
  tt.key = key;
  if (on) {
    if (m.headH) run("layout.resize", { id: "detailbody", px: Math.ceil(m.headH) });
    run("layout.show", { id: "taskterm" });
  } else {
    run("layout.hide", { id: "taskterm" });
    run("layout.resize", { id: "detailbody", weight: 1 });
  }
}

const taskTermState = (m) => (m.taskTerm ??= { key: undefined, pending: null, failed: new Set(), layoutSig: null });

/** The detail copy's Terminal tab. The task's agent shows in the `taskterm` block under the
 *  detail's header when it can: a live agent of the shown space with no pane of its own (Shepherd
 *  starts task agents as its sub-agents, so they have none), while ✻ Shepherd shows. Its agent is
 *  chosen (`agent.focus`, which also gives it the keyboard) only when the person opens the tab
 *  (TERM_OPEN: T, ▭, Open terminal, the tab itself, 6) or asks with "Show its terminal here", never
 *  on its own: focusing another agent's pane (clicking Shepherd's terminal), a new agent for the
 *  task or coming back from a pill leave it "detached". A choice Herdr doesn't take within the grace
 *  (an address it can't choose) falls back to the mirror for that address.
 *  Returns "embed" (the block shows it), "detached" or "mirror" (term.js). Changes run after the frame. */
export function syncTaskTerm(m, task, address, cx) {
  const tt = taskTermState(m);
  const sig = JSON.stringify(layout() ?? null);
  if (sig !== tt.layoutSig) { tt.layoutSig = sig; tt.key = undefined; }
  const space = m.shownSpace();
  const x = address ? terminals().find((y) => y.address === address) : null;
  const onTab = Boolean(task) && currentTab() === "terminal";
  const ok = onTab && x?.state === "live" && Boolean(x.status) && space && modeOf(space) === "shepherd"
    && m.spaceOf(task)?.id === space.id && !panes().some((p) => p.terminal === address)
    && !tt.failed.has(address) && Boolean(m.headH);
  const attached = ok && focused()?.agent === address;
  const pending = ok && tt.pending?.address === address && Date.now() - tt.pending.at < CHOOSE_GRACE_MS;
  // The open request waits for a render that can decide (the detail's header measured, the task loaded).
  const open = onTab && Boolean(m.headH) && shared(TERM_OPEN) === task._ref;
  const choose = ok && open;
  // A choice that didn't take: this address goes to the mirror.
  const gaveUp = ok && !attached && !pending && tt.pending?.address === address;
  const took = attached && tt.pending?.address === address; // the choice took: no longer pending
  const state = !ok || gaveUp ? "mirror" : attached || pending || choose ? "embed" : "detached";
  const on = state === "embed";
  const key = on ? `on|${Math.ceil(m.headH)}` : "off";
  if (key === tt.key && !open && !gaveUp && !took) return state;
  cx.spawn(async (cx) => {
    await cx.sleep(0);
    if (open) setShared(TERM_OPEN, null);
    if (gaveUp) { tt.failed.add(address); tt.pending = null; }
    if (took) tt.pending = null;
    if (choose) showAgent(m, address, cx);
    else placeTaskTerm(m, on);
    cx.notify();
  });
  return state;
}

/** Shows the `taskterm` block and chooses its agent (also the Terminal tab's "Show its terminal
 *  here"). Herdr ignores the choice while no agent block shows, so the block goes up first. */
export function showAgent(m, address, cx) {
  const tt = taskTermState(m);
  tt.pending = { address, at: Date.now() };
  placeTaskTerm(m, true);
  run("agent.focus", { terminal: address });
  cx.timer.after(CHOOSE_GRACE_MS + 100, (cx) => cx.notify()); // look again once the grace is over
}

/** Asks for the task's Terminal tab with its agent chosen (the next detail render does it). */
export function requestTerminal(ref) {
  if (!ref) return;
  setShared(TAB, "terminal");
  setShared(TERM_OPEN, ref);
}

/** T, the ▭ chip, the steer menu's Open terminal: the task on its Terminal tab (its agent takes the
 *  keyboard when it shows there). */
export function openTaskTerminal(m, ref) {
  if (!ref) return;
  const space = m.shownSpace();
  if (space) showMode(m, "shepherd", space);
  setShared(SELECTED, `task-${ref}`);
  requestTerminal(ref);
  run("layout.show", { id: "detail" });
}
