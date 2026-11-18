// What the work area shows (slice 10k): ✻ Shepherd (the views and the detail on top, Shepherd's tab
// under them) or one of the space's own tabs, full size. Each space remembers its last one in shared
// LAST_TAB; a new space starts on ✻ Shepherd.
//
// Herdr has no block whose terminal a mod can point anywhere, so the layout works with what it has:
// - `term` is a `{tab: "active"}` block: with ✻ Shepherd it shows Shepherd's tab (selected here), with
//   a pill that tab. `main` (views + detail) shows only with ✻ Shepherd; `noshep` stands in for `term`
//   when the space has no Shepherd.
// - The detail's Terminal tab is an `{agent: "focused"}` block (`taskterm`, see syncTaskTerm). While it
//   shows, Herdr keeps the chosen agent's own tab selected, so only agents without a tab (Shepherd's
//   sub-agents) go there; focusing another agent's pane (clicking Shepherd) takes the block.
// A tab that holds only Shepherd or task agents (and what they started) never gets a pill.

import { spaces, terminals, panes, run, shared, setShared, focused } from "herdr";
import { TAB, SELECTED, currentTab } from "./common.js";

export const LAST_TAB = "shepherd.lastTab"; // {space id: "shepherd" | tab id}

const ROLES = new Set(["shepherd", "triager", "griller", "planner", "implementer", "reviewer", "ci", "qa"]);
const isShep = (x) => x?.labels?.["herdr.role"] === "shepherd";
/** Shepherd, a task's agent (by its labels), or something one of them started (by `parent`). */
function isShepherds(x, byAddr, depth = 0) {
  if (!x || depth > 6) return false;
  const l = x.labels ?? {};
  if (ROLES.has(l["herdr.role"]) || l["shepherd.task"] || l["shepherd.stage"]) return true;
  return x.parent ? isShepherds(byAddr.get(x.parent), byAddr, depth + 1) : false;
}

/** The space's tabs as the bar shows them: Shepherd's tab (the one holding a live Shepherd), the
 *  person's own tabs (pills), and the hidden ones (only Shepherd's agents). */
export function spaceTabs(space, all = terminals(), ps = panes()) {
  const byAddr = new Map(all.map((x) => [x.address, x]));
  const out = { shep: null, own: [], hidden: new Set() };
  for (const tab of space?.tabs ?? []) {
    const ts = ps.filter((p) => p.tab === tab.id && p.terminal).map((p) => byAddr.get(p.terminal)).filter(Boolean);
    if (ts.some((x) => isShep(x) && x.state === "live")) { out.shep ??= tab; out.hidden.add(tab.id); continue; }
    if (ts.length && ts.every((x) => isShepherds(x, byAddr))) { out.hidden.add(tab.id); continue; }
    out.own.push({ tab, terms: ts });
  }
  return out;
}

/** "shepherd" or the id of one of the space's own tabs. */
export function modeOf(space, st = spaceTabs(space)) {
  const v = (shared(LAST_TAB) ?? {})[space?.id];
  return v && v !== "shepherd" && st.own.some((o) => o.tab.id === v) ? v : "shepherd";
}

export function setMode(space, which) {
  if (!space) return;
  const cur = shared(LAST_TAB) ?? {};
  if (cur[space.id] === which) return;
  setShared(LAST_TAB, { ...cur, [space.id]: which });
}

/** The tab Herdr should have selected in the space: the pill's, Shepherd's, or null (✻ with no Shepherd). */
export const wantedTab = (space, st = spaceTabs(space)) => {
  const mode = modeOf(space, st);
  return mode === "shepherd" ? st.shep?.id ?? null : mode;
};

/** Called from the tab bar copy's render (one per window): puts the layout and Herdr's selected tab
 *  in line with the shown space's mode, after the frame. A tab the person selected some other way
 *  (keys, Herdr's own commands) becomes the mode; a hidden tab (Shepherd's agents, which
 *  `agent.focus` and layout reloads select) is never left selected. */
export function syncMode(m, cx) {
  const space = m.shownSpace();
  if (!space) return;
  const st = spaceTabs(space);
  const mode = modeOf(space, st);
  const active = (space.tabs ?? []).find((t) => t.active)?.id ?? null;
  const seen = (m.seenActive ??= {});
  const changed = seen[space.id] !== undefined && seen[space.id] !== active;
  seen[space.id] = active;

  let next = mode;
  if (changed && active && !st.hidden.has(active) && active !== wantedTab(space, st)) next = active; // the person picked it
  if (changed && active && active === st.shep?.id && mode !== "shepherd") next = "shepherd";
  const want = next === "shepherd" ? st.shep?.id ?? null : next;
  const layoutKey = `${next === "shepherd"}|${next !== "shepherd" || Boolean(st.shep)}`;
  const doSelect = want && active !== want && (m.selectAsked?.id !== want || Date.now() - m.selectAsked.at > 700);
  if (next === mode && layoutKey === m.layoutKey && !doSelect) return;
  cx.spawn(async (cx) => {
    await cx.sleep(0); // render can't change state: after this frame
    if (next !== mode) setMode(space, next);
    if (layoutKey !== m.layoutKey) {
      m.layoutKey = layoutKey;
      const [main, term] = layoutKey.split("|").map((x) => x === "true");
      run(main ? "layout.show" : "layout.hide", { id: "main" });
      run(term ? "layout.show" : "layout.hide", { id: "term" });
      run(main && !term ? "layout.show" : "layout.hide", { id: "noshep" });
      run(main ? "layout.show" : "layout.hide", { id: "status" }); // a pill: only the sidebar and the tab bar stay
    }
    if (doSelect) { m.selectAsked = { id: want, at: Date.now() }; run("tab.select", { id: want }); }
  });
}

/** Shows a mode in the shown space: a pill's tab or ✻ Shepherd. */
export function showMode(m, which, space = m.shownSpace()) {
  setMode(space, which);
  const want = which === "shepherd" ? spaceTabs(space).shep?.id : which;
  if (want) run("tab.select", { id: want });
}

/** The detail copy's Terminal tab. The task's agent shows in the `taskterm` block under the
 *  detail's header when it can: a live agent of the shown space with no pane of its own (Shepherd
 *  starts task agents as its sub-agents, so they have none), while ✻ Shepherd shows. An agent with a
 *  pane can't: choosing it would keep its own tab selected under the views. Opening the tab chooses
 *  the agent once (`agent.focus`, which also gives it the keyboard). Focusing another agent's pane
 *  (clicking Shepherd's terminal) takes the block; the tab then offers to show it again rather than
 *  taking the keyboard back. Returns "embed" (the block shows it), "detached" (it could, another
 *  agent has the block) or "mirror" (term.js reads its screen). Changes run after the frame. */
export function syncTaskTerm(m, task, address, cx) {
  const tt = (m.embed ??= { key: undefined, chose: null });
  const space = m.shownSpace();
  const x = address ? terminals().find((y) => y.address === address) : null;
  const onTab = Boolean(task) && currentTab() === "terminal";
  const ok = onTab && x?.state === "live" && Boolean(x.status) && space && modeOf(space) === "shepherd"
    && m.spaceOf(task)?.id === space.id && !panes().some((p) => p.terminal === address) && Boolean(m.headH);
  const attached = ok && focused()?.agent === address;
  const state = !ok ? "mirror" : attached ? "embed" : "detached";
  const want = ok ? `${task._ref}@${address}` : null;
  const choose = ok && tt.chose !== want; // the tab just opened on this agent
  if (!ok) tt.chose = null;
  // Just chosen: the block stays up a moment while Herdr takes the choice.
  const key = attached || (ok && Date.now() - (tt.shownAt ?? 0) < 1500) ? `on|${Math.ceil(m.headH)}` : "off";
  if (key === tt.key && !choose) return state;
  cx.spawn(async (cx) => {
    await cx.sleep(0);
    if (choose) {
      tt.chose = want;
      showAgent(m, address);
      cx.timer.after(1600, (cx) => cx.notify()); // look again once the grace is over
      return cx.notify();
    }
    if (key !== tt.key) {
      tt.key = key;
      if (key !== "off") {
        run("layout.resize", { id: "detailbody", px: Math.ceil(m.headH) });
        run("layout.show", { id: "taskterm" });
      } else {
        run("layout.hide", { id: "taskterm" });
        run("layout.resize", { id: "detailbody", weight: 1 });
      }
    }
    cx.notify();
  });
  return state;
}

/** Shows the `taskterm` block and chooses its agent (also the Terminal tab's "Show its terminal
 *  here"). Herdr ignores the choice while no agent block shows, so the block goes up first. */
export function showAgent(m, address) {
  const tt = (m.embed ??= { key: undefined, chose: null });
  tt.shownAt = Date.now();
  tt.key = `on|${Math.ceil(m.headH ?? 0)}`;
  if (m.headH) run("layout.resize", { id: "detailbody", px: Math.ceil(m.headH) });
  run("layout.show", { id: "taskterm" });
  run("agent.focus", { terminal: address });
}

/** T, the ▭ chip, the steer menu's Open terminal: the task on its Terminal tab (its agent takes the
 *  keyboard when it shows there). */
export function openTaskTerminal(m, ref) {
  if (!ref) return;
  const space = m.shownSpace();
  if (space) showMode(m, "shepherd", space);
  setShared(SELECTED, `task-${ref}`);
  setShared(TAB, "terminal");
  run("layout.show", { id: "detail" });
}
