// Shepherd's own command palette (⌘K in the Shepherd layout; a 600px dialog, panel "palette").
// One search field over grouped rows: Navigate, Spaces, Machines, Actions, Needs you (every open
// question's answers), Tasks, This task, Workflow, and last "Herdr commands…" (Herdr's own palette).
// Every word typed must appear in the row's group, space tag or label. ↑↓ move, ↵ runs, Esc closes.
//
// The palette is its own copy of the mod, closed as soon as a row runs, so anything that outlives it
// (an answer that may start a Shepherd, a workflow write, the board's keyboard focus) goes to the
// board copy as a `shepherd.<command>`; the palette never receives commands itself (no nextCommand
// loop), so it can't loop. Its data is the copy's own load, as the History's: local repos read on open
// and every 5 s tick; another machine's from the shared read (a dialog never starts one; with none
// cached, it reads once per tick itself), filtered in memory per key, never read per keystroke.

import { div } from "gpui-kit";
import { v_flex, h_flex, Input, ScrollHandle } from "gpui-base";
import { props, run, setShared, closeOverlay, spaces } from "herdr";
import { MONO, STAGES, VIEW_LIST, TABS, TAB, MAX_LOOPS, GO_KEYS, LETTER_KEYS, recAnswer, refOf, palette as colors } from "./common.js";
import { machineList } from "./machines.js";
import { MODELS } from "./settings.js";
import { readWorkflow } from "./ui.js";

export const PALETTE_OPEN = "shepherd.paletteOpen"; // the open palette's overlay id (⌘K toggles)

const GROUPS = ["Navigate", "Spaces", "Machines", "Actions", "Needs you", "Tasks", "This task", "Workflow", "Herdr"];
/** The board's keys as chips (common.js holds the maps boardKey reads). */
const goChips = (view) => { const k = Object.keys(GO_KEYS).find((x) => GO_KEYS[x] === view); return k ? ["G", k.toUpperCase()] : []; };
const letterChip = (name) => { const k = Object.keys(LETTER_KEYS).find((x) => LETTER_KEYS[x] === name); return k ? [k.toUpperCase()] : []; };

// ↑↓ (and ctrl-n / ctrl-p) are bound to actions in the palette's key context, at its own depth and at
// the Input's: the focused Input may take ↑↓ as its own actions before a key-down listener above it
// would see them. The keymap is the app's, so this runs once per module load.
const UP = "shepherd-palette-up", DOWN = "shepherd-palette-down";
let bound = false;
function bindKeys(cx) {
  if (bound) return;
  bound = true;
  try {
    cx.bind_keys(["ShepherdPalette", "ShepherdPalette > Input"].flatMap((context) => [
      { keystroke: "up", action: UP, context }, { keystroke: "down", action: DOWN, context },
      { keystroke: "ctrl-p", action: UP, context }, { keystroke: "ctrl-n", action: DOWN, context },
    ]));
  } catch (e) { console.log(`shepherd palette: keys not bound: ${e?.message ?? e}`); }
}

/** The palette's dialog spec; `query` is typed in already. */
export const paletteSpec = (query = "") => ({ mod: "shepherd", kind: "dialog", width: 600, height: 460, props: { panel: "palette", query } });

export function initPalette(m, cx, InputState) {
  const q = String(props()?.query ?? "");
  // selKey: the selected row by identity (group, tag, label), so a reload that drops or adds rows never
  // moves ↵ onto another row; null is the first row.
  m.pal = { selKey: null, wf: null, scroll: ScrollHandle.new(), input: InputState.new({ placeholder: "Type a command or search tasks…", value: q }) };
  m.pal.input.on("change", (_e, cx) => { m.pal.selKey = null; m.pal.scroll.scroll_to_item(0); cx.notify(); });
  m.pal.input.on("submit", () => { const rows = paletteRows(m); runRow(m, rows[selIndex(m, rows)]); });
  bindKeys(cx);
  cx.spawn(async () => { m.pal.input.focus(); });
  // The person's workflow.json, which the Workflow rows write: their "current" (Workflow settings' too).
  cx.spawn(async (cx) => { m.pal.wf = (await readWorkflow(m).catch(() => null))?.wf ?? {}; cx.notify(); });
}

const rowKey = (r) => `${r.g}|${r.tag ?? ""}|${r.label}`;
/** The selected row's index in `rows`: the one with the selected identity, else the first. */
const selIndex = (m, rows) => Math.max(0, m.pal.selKey == null ? 0 : rows.findIndex((r) => rowKey(r) === m.pal.selKey));

/** "shepherd.<cmd>" to the board copy (it outlives the palette). */
const cmd = (name, arg) => () => run(`shepherd.${name}${arg != null ? `:${arg}` : ""}`);

/** Every row before filtering, in group order: { g, label, tag?, meta?, keys, run, exact? }. */
function allRows(m) {
  const out = [];
  const add = (g, label, act, extra = {}) => out.push({ g, label, run: act, keys: [], ...extra });
  const all = m.isAll();

  for (const [v, title] of VIEW_LIST) add("Navigate", `Go to ${title.toLowerCase()}`, () => setShared("shepherd.view", v), { keys: goChips(v) });
  add("Navigate", "Talk to shepherd", cmd("history"), { keys: ["⌘", "J"] });
  add("Navigate", "Daily digest", cmd("digest"), { keys: ["D"] });
  add("Navigate", "Next card", cmd("next"), { keys: ["J"] });
  add("Navigate", "Previous card", cmd("prev"), { keys: ["K"] });

  add("Spaces", "New space from folder…", cmd("new-space"), { keys: letterChip("new-space") });
  add("Spaces", "New folder", () => m.overlayCommand("new-folder"), { keys: letterChip("new-folder") }); // as F does
  add("Spaces", all ? "Show this space only" : "Show all spaces", cmd("scope", all ? "space" : "all"));
  const shown = m.shownSpace()?.id;
  for (const s of spaces()) {
    if (s.id === shown) continue;
    add("Spaces", `Go to ${s.name}`, () => m.showSpace(s.id), { meta: s.machine ?? "" }); // alone, as the sidebar's rows do
  }

  add("Machines", "Add machine…", cmd("add-machine"));
  for (const mc of machineList()) {
    add("Machines", `Show ${mc.label}`, cmd("machine", mc.name ?? ""), { meta: !mc.online ? "unreachable" : mc.cpu != null ? `cpu ${mc.cpu}%` : "" });
  }

  add("Actions", "Approve recommended answer on focused task", cmd("accept"), { keys: ["A"] });
  add("Actions", "Open terminal of focused task", cmd("terminal"), { keys: ["T"] });
  add("Actions", "Steer focused task", cmd("steer"), { keys: ["S"] });
  add("Actions", "Pause / resume focused task", cmd("pause"), { keys: ["P"] });
  add("Actions", "Create task", cmd("focus-bar"), { keys: ["C"] });
  add("Actions", "Reply to next question", cmd("reply"), { keys: ["R"] });
  add("Actions", "Workflow settings", cmd("workflow"), { keys: letterChip("workflow") });
  add("Actions", "Weekly usage", cmd("usage"), { keys: letterChip("usage") });

  // Needs you: every open question's answers, "T-4 · Merge". The board copy sends them (shepherd.answer),
  // to the Shepherd of the question's own space. Old grilling rounds and questions without options
  // go to Needs you in their space.
  for (const q of m.questions()) {
    const tag = m.spaceTag(q);
    const rec = recAnswer(q);
    const opts = Array.isArray(q.questions) ? [] : [...(q.options ?? [])];
    if (rec && !Array.isArray(q.questions) && !opts.includes(rec)) opts.unshift(rec);
    for (const o of opts) {
      add("Needs you", `${q.task ?? q.id} · ${o}`, cmd("answer", JSON.stringify({ space: q._sid, q: q.id, task: q.task ?? null, text: o })),
        { tag, sid: q._sid, meta: o === rec ? "recommended" : "" });
    }
    if (!opts.length) add("Needs you", `${q.task ?? q.id} · Answer in Needs you…`, cmd("needs", q._sid ?? ""), { tag, sid: q._sid });
  }

  for (const task of m.state().tasks ?? []) {
    add("Tasks", `${task.id} · ${task.title ?? ""}`, () => { setShared(TAB, "overview"); m.openTask(task._ref ?? refOf(task._sid, task.id)); },
      { tag: m.spaceTag(task), sid: task._sid, meta: STAGES[task.stage]?.title ?? task.stage ?? "", exact: String(task.id).toLowerCase() });
  }

  if (m.selectedTask()) {
    TABS.forEach((tab, i) => add("This task", `Show ${tab}`, () => setShared(TAB, tab), { keys: [String(i + 1)] }));
  }

  // The person's workflow.json on this computer (the board copy writes it: shepherd.workflow-set), as
  // Workflow settings: "current" is its value. When the shown space runs on something else (its
  // orchestra.json, or another machine's workflow.json), that row also says "<space> uses it".
  if (m.pal.wf) {
    const wf = m.pal.wf;
    const shownSpace = m.shownSpace();
    const s = m.settings(shownSpace);
    const meta = (mine, theirs, v) => [v === mine ? "current" : "", theirs !== mine && v === theirs ? `${shownSpace?.name ?? "this space"} uses it` : ""].filter(Boolean).join(" · ");
    const set = (path, value) => cmd("workflow-set", JSON.stringify({ path, value }));
    const loops = wf.maxLoops ?? MAX_LOOPS;
    for (let n = 1; n <= 5; n++) add("Workflow", `Max loops: ${n}`, set(["maxLoops"], n), { meta: meta(loops, s.maxLoops ?? loops, n) });
    for (const [stage, verb] of [["implement", "Implement"], ["review", "Review"]]) {
      const cur = wf.stages?.[stage]?.model ?? null;
      for (const mo of MODELS) add("Workflow", `${verb} with ${mo}`, set(["stages", stage, "model"], mo), { meta: meta(cur, s.stages?.[stage]?.model ?? cur, mo) });
    }
  }
  return out;
}

/** The rows the query lets through, grouped: every word must appear in the row's group, space tag or
 *  label. A task whose id is the whole query ("t-2") comes first, so ↵ opens it rather than
 *  answering one of its questions; groups keep their order otherwise. Within a group the shown space's
 *  rows come before other spaces' (All spaces: "T-4 merge" answers the shown space's T-4 first; type
 *  the space's name for another). "Herdr commands…" is always last. Worked out once per turn. */
export function paletteRows(m) {
  const words = String(m.pal?.input.value() ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return m.memo(`palette:${words.join(" ")}:${Boolean(m.pal?.wf)}`, () => filterRows(m, words));
}

function filterRows(m, words) {
  const query = words.join(" ");
  const shown = m.shownSpace()?.id ?? null;
  const away = (r) => (r.sid && r.sid !== shown ? 1 : 0);
  const rows = allRows(m).filter((r) => {
    const hay = `${r.g} ${r.tag ?? ""} ${r.label}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const rank = (r) => (r.exact && (query === r.exact || query === `${(r.tag ?? "").toLowerCase()} ${r.exact}`) ? 0 : 1);
  const best = new Map();
  for (const r of rows) best.set(r.g, Math.min(best.get(r.g) ?? 1, rank(r)));
  const sorted = rows.map((r, i) => ({ r, i })).sort((a, b) =>
    (best.get(a.r.g) - best.get(b.r.g)) || (GROUPS.indexOf(a.r.g) - GROUPS.indexOf(b.r.g)) || (rank(a.r) - rank(b.r)) || (away(a.r) - away(b.r)) || (a.i - b.i));
  return [...sorted.map((x) => x.r), { g: "Herdr", label: "Herdr commands…", keys: [], run: () => run("app.palette") }];
}

function runRow(m, row) {
  if (!row) return;
  closeOverlay(props().overlay);
  row.run();
}

/** ↑↓: the bound actions, and a key-down listener in case the Input lets the keys through. One
 *  keystroke can reach both, in the same turn: a second move within 15 ms is that same key. */
function move(m, step, cx) {
  const now = Date.now();
  if (now - (m.pal.movedAt ?? 0) < 15) return;
  m.pal.movedAt = now;
  const rows = paletteRows(m);
  const i = Math.max(0, Math.min(rows.length - 1, selIndex(m, rows) + step));
  m.pal.selKey = rowKey(rows[i]);
  m.pal.scroll.scroll_to_item(m.pal.childIndex?.[i] ?? i);
  cx.notify();
}

function paletteKey(m, e, cx) {
  const k = e.key.toLowerCase();
  if (k !== "down" && k !== "up") return;
  move(m, k === "down" ? 1 : -1, cx);
  cx.stop_propagation();
}

const keyChip = (t, k) => div().min_w(18).h(18).px(4).flex().items_center().justify_center().rounded(4)
  .bg(t.raised).border(1).border_color(t.input).font_family(MONO).text_size(10.5).text_color(t.muted).child(k);

export function renderPalette(m) {
  const t = colors();
  const rows = paletteRows(m);
  const sel = selIndex(m, rows);
  const children = [];
  const childIndex = [];
  let g = null;
  rows.forEach((r, i) => {
    if (r.g !== g) {
      g = r.g;
      children.push(div().px(10).pt(10).pb(4).text_size(11).text_color(t.dim).child(g));
    }
    childIndex[i] = children.length;
    const on = i === sel;
    children.push(h_flex().id(`pal-${i}`).h(34).flex_none().px(10).gap(10).items_center().rounded(6).cursor_pointer()
      .when(on, (el) => el.bg(t.raised))
      // The pointer picks a row only once it really moves: one resting where the dialog opens (or a
      // move event at open) must not take ↵ from the top match.
      .on_mouse_move((e, cx) => {
        const at = `${Math.round(e.position.x)},${Math.round(e.position.y)}`;
        if (m.pal.pointer === undefined) { m.pal.pointer = at; return; }
        if (at === m.pal.pointer) return;
        m.pal.pointer = at;
        if (m.pal.selKey !== rowKey(r)) { m.pal.selKey = rowKey(r); cx.notify(); }
      })
      .on_click(() => runRow(m, r))
      .when(Boolean(r.tag), (el) => el.child(div().flex_none().max_w(96).truncate().font_family(MONO).text_size(10.5).text_color(t.dim).child(r.tag)))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(on ? t.foreground : t.muted).child(r.label))
      .when(Boolean(r.meta), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(r.meta)))
      .when(r.keys.length > 0, (el) => el.child(h_flex().flex_none().gap(3).children(r.keys.map((k) => keyChip(t, k))))));
  });
  m.pal.childIndex = childIndex;
  // Nothing but the Herdr row: say so above it.
  if (rows.length === 1) children.unshift(div().p(24).text_size(13).text_color(t.dim).flex().justify_center().child("No commands match."));
  if (rows.length === 1) childIndex[0] = children.length - 1;

  return v_flex().id("shepherd-palette").size_full().bg(t.surface).text_color(t.foreground)
    .key_context("ShepherdPalette")
    .on_action(UP, (_e, cx) => move(m, -1, cx))
    .on_action(DOWN, (_e, cx) => move(m, 1, cx))
    .on_key_down((e, cx) => paletteKey(m, e, cx))
    .child(h_flex().flex_none().gap(10).px(16).py(14).items_center().border_b(1).border_color(t.border)
      .child(Input.new(m.pal.input).flex_1().h(22).text_size(15).text_color(t.foreground))
      .child(div().flex_none().px(6).py(2).rounded(4).border(1).border_color(t.input).font_family(MONO).text_size(10.5).text_color(t.dim).child("esc")))
    .child(v_flex().id("pal-rows").flex_1().min_h(0).p(6).overflow_y_scrollbar().track_scroll(m.pal.scroll).children(children))
    .child(h_flex().flex_none().gap(14).px(14).py(8).border_t(1).border_color(t.border).font_family(MONO).text_size(10.5).text_color(t.dim)
      .child("↑↓ move").child("↵ run").child("G then B/P/N go to").child("1–6 task tabs"));
}
