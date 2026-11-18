// Shepherd: one mod, several roles. props.view picks the main view (board, pipeline, deps, needs;
// the person's switch in shared "shepherd.view" wins), props.panel a side role (spaces, tabs,
// detail, status, bar) or an overlay (steer, term, termfoot, digest, history, plus, machine, usage,
// newspace, addmachine, workflow, spacesettings).
// Everything reads the shown space's <repo>/.herdr/shepherd/tasks.json, written by Shepherd
// through shepherd/bin/shep.mjs. The repo is the `shepherd.dir` label on the space's Shepherd
// terminal, else the space's folder. Answers and messages go to Shepherd with `hc send`.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, TextareaState, ScrollHandle } from "gpui-base";
import {
  props, terminals, panes, spaces, focused, theme, shared, setShared, readTextFile, watchFolder,
  hc, notify, playSound, exec, run, openOverlay, closeOverlay, nextCommand,
} from "herdr";
import {
  TASKS, CHAT, MAX_LOOPS, STAGES, ORDER, STUCK_MIN, LIMITS, VIEW, VIEWS, SELECTED, FILTERS, DIGEST_OPEN, HISTORY_OPEN, STEER_OPEN,
  SCOPE, localId, machineOf, palette, mins, tint, recAnswer, pendingId, refOf, parseRef,
  currentTab,
} from "./common.js";
import { renderBoard } from "./board.js";
import { peekedKey, closePeek } from "./peek.js";
import { renderNeeds } from "./needs.js";
import { renderBar } from "./bar.js";
import { renderDetail, TAB, TABS } from "./detail.js";
import { initTerm, syncTerm, stopTerm, termAddress } from "./term.js";
import { loadGit, loadDiff, loadFile, worktreeOf } from "./git.js";
import { loadPr, loadProof } from "./ship.js";
import { renderTabBar, renderCloseTab } from "./tabbar.js";
import { renderPipeline, renderDeps } from "./views.js";
import { renderSteer, renderTermBar, renderTermFoot } from "./steer.js";
import { renderDigest } from "./digest.js";
import { renderHistory } from "./history.js";
import { initSidebar, renderSidebar, renderPlus, startNewFolder, folders, setScope } from "./sidebar.js";
import { renderMachinePop, renderUsagePop } from "./machines.js";
import { initAddMachine, renderAddMachine, initNewSpace, renderNewSpace } from "./dialogs.js";
import { initWorkflow, renderWorkflow, initSpaceSettings, renderSpaceSettings } from "./settings.js";
import {
  openNewSpace, openAddMachine, openMachine, openSpaceSettings, openUsage, openWorkflow, openSetup, readWorkflow,
  execSafe, failLine, TERM_WINDOW, closeTermWindow, STARTING, QUEUED, QUEUE_MAX_MS, checkStartable, startStale,
  machineStartState, spaceByArg, waitsText,
} from "./ui.js";
import { renderSetup, renderNewTab, initSetup } from "./start.js";
import { renderToast, isToast, trackToast, untrackToast, TOAST_MS, TOAST_MAX } from "./toast.js";

const REFRESH_MS = 5000;
const PENDING = "shepherd.pending"; // question ids answered here that tasks.json hasn't caught up with
const ALERTED = "shepherd.alerted"; // "<repo key>#<question id>" already alerted
const SENT_TEXT = "shepherd.sentText"; // "<repo key>#<question id>" → the answer text sent from here (History shows it at once)
const ANSWERED = "shepherd.answered"; // "<repo key>#<question id>" answered here (never pruned by load; toasts read it)
const ALERT_WINDOW_MS = 15 * 60000; // older questions found on first sight are not news
const REPLY_SLOTS = 12; // InputStates can't be made in render: a fixed pool for Needs you cards
const GIT_STALE_MS = 10000; // Changes and Files reload this often while shown
const GIT_COUNT_STALE_MS = 30000; // other tabs (Changes' count on the tab bar) reload less often
const PR_STALE_MS = 30000; // gh pr view, for the PR card's checks
const PROOF_STALE_MS = 15000;
const LOAD_MS = 15000; // the status bar's machine load
const CHAT_MAX = 500; // History keeps the newest lines
const QINDEX = new WeakMap(); // questions array → questionIndex(), so it is worked out once per load
const START_STALE_MS = 120000; // a "starting" mark older than this (start.sh done, no Shepherd showed) is dropped
const QUEUE_IDLE_MS = 5000; // queued lines go once Shepherd has been idle (or done) this long
const QUEUE_FALLBACK_MS = 90000; // a Shepherd that never reports a status gets queued lines after this
const QUEUE_CLAIM_MS = 60000; // a copy sending a line holds it this long, so two copies never send it twice
const REMOTE_FRESH_MS = 4000; // the shown space on another machine: one read per 5 s tick, whichever copy asks first
const REMOTE_MS = 30000; // every other space on another machine (All spaces, the sidebar's badges)
const EMPTY = Object.freeze({ tasks: [], questions: [], chat: [], alerts: {} });
// Copies that show every Shepherd space in All spaces; the others (detail, steer, terminal window)
// show one task's space.
const ALL_PANELS = ["bar", "tabs", "history", "digest"];

// Module code is shared by every copy of the mod (AGENTS.md), so these are too:
// - READS: reads of another machine's repo, { at, p } by repo key. A copy that wants one younger than
//   its maxAge gets the one in flight or just done, so the board, bar, tab bar and sidebar make one
//   ssh read per space per period between them, not one each.
// - TAGGED: a space's data with every task, question and chat line marked with its space (`_sid`,
//   tasks also `_ref`), per data object and space id, made once per load.
const READS = new Map();
const TAGGED = new WeakMap();

function sharedRead(key, maxAge, read) {
  const r = READS.get(key);
  if (r && Date.now() - r.at < maxAge) return r.p;
  const p = read();
  READS.set(key, { at: Date.now(), p });
  return p;
}

function tagged(d, sid) {
  let bySpace = TAGGED.get(d);
  if (!bySpace) TAGGED.set(d, (bySpace = new Map()));
  let x = bySpace.get(sid);
  if (!x) {
    const mark = (o) => ({ ...o, _sid: sid });
    x = { ...d, sid,
      tasks: (d.tasks ?? []).map((t) => ({ ...t, _sid: sid, _ref: refOf(sid, t.id) })),
      questions: (d.questions ?? []).map(mark),
      chat: (d.chat ?? []).map(mark) };
    bySpace.set(sid, x);
  }
  return x;
}

/** Task status → board status. Queued, paused and parked read as idle (grey). */
const TASK_STATUS = { working: "working", blocked: "blocked", done: "done" };

/** The board's status for a label-only card. Plain programs report none: idle. */
const statusOf = (x, stage) => {
  if (stage === "done" || x.state === "finished") return "done";
  if (["blocked", "working", "done"].includes(x.status)) return x.status;
  return "idle";
};

export default class Shepherd extends View {
  init(_props, cx) {
    // A notification (the layout's "toast" is this mod): no loading, keys or timers of its own, except
    // closing a question's toast once it's answered here (Needs you, the bar, A, another toast).
    // Read props(), not init's argument: a toast copy's argument doesn't carry the notification, and
    // a toast that missed this check ran the board's command loop and sent every toast answer twice.
    if (isToast(props() ?? {})) {
      const s = props().action?.args?.shepherd;
      if (s?.key) cx.timer.every(1000, () => { if ((shared(ANSWERED) ?? []).includes(pendingId(s.key, s.q))) closeOverlay(props().overlay); });
      return;
    }
    this.since = {}; // address -> { stage, since }: label-only cards' time in stage
    this.data = {}; // repo key -> { tasks, questions, alerts, error? }
    this.watching = new Set();
    this.gitCache = {}; // "<repo key>#<task id>" -> { git, diffs: {path: text}, files: {path: {text, added}}, ui, loading }
    // Needs you's reply fields. No placeholder of their own: it differs by the question's kind, and
    // InputState can't change one, so needs.js draws it under the empty field (hence the redraw on change).
    this.slots = Array.from({ length: REPLY_SLOTS }, () => ({ q: null, input: InputState.new({ placeholder: "" }) }));
    for (const s of this.slots) {
      s.input.on("submit", () => { const q = this.questionById(s.q); if (q) this.answer(q, s.input.value()); });
      s.input.on("change", (_e, cx) => cx.notify());
      // The detail's 1–6 keys keep off a reply field being typed in (an Overview question card).
      s.input.on("focus", () => { s.focused = true; });
      s.input.on("blur", () => { s.focused = false; });
    }
    const p = props() ?? {};
    if (p.panel === "bar") {
      this.barInput = InputState.new({ placeholder: "Tell Shepherd what to build, or ask about any task…" });
      this.barInput.on("submit", () => this.say(this.barInput.value()));
    }
    if (p.panel === "steer") {
      this.steerMode = null; // null: the menu; "redirect" | "context": the text field
      // A 3-row field per mode, each with the design's example as its placeholder (a state can't
      // change its placeholder). Enter is a new line; ⌘↵ (submit with `secondary`) or Send sends.
      this.steerInputs = {
        redirect: TextareaState.new({ placeholder: "Stop polishing the UI, fix the failing test first", rows: 3 }),
        context: TextareaState.new({ placeholder: "The timer should use the core's start time", rows: 3 }),
      };
      for (const x of Object.values(this.steerInputs)) x.on("submit", (e) => { if (e?.secondary) this.sendSteer(); });
    }
    if (p.panel === "history") {
      this.historyInput = InputState.new({ placeholder: "Talk to shepherd · try “add a dark mode toggle”" });
      this.historyInput.on("submit", () => { if (this.tell(this.historyInput.value())) this.historyInput.set_value(""); });
      this.historyScroll = ScrollHandle.new();
      this.historyCount = 0;
    }
    if (p.panel === "detail") {
      // The Overview's "Ask Shepherd about <id>…" field. No placeholder of its own: InputState can't
      // change one, so the detail draws "Ask Shepherd about <id>…" under it while it's empty.
      this.askInput = InputState.new({ placeholder: "" });
      this.askInput.on("submit", (_e, cx) => this.askAbout(cx));
      this.askInput.on("change", (_e, cx) => cx.notify());
      this.askInput.on("focus", () => { this.askFocused = true; });
      this.askInput.on("blur", () => { this.askFocused = false; });
      this.askTask = null; // the task the field's text is for
      this.askDrafts = {}; // task id -> unsent text, kept when another task is opened
      this.askPending = []; // lines sent here that chat.jsonl doesn't hold yet, shown at once
      initTerm(this); // the Terminal tab's state (term.js): this.termTab
    }
    if (p.panel === "spaces") initSidebar(this, cx, InputState);
    if (p.panel === "addmachine") initAddMachine(this, cx, InputState);
    if (p.panel === "newspace") initNewSpace(this, cx, InputState);
    if (p.panel === "workflow") initWorkflow(this, cx);
    if (p.panel === "spacesettings") initSpaceSettings(this, cx, InputState);
    if (p.panel === "setup") initSetup(this);
    // D and ⌘J toggle these: the open copy's overlay id, cleared in close().
    if (p.panel === "digest") setShared(DIGEST_OPEN, p.overlay ?? null);
    if (p.panel === "history") setShared(HISTORY_OPEN, p.overlay ?? null);
    if (p.panel === "steer") setShared(STEER_OPEN, p.overlay ?? null); // the board skips the peek while it's up
    // A steer menu never outlives a restart, but its id in shared state would (close() didn't run).
    if (!p.panel && shared(STEER_OPEN)) setShared(STEER_OPEN, null);
    // Keys (J/K, S, P, T, …) go to these copies only while they hold the keyboard, so typing in the
    // bar, a reply field or a terminal never triggers them. The board gets the keyboard when clicked
    // or from "focus" (mod.json focusable: pane.go, or a popup over it closing); popups and the
    // terminal window's title bar take it when they open (the footer takes it back when clicked).
    if (!p.panel || ["steer", "detail", "term", "termfoot", "history"].includes(p.panel)) {
      this.keys = cx.focus_handle();
      if (p.panel === "steer" || p.panel === "term") cx.spawn(async () => { this.keys.focus(); });
      if (p.panel === "history") cx.spawn(async () => { this.historyInput.focus(); });
    }
    // Key commands from keys.json ("shepherd.digest", "shepherd.view:pipeline", …).
    if (!p.panel || p.panel === "bar" || p.panel === "spaces") {
      cx.spawn(async (cx) => {
        for (;;) {
          const c = await nextCommand();
          this.command(c, cx);
          cx.notify();
        }
      });
    }
    // Lines written while the space had no Shepherd: the bar sends them once it's up.
    if (p.panel === "bar") cx.timer.every(2000, (cx) => this.flushQueue(cx));
    // Panels with a Start Shepherd action ask whether it can start here: now and on the 5 s tick
    // below (never from render), so a space switch shows the answer within a tick.
    if (["tabs", "bar", "history"].includes(p.panel)) cx.spawn(async (cx) => this.askStartable(cx));
    if (p.panel === "status") {
      cx.timer.every(LOAD_MS, (cx) => this.readLoad(cx));
      this.readLoad(cx);
    }
    // Time in stage changes by the minute; the 5 s tick also reloads remote repos and
    // retries a watch that failed (no tasks.json yet).
    cx.timer.every(60000, (cx) => cx.notify());
    cx.timer.every(REFRESH_MS, (cx) => {
      this.sync(cx);
      if (["tabs", "bar", "history"].includes(props()?.panel)) this.askStartable(cx);
      if (props()?.panel === "detail") { const task = this.selectedTask(); if (task) this.ensureGit(task, cx); }
    });
    this.sync(cx);
  }

  async close() {
    const p = props() ?? {};
    if (isToast(p)) { untrackToast(p.overlay); return; }
    if (p.panel === "digest" && shared(DIGEST_OPEN) === p.overlay) setShared(DIGEST_OPEN, null);
    if (p.panel === "history" && shared(HISTORY_OPEN) === p.overlay) setShared(HISTORY_OPEN, null);
    if (p.panel === "steer" && shared(STEER_OPEN) === p.overlay) setShared(STEER_OPEN, null);
    closePeek(this);
    stopTerm(this);
  }

  // ---- where things are ----------------------------------------------------------------

  /** The space this copy is about: a steer menu's or terminal window's (props.space), the open
   *  task's in the detail while All spaces is on, else the shown one (Herdr's focused space, the
   *  last one selected: the bar's lines go there in All spaces too). */
  space() {
    const p = props() ?? {};
    const ctx = p.space && ["steer", "term", "termfoot"].includes(p.panel) ? p.space
      : p.panel === "detail" && shared(SCOPE) === "all" ? parseRef(String(shared(SELECTED) ?? "").slice(5)).sid : null;
    return (ctx && this.spaceById(ctx)) || this.shownSpace();
  }

  shownSpace() {
    const id = focused()?.space;
    return spaces().find((s) => s.id === id) ?? spaces().find((s) => s.active) ?? null;
  }

  spaceById(id) { return id ? spaces().find((s) => s.id === id) ?? null : null; }

  /** A task's, question's or chat line's space (marked `_sid` when read), else this copy's. */
  spaceOf(x) { return x?._sid ? this.spaceById(x._sid) : this.space(); }

  /** All spaces is on and this copy shows every space (the board, Needs you, bar, tab bar, History, digest). */
  isAll() {
    const p = props() ?? {};
    return shared(SCOPE) === "all" && (!p.panel || ALL_PANELS.includes(p.panel));
  }

  /** The spaces this copy shows: every space with a Shepherd plus the shown one (All spaces), else this copy's one. */
  scopeSpaces(all = terminals()) {
    if (!this.isAll()) { const s = this.space(); return s ? [s] : []; }
    const shown = this.shownSpace();
    return spaces().filter((s) => s.id === shown?.id || this.shepherd(s, all));
  }

  /** The repos of scopeSpaces, each once. */
  scopeRepos(all = terminals()) {
    const seen = new Map();
    for (const s of this.scopeSpaces(all)) { const r = this.repo(s, all); if (r && !seen.has(r.key)) seen.set(r.key, r); }
    return [...seen.values()];
  }

  shepherd(space = this.space(), all = terminals()) {
    if (!space) return null;
    return all.find((x) => x.state === "live" && x.labels?.["herdr.role"] === "shepherd"
      && x.labels?.["herdr.space"] === localId(space) && machineOf(x) === (space.machine ?? null)) ?? null;
  }

  /** Where the space's tasks live: { machine, dir, key, workflow }, or null. */
  /** The folder a space works in: its own, else (a space Herdr lists without one, as remote spaces
   *  can be) where its panes are now (`panes()[i].cwd`, what Herdr itself goes by), else its live
   *  terminals' folders; the most common one, leaving out task worktrees. */
  spaceDir(space, all = terminals()) {
    if (!space) return null;
    if (space.folder) return space.folder;
    const skip = (d) => !d || /\/\.local\/share\/|\/worktrees\//.test(d);
    const most = (dirs) => {
      const n = {};
      for (const d of dirs) if (!skip(d)) n[d] = (n[d] ?? 0) + 1;
      return Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    };
    const tabs = new Set((space.tabs ?? []).map((t) => t.id));
    return most(panes().filter((p) => p.terminal && tabs.has(p.tab)).map((p) => p.cwd))
      ?? most(all.filter((x) => x.state === "live" && x.labels?.["herdr.space"] === localId(space)
        && machineOf(x) === (space.machine ?? null)).map((x) => x.cwd));
  }

  repo(space = this.space(), all = undefined) {
    if (!space) return null;
    const sh = this.shepherd(space, all);
    const dir = sh?.labels?.["shepherd.dir"] || this.spaceDir(space, all ?? terminals());
    const machine = space.machine ?? null;
    return dir ? { machine, dir, key: `${machine ?? ""}:${dir}`, workflow: sh?.labels?.["shepherd.workflow"] ?? null } : null;
  }

  /** What this copy shows: one space's data, or in All spaces every scope space's merged (tasks,
   *  questions and chat lines each marked with their space; the shown space's settings). */
  state() {
    if (!this.isAll()) return this.spaceState(this.space());
    const all = terminals();
    const parts = this.scopeSpaces(all).map((s) => this.spaceState(s, all));
    const shown = this.spaceState(this.shownSpace(), all);
    const err = parts.find((x) => x.error);
    return {
      tasks: parts.flatMap((x) => x.tasks), questions: parts.flatMap((x) => x.questions), chat: parts.flatMap((x) => x.chat),
      alerts: shown.alerts, settings: shown.settings,
      error: err ? `${this.spaceById(err.sid)?.name ?? err.sid}: ${err.error}` : null,
    };
  }

  /** One space's data, marked with the space (tagged). */
  spaceState(space, all = undefined) {
    const repo = space ? this.repo(space, all) : null;
    return tagged((repo && this.data[repo.key]) ?? EMPTY, space?.id ?? null);
  }

  error() { return this.state().error ?? null; }

  /** What a view's header calls what it shows: "all spaces", else the space's name. */
  scopeName() { return this.isAll() ? "all spaces" : this.space()?.name ?? "—"; }

  /** The workflow settings in force for a space, the shown one by default (defaults until loaded). */
  settings(space = this.space()) {
    return this.spaceState(space).settings ?? { maxLoops: MAX_LOOPS, limits: LIMITS, stuckMinutes: STUCK_MIN, stages: {} };
  }

  // ---- loading ---------------------------------------------------------------------------

  /** Loads what this copy shows: the shown space's repo every tick (on another machine through the
   *  shared read, so the copies make one between them), and in All spaces every other Shepherd
   *  space's: here once and then on its folder watch, on another machine every REMOTE_MS. */
  sync(cx) {
    const all = terminals();
    const shown = this.repo(this.space(), all);
    const repos = this.isAll() ? this.scopeRepos(all) : shown ? [shown] : [];
    for (const repo of repos) {
      const isShown = repo.key === shown?.key;
      // A watched folder here reloads on change: the tick only reloads the shown space's (as before).
      if (!isShown && !repo.machine && this.watching.has(repo.key) && repo.key in this.data) continue;
      const maxAge = !repo.machine ? 0 : isShown ? REMOTE_FRESH_MS : REMOTE_MS;
      // Each load gets its own cx: a timer's cx is only good during its callback.
      cx.spawn(async (cx) => { await this.load(repo, maxAge); this.alert(repo); cx.notify(); });
      this.watch(repo, cx);
    }
  }

  watch(repo, cx) {
    if (repo.machine || this.watching.has(repo.key)) return;
    this.watching.add(repo.key);
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          await watchFolder(`${repo.dir}/.herdr`);
          await this.load(repo);
          this.alert(repo);
          cx.notify();
        }
      } catch {
        this.watching.delete(repo.key); // no .herdr yet: the tick retries
      }
    });
  }

  /** Render's check: a repo this copy shows but hasn't read yet (a space switch, All spaces turned
   *  on, a new Shepherd) is loaded now rather than on the next tick. */
  ensureLoaded(cx) {
    const missing = this.scopeRepos().filter((r) => !(r.key in this.data));
    if (!missing.length) return;
    for (const r of missing) this.data[r.key] = { tasks: [], questions: [], alerts: {} };
    this.sync(cx);
  }

  /** The files load() needs, as read: { s: tasks.json, chat, wf, orch } or { error, wf, orch }. Never throws. */
  async readRepo(repo) {
    const out = { s: {}, chat: null, wf: {}, orch: {} };
    try {
      out.s = (await this.readJson(`${repo.dir}/${TASKS}`, repo.machine)) ?? {};
      out.chat = await readTextFile(`${repo.dir}/${CHAT}`, { on: repo.machine }).catch(() => null);
    } catch (e) {
      out.error = `tasks.json: ${e.message ?? e}`;
    }
    // Settings: the person's workflow, then the space's orchestra.json on top. Here that's the one
    // workflow.json Workflow settings writes (ui.js readWorkflow); on another machine, workflow.json
    // beside the file Shepherd's label names there, else that file.
    try {
      if (!repo.machine) out.wf = (await readWorkflow(this)).wf;
      else if (repo.workflow) {
        const mine = repo.workflow.replace(/workflow\.example\.json$/, "workflow.json");
        out.wf = (await this.readJson(mine, repo.machine)) ?? (await this.readJson(repo.workflow, repo.machine)) ?? {};
      }
    } catch { /* defaults */ }
    try { out.orch = (await this.readJson(`${repo.dir}/.herdr/orchestra.json`, repo.machine)) ?? {}; } catch { /* defaults */ }
    return out;
  }

  async readJson(path, machine) {
    const text = await readTextFile(path, { on: machine }).catch(() => null);
    if (text == null) return null;
    return JSON.parse(text);
  }

  /** Reads a repo's tasks.json, chat and settings. `maxAge`: on another machine, a read another copy
   *  made less than this long ago is used instead (sharedRead). */
  async load(repo, maxAge = 0) {
    const prev = this.data[repo.key] ?? { tasks: [], questions: [], alerts: {} };
    const raw = repo.machine ? await sharedRead(repo.key, maxAge, () => this.readRepo(repo)) : await this.readRepo(repo);
    let next;
    if (raw.error) {
      // Keep the last good state; shep writes atomically, so this is a hand edit gone wrong.
      next = { ...prev, error: raw.error };
    } else {
      next = { tasks: raw.s.tasks ?? [], questions: raw.s.questions ?? [] };
      // The chat (History): JSON lines; a half-written last line is skipped until it's whole.
      next.chat = (raw.chat ?? "").split("\n").slice(-CHAT_MAX).flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } });
      this.prunePending(next.chat);
    }
    const { wf, orch } = raw;
    const alerts = { toast: true, sound: true, phone: false, ntfy: "", ...wf.alerts, ...orch.alerts };
    const settings = {
      maxLoops: orch.maxLoops ?? wf.maxLoops ?? MAX_LOOPS,
      limits: { ...LIMITS, ...wf.limits, ...orch.limits },
      stuckMinutes: { ...STUCK_MIN, ...wf.stuckMinutes, ...orch.stuckMinutes },
      // Per stage, the space's keys win over the person's (a space may set only its CI command).
      stages: Object.fromEntries([...new Set([...Object.keys(wf.stages ?? {}), ...Object.keys(orch.stages ?? {})])]
        .map((k) => [k, { ...wf.stages?.[k], ...orch.stages?.[k] }])),
    };
    this.data[repo.key] = { ...next, alerts, settings, wf, orch };
    // Answers tasks.json has recorded are no longer pending.
    const pending = shared(PENDING) ?? [];
    const open = new Set(next.questions.filter((q) => q.answer == null).map((q) => pendingId(repo.key, q.id)));
    const still = pending.filter((k) => !k.startsWith(pendingId(repo.key, "")) || open.has(k));
    if (still.length !== pending.length) setShared(PENDING, still);
  }

  // ---- questions -------------------------------------------------------------------------

  /** Per questions array (one per load), worked out once: each grilling question's number in its
   *  task's grilling (file order: shep only appends) and each task's answers as [asked, answered] ms. */
  questionIndex(questions = this.state().questions ?? []) {
    const memo = QINDEX.get(questions);
    if (memo) return memo;
    const grillNo = new Map(), answers = new Map(), count = new Map();
    for (const q of questions) {
      if (q.kind === "grill") { const n = (count.get(q.task) ?? 0) + 1; count.set(q.task, n); grillNo.set(q.id, n); }
      if (q.answered) {
        if (!answers.has(q.task)) answers.set(q.task, []);
        answers.get(q.task).push([Date.parse(q.asked) || 0, Date.parse(q.answered) || 0]);
      }
    }
    const idx = { grillNo, answers };
    QINDEX.set(questions, idx);
    return idx;
  }

  /** Open questions of the spaces this copy shows, oldest first, each with its task as taskObj and
   *  `key` "<space id>/<question id>" (ids repeat across spaces). */
  questions() {
    const all = terminals();
    const pending = new Set(shared(PENDING) ?? []);
    const out = [];
    for (const space of this.scopeSpaces(all)) {
      const repo = this.repo(space, all);
      if (!repo) continue;
      const { tasks, questions } = this.spaceState(space, all);
      const { grillNo } = this.questionIndex(questions);
      for (const q of questions) {
        if (q.answer != null || pending.has(pendingId(repo.key, q.id))) continue;
        out.push({ ...q, key: refOf(space.id, q.id), taskObj: tasks.find((x) => x.id === q.task) ?? null,
          // A grilling question's number in its task's grilling (they come one at a time, no limit).
          grillNo: grillNo.get(q.id) ?? null });
      }
    }
    return out.sort((a, b) => (Date.parse(a.asked) || 0) - (Date.parse(b.asked) || 0));
  }

  /** The open questions of one task (in its own space: ids repeat across spaces). */
  questionsOf(task) {
    return task ? this.questions().filter((q) => q.task === task.id && (q._sid ?? null) === (task._sid ?? null)) : [];
  }

  questionById(key) { return key ? this.questions().find((q) => q.key === key) ?? null : null; }

  /** The reply field for a question (by its key); questions keep their slot while open. */
  replyInput(key) {
    let slot = this.slots.find((s) => s.q === key);
    if (!slot) {
      const open = new Set(this.questions().map((q) => q.key));
      slot = this.slots.find((s) => !s.q || !open.has(s.q));
      if (!slot) return null;
      slot.q = key;
      slot.input.set_value("");
    }
    return slot.input;
  }

  /** `space`: the question's own (read from it), or one named (a toast). */
  answer(q, text, space = this.spaceOf(q)) {
    const answer = String(text ?? "").trim();
    const repo = this.repo(space);
    if (!answer || !repo) return;
    // A grilling question goes straight to its griller (it waits on "<ref> answer: …"), so it can go
    // on while Shepherd, told it was sent, only records it: one AI turn less per question.
    const asker = String(q.from ?? "").split(" ")[0];
    const direct = q.kind === "grill" && q.ref && /^t[0-9a-z]+$/.test(asker) && this.shepherd(space) && !this.queued(space).length
      && terminals().some((x) => x.state === "live" && x.address === (space.machine ? `${space.machine}/${asker}` : asker));
    const line = direct ? `answer ${q.id}: ${answer} (sent to ${asker})` : `answer ${q.id}: ${answer}`;
    // Only a sent answer is pending; a queued one shows as open until it goes.
    if (this.tell(line, q.task ?? null, space) !== "sent") return;
    if (direct) hc(["send", space.machine ? `${space.machine}/${asker}` : asker, `${q.ref} answer: ${answer}`]);
    const id = pendingId(repo.key, q.id);
    setShared(PENDING, [...(shared(PENDING) ?? []), id]);
    setShared(ANSWERED, [...(shared(ANSWERED) ?? []), id].slice(-200));
    setShared(SENT_TEXT, { ...Object.fromEntries(Object.entries(shared(SENT_TEXT) ?? {}).slice(-50)), [id]: answer });
  }

  /** The answer sent from here for a question tasks.json hasn't recorded yet, else null. */
  sentAnswer(q, space = this.spaceOf(q)) {
    const repo = this.repo(space);
    if (!repo || q.answer != null || !(shared(PENDING) ?? []).includes(pendingId(repo.key, q.id))) return null;
    return (shared(SENT_TEXT) ?? {})[pendingId(repo.key, q.id)] ?? "…";
  }

  /** A message from the bar: plain text to Shepherd. */
  say(text) {
    const line = String(text ?? "").trim();
    if (line && this.tell(line)) this.barInput.set_value("");
  }

  /** The Overview's field: `re <id>: <text>` to Shepherd about the task the field's text is for. */
  askAbout(cx) {
    const id = this.askTask;
    const text = String(this.askInput.value() ?? "").trim();
    if (!id || !text) return;
    const line = `re ${id}: ${text}`;
    const told = this.tell(line, id);
    if (!told) return;
    if (told === "queued") { this.askInput.set_value(""); delete this.askDrafts[id]; cx.notify(); return; } // shown from QUEUED
    // Shown at once; chat.jsonl's copy replaces it (prunePending), or it's marked when recording failed.
    const p = { at: new Date().toISOString(), from: "you", text: line, task: id, pending: true };
    this.askPending.push(p);
    this.lastRecord?.then((err) => { if (err) { p.failed = err; cx.notify(); } });
    this.askInput.set_value("");
    delete this.askDrafts[id];
    cx.notify();
  }

  /** The field's text belongs to one task: opening another keeps it as a draft and shows that one's.
   *  Called outside render (render only notices the switch and spawns this). */
  askFor(id) {
    if (!this.askInput || this.askTask === id) return;
    if (this.askTask) this.askDrafts[this.askTask] = this.askInput.value();
    this.askTask = id;
    this.askFocused = false; // a hidden or switched field may never send blur
    this.askInput.set_value(id ? this.askDrafts[id] ?? "" : "");
  }

  /** Drops lines sent here once chat.jsonl holds them (a line with that text and task, written at or
   *  after the send, give or take 5 s of clock skew); a line not seen within a minute goes too,
   *  unless recording it failed, which stays shown as failed. */
  prunePending(chat) {
    if (!this.askPending?.length) return;
    this.askPending = this.askPending.filter((p) => {
      const sent = Date.parse(p.at);
      if (chat.some((c) => c.from === "you" && c.task === p.task && c.text === p.text && Date.parse(c.at) >= sent - 5000)) return false;
      return p.failed || Date.now() - sent < 60000;
    });
  }

  /** chat.jsonl's lines about a task, plus what this copy sent that the file doesn't hold yet. */
  taskChat(id) {
    return [...(this.state().chat ?? []).filter((c) => c.task === id), ...(this.askPending ?? []).filter((p) => p.task === id),
      ...this.queuedChat().filter((c) => c.task === id)];
  }

  /** A space's queued lines as chat lines (`queued`: shown as waiting for Shepherd); with no space
   *  named, those of every space this copy shows. */
  queuedChat(space = null) {
    if (!space) return this.scopeSpaces().flatMap((s) => this.queuedChat(s));
    return this.queued(space).map((x) => ({ at: x.at, from: "you", text: x.line, task: x.task ?? null, queued: true, _sid: space.id }));
  }


  /** Toast, sound and phone push for each new question. Only the bar alerts, so it happens once. */
  alert(repo) {
    if (props()?.panel !== "bar") return;
    const d = this.data[repo.key];
    if (!d) return;
    const seen = new Set(shared(ALERTED) ?? []);
    const now = Date.now();
    const fresh = (d.questions ?? []).filter((q) => q.answer == null && !seen.has(pendingId(repo.key, q.id)));
    if (!fresh.length) return;
    setShared(ALERTED, [...seen, ...fresh.map((q) => pendingId(repo.key, q.id))].slice(-500));
    const news = fresh.filter((q) => now - (Date.parse(q.asked) || 0) < ALERT_WINDOW_MS);
    if (!news.length) return;
    const a = d.alerts ?? {};
    // The space this repo belongs to, not the shown one: a watch started for an earlier space keeps
    // loading its repo after a switch. No such space: no toast (sound and push still go).
    const space = spaces().find((s) => this.repo(s)?.key === repo.key) ?? null;
    const sound = a.sound !== false, phone = Boolean(a.phone && a.ntfy);
    for (const [i, q] of news.entries()) {
      const title = `${q.task} needs you`;
      // Only the newest TOAST_MAX get a toast; the toast mod (toast.js) reads the question from args.
      if (a.toast !== false && space && i >= news.length - TOAST_MAX) {
        const rec = q.kind === "grill" ? null : recAnswer(q); // the design gives grilling questions no button
        trackToast(notify({
          title, body: q.text, level: "warning", timeout: TOAST_MS,
          action: { name: `shepherd.needs:${space.id}`, args: { shepherd: { space: space.id, key: repo.key, q: q.id, task: q.task ?? null, rec, sound, phone } } },
        }));
      }
      if (a.phone && a.ntfy) {
        fetch(`https://ntfy.sh/${encodeURIComponent(a.ntfy)}`, {
          method: "POST", body: q.text, headers: { Title: title, Tags: "sheep" },
        }).catch(() => {});
      }
    }
    if (a.sound !== false) playSound("blocked");
  }

  // ---- cards -----------------------------------------------------------------------------

  /** What a task's card needs from its own space, worked out once per space (spaceCtx). */
  spaceCtx(space, all = terminals()) {
    const st = this.spaceState(space, all);
    return {
      space, tasks: st.tasks, settings: this.settings(space),
      doneIds: new Set(st.tasks.filter((x) => x.stage === "done").map((x) => x.id)),
      answers: this.questionIndex(st.questions).answers,
      // The space's name on its cards while every space shows (ids repeat across spaces).
      tag: this.isAll() ? space?.name ?? null : null,
    };
  }

  /** A card from a task in tasks.json. Its live agent's status wins over the file's. `ctx`: its
   *  space's (spaceCtx). */
  taskCard(task, byAddress, asked, ctx = this.spaceCtx(this.spaceOf(task))) {
    // tasks.json names the agent as its own machine knows it (t1r5); here a remote one is macmini/t1r5.
    const address = termAddress(this, task);
    const term = address ? byAddress.get(address) : null;
    const live = term && term.state === "live" ? term.status : null;
    let status = TASK_STATUS[task.status] ?? "idle";
    if (task.status === "working" && (live === "blocked" || live === "working")) status = live;
    if (asked) status = "blocked";
    const runs = task.history ?? [];
    const last = runs[runs.length - 1];
    const cur = [...runs].reverse().find((r) => r.stage === task.stage);
    const since = Date.parse(cur?.start ?? "") || Date.now();
    // Blockers still to finish (in the task's own space); done ones no longer hold the task.
    const { tasks, doneIds } = ctx;
    const blockers = (task.blockedBy ?? []).filter((b) => b && !doneIds.has(b));
    // Tickets still to finish that wait on this one: "blocks T-5" on its card.
    const blocks = tasks.filter((x) => x.stage !== "done" && (x.blockedBy ?? []).includes(task.id)).map((x) => x.id);
    // Stuck counts from the stage run's start or the person's last answer in it, whichever is later:
    // time waiting on the person isn't the agent being stuck.
    const answeredAt = Math.max(0, ...(ctx.answers.get(task.id) ?? [])
      .filter(([asked]) => asked >= since).map(([, answered]) => answered));
    const minutes = (Date.now() - Math.max(since, answeredAt)) / 60000;
    const limit = ctx.settings.stuckMinutes[task.stage];
    const stuck = task.status === "working" && !asked && limit != null && minutes > limit;
    const note = task.status === "parked" ? "parked"
      : task.status === "paused" ? "paused by you"
      : task.wait && task.status === "queued" ? task.wait
      : task.status === "queued" && blockers.length ? `blocked by ${blockers.join(", ")}`
      : task.status === "queued" && task.stage === "tickets" ? "ready-for-agent"
      : (last?.note || (term?.report ?? "") || task.status);
    return {
      address,
      live: term?.state === "live",
      key: `task-${task._ref ?? task.id}`,
      ref: task._ref ?? task.id,
      id: task.id,
      sid: task._sid ?? null,
      spaceTag: ctx.tag,
      title: task.title ?? task.id,
      stage: STAGES[task.stage] ? task.stage : "spec",
      // The run's own skill (Spec: /wayfinder for a big one), else the workflow's for the stage
      // (Grill: /grill-me when picked); none for CI, Proof, Ready to merge and Done.
      skill: cur?.skill ?? this.skillOf(task.stage, ctx.settings),
      loop: Math.max(1, task.loop ?? 1),
      maxLoops: Math.max(1, task.maxLoops ?? MAX_LOOPS),
      status,
      note,
      since,
      after: blockers,
      blocks,
      asked,
      stuck,
      stuckText: stuck ? `stuck · over ${mins(limit)} in ${STAGES[task.stage]?.title ?? task.stage}` : null,
      paused: task.status === "paused",
      task,
    };
  }

  /** The workflow's skill for a stage where it names one (Grill: /grill-me when picked), else the default. */
  skillOf(stage, settings = this.settings()) { return settings.stages?.[stage]?.skill ?? STAGES[stage]?.skill ?? ""; }

  /** Where a task is now, for the detail's stage chip and the timeline's last total: done, queued,
   *  parked, waiting on you (a question, or its agent on a prompt), stuck, paused, or working; with
   *  how long it's been in its stage. A stage with no run of its own (Ready to merge) counts from
   *  the last run's end. Builds only this task's card. */
  taskNow(task) {
    const address = termAddress(this, task);
    const x = address ? terminals().find((y) => y.address === address) : null;
    const asked = this.questionsOf(task).length > 0;
    const card = this.taskCard(task, new Map(x ? [[address, x]] : []), asked);
    const stage = STAGES[task.stage]?.title ?? task.stage;
    const runs = task.history ?? [];
    const since = runs.some((r) => r.stage === task.stage) ? card.since : Date.parse(runs[runs.length - 1]?.end ?? "") || null;
    const inStage = since ? `${mins((Date.now() - since) / 60000)} in ${stage}` : stage;
    if (task.stage === "done") return { kind: "done", text: "done" };
    if (task.status === "queued") return { kind: "queued", text: "queued" };
    if (task.status === "parked") return { kind: "parked", text: "parked" };
    if (asked || task.status === "blocked" || card.status === "blocked") return { kind: "waiting", text: `waiting on you · ${inStage}` };
    if (card.stuck) return { kind: "stuck", text: `stuck · ${inStage}` };
    if (task.status === "paused") return { kind: "paused", text: `paused · ${inStage}` };
    return { kind: "working", text: inStage };
  }

  /** Cards: the tasks of the spaces this copy shows, then terminals with a shepherd.stage label
   *  that no task claims, in those spaces (or with no space at all). */
  cards() {
    const all = terminals();
    const scope = this.scopeSpaces(all);
    const askedTasks = new Set(this.questions().map((q) => refOf(q._sid, q.task)));
    const byAddress = new Map(all.map((x) => [x.address, x]));
    const claimed = new Map(); // space id -> its task ids
    const now = Date.now();
    const seen = new Set();
    const out = [];
    for (const space of scope) {
      const ctx = this.spaceCtx(space, all);
      claimed.set(space.id, new Set(ctx.tasks.map((t) => t.id)));
      for (const t of ctx.tasks) out.push(this.taskCard(t, byAddress, askedTasks.has(t._ref), ctx));
    }
    for (const x of all) {
      const l = x.labels ?? {};
      const stage = l["shepherd.stage"];
      if (!STAGES[stage] || l["herdr.role"] === "shepherd") continue;
      if (x.state === "finished" && stage !== "done") continue;
      const sp = l["herdr.space"];
      const space = sp ? scope.find((s) => sp === localId(s) && machineOf(x) === (s.machine ?? null)) : null;
      if (sp && !space) continue;
      if ((space ? [claimed.get(space.id)] : [...claimed.values()]).some((ids) => ids?.has(l["shepherd.task"]))) continue;
      seen.add(x.address);
      const prev = this.since[x.address];
      if (!prev || prev.stage !== stage) this.since[x.address] = { stage, since: prev ? now : (x.created_ms ?? now) };
      out.push({
        address: x.address,
        live: x.state === "live",
        key: `term-${x.address}`,
        id: l["shepherd.task"] ?? x.name ?? x.address,
        sid: space?.id ?? null,
        spaceTag: this.isAll() ? space?.name ?? null : null,
        title: l["shepherd.title"] ?? x.title ?? x.name ?? (x.argv ?? []).join(" "),
        stage,
        skill: this.skillOf(stage, this.settings(space ?? this.space())),
        loop: Math.max(1, parseInt(l["shepherd.loop"] ?? "1", 10) || 1),
        maxLoops: MAX_LOOPS,
        status: statusOf(x, stage),
        note: x.report ?? (x.argv ?? []).join(" "),
        since: this.since[x.address].since,
        after: [],
        asked: false,
        stuck: false,
      });
    }
    for (const a of Object.keys(this.since)) if (!seen.has(a)) delete this.since[a];
    return out.sort((a, b) => a.since - b.since);
  }

  /** The newest thing that happened, for the bar: a stage run's start or result ({task: "T-2",
   *  text: "code review fail · 1 finding", result: "fail"}), an open question ({…, text: "asks: …",
   *  result: "ask"}) or an answer ({…, text: "you answered: Merge", result: "done"}). The bar tints the task id by `result`, as the History does. */
  lastEvent() {
    let best = null;
    const take = (at, ev) => { if (!best || at > best.at) best = { at, ...ev }; };
    for (const task of this.state().tasks ?? []) {
      for (const r of task.history ?? []) {
        take(Date.parse(r.end ?? r.start ?? "") || 0,
          { task: task.id, sid: task._sid, result: r.result, text: `${STAGES[r.stage]?.title.toLowerCase() ?? r.stage} ${r.result}${r.note ? ` · ${r.note}` : ""}` });
      }
    }
    // A question is an event when asked (only while it's open) and when answered ("you answered: Merge", done green).
    for (const q of this.state().questions ?? []) {
      if (q.answer == null) take(Date.parse(q.asked ?? "") || 0, { task: q.task, sid: q._sid, result: "ask", text: `asks: ${q.text}` });
      else take(Date.parse(q.answered ?? q.asked ?? "") || 0, { task: q.task, sid: q._sid, result: "done", text: `you answered: ${q.answer}` });
    }
    return best;
  }

  // ---- spaces ----------------------------------------------------------------------------

  /** shepherd/start.sh for a space, on its machine, in the background (it starts Shepherd in its
   *  own tab): the one way every Start Shepherd (tab bar, + menu, bar, History, Space settings, New
   *  space, a toast, a message written with no Shepherd) starts one. Here the script is this mod's own
   *  checkout's, found through the mods/shepherd link; on another machine it's that machine's checkout,
   *  run with its login shell's PATH (checkStartable → shepherdOn; `known` is an answer already in
   *  hand). One start per space at a time across copies: shared STARTING, shown as "Starting…" from
   *  the click until the Shepherd shows in terminals() (pruneStarting), since start.sh's own check for
   *  a running Shepherd is check-then-act. A failure clears it and says why. Resolves when start.sh is done. */
  startShepherd(space, known = null) {
    if (!space || this.isStarting(space) || this.shepherd(space)) return Promise.resolve();
    const machine = space.machine ?? null;
    const fail = (body, action = null) => notify({ title: "Shepherd didn't start", body, level: "error", ...(action ? { action: { name: action } } : {}) });
    const dir = this.repo(space)?.dir;
    if (!dir) { fail(`${space.name} has no folder to start Shepherd in.`); return Promise.resolve(); }
    this.markStarting(space.id, true);
    return (async () => {
      const s = known?.dir ? known : await checkStartable(this, machine, true);
      if (!s.dir) {
        return s.missing && machine ? fail(`${machine}: ${s.reason}. Click to set up Shepherd on ${machine}.`, `shepherd.setup-shepherd:${space.id}`)
          : fail(`${machine ? `${machine}: ` : ""}${s.reason}. Click to try again.`, `shepherd.start-shepherd:${space.id}`);
      }
      const args = [`${s.dir}/start.sh`, "--space", localId(space), dir];
      const r = machine ? await execSafe("sh", ["-c", 'PATH="$1"; shift; exec sh "$@"', "start", s.path, ...args], { on: machine, timeout: 60000 })
        : await execSafe("sh", args, { timeout: 60000 });
      if (r.code !== 0) return fail(r.code === -1 ? failLine(r) : (r.stderr || r.stdout || `exit ${r.code}`).trim().split("\n").pop(), `shepherd.start-shepherd:${space.id}`);
      return true;
    })().catch((e) => fail(String(e?.message ?? e), `shepherd.start-shepherd:${space.id}`))
      .then((ok) => { if (ok !== true) this.markStarting(space.id, false); });
  }

  /** Sets or clears a space's shared "starting" mark. */
  markStarting(id, on) {
    const now = { ...(shared(STARTING) ?? {}) };
    if (on) now[id] = Date.now(); else delete now[id];
    setShared(STARTING, now);
  }

  /** Drops "starting" marks whose Shepherd now shows, or that are older than START_STALE_MS. The bar runs it. */
  pruneStarting() {
    const marks = shared(STARTING) ?? {};
    const all = terminals();
    const gone = Object.keys(marks).filter((id) => {
      const space = spaces().find((x) => x.id === id);
      return !space || this.shepherd(space, all) || Date.now() - marks[id] >= START_STALE_MS;
    });
    if (!gone.length) return;
    const now = { ...marks };
    for (const id of gone) delete now[id];
    setShared(STARTING, now);
  }

  /** Whether a start was asked for the space (from any copy) and its Shepherd hasn't shown yet. */
  isStarting(space) {
    const at = space ? (shared(STARTING) ?? {})[space.id] : null;
    return Boolean(at) && Date.now() - at < START_STALE_MS;
  }

  /** What a Start Shepherd action shows for a space, a pure read: "running" | "starting", else
   *  machineStartState's (checking, ok, missing, unreachable, no) with its reason. askStartable asks. */
  startState(space) {
    if (!space) return { state: "no", reason: "no space" };
    if (this.shepherd(space)) return { state: "running" };
    if (this.isStarting(space)) return { state: "starting" };
    return machineStartState(this, space.machine ?? null);
  }

  /** Asks whether Shepherd can start on the space's machine when it has none and the answer is
   *  stale. From timers and handlers only. */
  askStartable(cx, space = this.space()) {
    if (!space || this.shepherd(space) || !startStale(space.machine ?? null) || this.checkingStart?.[space.machine ?? ""]) return;
    const asked = checkStartable(this, space.machine ?? null); // marks the machine busy at once
    cx.notify();
    cx.spawn(async (cx) => { await asked; cx.notify(); });
  }

  /** Lines waiting for a space's Shepherd (QUEUED). */
  queued(space = this.space()) {
    return space ? (shared(QUEUED) ?? []).filter((x) => x.space === space.id) : [];
  }

  /** Throws away a space's waiting lines (the bar's Discard). */
  discardQueued(space = this.space()) {
    if (space) setShared(QUEUED, (shared(QUEUED) ?? []).filter((x) => x.space !== space.id));
  }

  /** Sends queued lines (oldest first) to each space's Shepherd once it's up and has finished its
   *  first turn: idle or done for QUEUE_IDLE_MS (a Shepherd asking for something in its tab, like
   *  Claude's folder trust, is blocked and waits), or QUEUE_FALLBACK_MS after it shows if it reports
   *  no status. Each line is claimed in QUEUED first (so another copy never sends it too), removed
   *  once sent and recorded in that space's chat. Lines older than QUEUE_MAX_MS, or whose space is
   *  gone, are dropped with a toast. The bar runs it every 2 s, with pruneStarting. */
  flushQueue(cx) {
    this.pruneStarting();
    const now = Date.now();
    this.copyId ??= Math.random().toString(36).slice(2);
    const mine = (x) => !x.sending || x.sending.by === this.copyId || now - x.sending.at >= QUEUE_CLAIM_MS;
    let q = shared(QUEUED) ?? [];
    if (!q.length || this.flushing) return;
    const drop = (lines, title, why) => {
      if (!lines.length) return;
      const ids = new Set(lines.map((x) => x.id));
      setShared(QUEUED, (shared(QUEUED) ?? []).filter((x) => !ids.has(x.id)));
      notify({ title, body: `${why}: ${lines.map((x) => x.line).join(" · ").slice(0, 160)}`, level: "warning" });
    };
    const alive = new Set(spaces().map((x) => x.id));
    drop(q.filter((x) => mine(x) && !alive.has(x.space)), "Message not sent", "Its space is gone");
    drop(q.filter((x) => mine(x) && alive.has(x.space) && now - (Date.parse(x.at) || now) > QUEUE_MAX_MS),
      "Message to Shepherd dropped", "No Shepherd took it within an hour");
    q = shared(QUEUED) ?? [];
    const all = terminals();
    const idle = (this.idleSince ??= {});
    const seen = (this.shepSeen ??= {});
    const ready = [];
    for (const id of new Set(q.map((x) => x.space))) {
      const space = spaces().find((x) => x.id === id);
      const sh = space && this.shepherd(space, all);
      if (!sh) continue;
      seen[sh.address] ??= now;
      if (["idle", "done"].includes(sh.status)) idle[sh.address] ??= now; else delete idle[sh.address];
      const go = (idle[sh.address] != null && now - idle[sh.address] >= QUEUE_IDLE_MS)
        || (sh.status == null && now - seen[sh.address] >= QUEUE_FALLBACK_MS);
      const lines = q.filter((x) => x.space === id);
      if (go && lines.every(mine)) ready.push({ space, sh, lines });
    }
    if (!ready.length) return;
    // Claim them before the first await: another copy's tick sees them as taken.
    const claimed = new Set(ready.flatMap((r) => r.lines.map((x) => x.id)));
    setShared(QUEUED, q.map((x) => (claimed.has(x.id) ? { ...x, sending: { by: this.copyId, at: now } } : x)));
    this.flushing = true;
    cx.spawn(async (cx) => {
      try {
        for (const { space, sh, lines } of ready) {
          for (const x of lines) {
            const r = await hc(["send", sh.address, x.line]).catch((e) => ({ code: -1, stderr: String(e?.message ?? e) }));
            if (r.code !== 0) {
              if (!this.queueFailed?.has(x.id)) {
                (this.queueFailed ??= new Set()).add(x.id);
                notify({ title: "Couldn't send to Shepherd yet", body: `${failLine(r)}. Trying again.`, level: "warning" });
              }
              break; // keep the order: the rest wait behind it (their claims lapse)
            }
            this.record("you", x.line, x.task, space);
            setShared(QUEUED, (shared(QUEUED) ?? []).filter((y) => y.id !== x.id));
          }
        }
        // Release what wasn't sent, so the next tick tries again at once.
        setShared(QUEUED, (shared(QUEUED) ?? []).map((x) => (x.sending?.by === this.copyId ? { ...x, sending: undefined } : x)));
      } finally { this.flushing = false; cx.notify(); }
    });
  }

  // ---- steering and overlays --------------------------------------------------------------

  /** A task by its ref ("<space id>/<id>", or a bare id in this copy's space). A ref to another
   *  space is found only while this copy shows it (All spaces, or the copy's own space). */
  taskById(ref) {
    if (!ref) return null;
    const { sid, id } = parseRef(ref);
    if (sid && !this.isAll() && sid !== this.space()?.id) return null;
    const space = sid ? this.spaceById(sid) : this.space();
    return space ? this.spaceState(space).tasks.find((x) => x.id === id) ?? null : null;
  }

  /** shep.mjs beside Shepherd's workflow file (its shepherd.workflow label), on the space's machine. */
  shepBin(name, space = this.space()) {
    const wf = this.repo(space)?.workflow;
    return wf ? `${wf.replace(/\/[^/]*$/, "")}/bin/${name}` : null;
  }

  /** Keeps a line of the chat (History): `shep say --from you|shepherd`, appended to chat.jsonl. */
  record(from, text, task = null, space = this.space()) {
    const repo = this.repo(space);
    const shep = this.shepBin("shep.mjs", space);
    // A promise of the error (null when kept), so a caller can show a line that wasn't kept.
    if (!repo || !shep) { this.lastRecord = Promise.resolve("no shep.mjs: Shepherd has no shepherd.workflow label"); return this.lastRecord; }
    const args = [shep, "--tasks", `${repo.dir}/${TASKS}`, "say", "--from", from, ...(task ? ["--task", task] : []), text];
    this.lastRecord = exec("node", args, { on: repo.machine, timeout: 10000 })
      .then((r) => (r.code === 0 ? null : (r.stderr || r.stdout || `shep say exited ${r.code}`).trim()))
      .catch((e) => String(e?.message ?? e));
    return this.lastRecord;
  }

  /** A line to this space's Shepherd (CONVENTIONS.md "Talking to Shepherd"), kept in the chat.
   *  "sent"; or "queued" when it waits in QUEUED: there's no Shepherd (one is started, with a toast)
   *  or earlier lines still wait (it goes after them, never ahead); null for an empty line or no space. */
  tell(line, task = null, space = this.space()) {
    const text = String(line ?? "").trim();
    if (!text || !space) return null;
    const sh = this.shepherd(space);
    if (sh && !this.queued(space).length) {
      hc(["send", sh.address, text]);
      this.record("you", text, task, space);
      return "sent";
    }
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    setShared(QUEUED, [...(shared(QUEUED) ?? []), { id, space: space.id, line: text, task, at: new Date().toISOString() }]);
    if (sh) return "queued";
    const waits = waitsText(this.queued(space).length);
    const st = this.startState(space);
    if (st.state === "missing" || st.state === "no") {
      notify({ title: "No Shepherd in this space", body: `${waits} for one (an hour at most). Can't start here: ${st.reason}.${st.state === "missing" ? ` Click to set up Shepherd on ${space.machine}.` : ""}`,
        level: "warning", ...(st.state === "missing" ? { action: { name: `shepherd.setup-shepherd:${space.id}` } } : {}) });
    } else {
      notify({ title: `Starting Shepherd in ${space.name}`, body: `${waits}: it goes to Shepherd once it's up.`, level: "info" });
      this.startShepherd(space, st.known ?? null);
    }
    return "queued";
  }

  togglePause(task) {
    if (!task || !["working", "paused"].includes(task.status)) return;
    this.tell(`${task.status === "paused" ? "resume" : "pause"} ${task.id}`, task.id, this.spaceOf(task));
  }

  /** Ask for status: Shepherd answers with `say --task`, in the History, so show it. */
  askStatus(task) {
    if (task && this.tell(`status ${task.id}?`, task.id, this.spaceOf(task))) this.toggleHistory(true);
  }

  /** Opens a task in the detail pane by its ref (task._ref, card.ref). */
  openTask(ref) {
    setShared(SELECTED, `task-${ref}`);
    run("layout.show", { id: "detail" });
  }

  /** The steer menu (⋯ or right-click: at the pointer; S or a key command: near the board's top
   *  left, since the pointer may be anywhere). */
  openSteer(ref, atPointer = true) {
    const space = parseRef(ref).sid ?? this.space()?.id ?? null;
    openOverlay({ mod: "shepherd", kind: "popup", width: 290, height: 244, props: { panel: "steer", task: ref, space },
      ...(atPointer ? {} : { at: { x: 420, y: 120 } }) });
  }

  /** An agent's real terminal in a window: a title bar to drag it by, the terminal, a footer.
   *  `name`: what the footer calls a terminal that's neither Shepherd nor a task's (a tab's name). */
  openTerminal(address, taskRef, name = null) {
    if (!address) return;
    // A bare address (as tasks.json writes it) is on the task's space's machine.
    const sid = taskRef ? parseRef(taskRef).sid : null;
    const space = (sid && this.spaceById(sid)) || this.space();
    const machine = space?.machine ?? null;
    if (machine && !String(address).includes("/")) address = `${machine}/${address}`;
    const bar = (panel, px) => ({ type: "block", size: { px }, content: { mod: "shepherd", props: { panel, terminal: address, task: taskRef, name, space: space?.id ?? null } } });
    openOverlay({
      kind: "window", key: TERM_WINDOW, width: 900, height: 640,
      layout: { type: "column", children: [bar("term", 40), { type: "block", content: { terminal: address } }, bar("termfoot", 30)] },
    });
  }

  /** D and ⌘J toggle: an open overlay copy keeps its id in shared state until close(). */
  toggleOverlay(key, spec, open) {
    const id = shared(key);
    if (id && open !== true) { closeOverlay(id); setShared(key, null); return; }
    if (!id && open !== false) openOverlay(spec);
  }

  toggleDigest(open) {
    this.toggleOverlay(DIGEST_OPEN, { mod: "shepherd", kind: "dialog", width: 720, height: 480, props: { panel: "digest" } }, open);
  }

  toggleHistory(open) {
    this.toggleOverlay(HISTORY_OPEN, { mod: "shepherd", kind: "dialog", width: 760, height: 0.85, props: { panel: "history" } }, open);
  }

  sendSteer() {
    const text = (this.steerInputs[this.steerMode]?.value() ?? "").trim();
    const id = props()?.task ? parseRef(props().task).id : null; // a ref: the line names the bare id
    if (!text || !id || !this.steerMode) return;
    if (this.tell(`steer ${id} ${this.steerMode}: ${text}`, id)) closeOverlay(props().overlay);
  }

  /** The machine's CPU and memory, for the status bar: shepherd/bin/load.sh where the space lives.
   *  Kept per repo, so a space switch never shows the last machine's numbers. */
  readLoad(cx) {
    const repo = this.repo();
    const script = this.shepBin("load.sh");
    if (!repo || !script) return;
    cx.spawn(async (cx) => {
      const r = await exec("sh", [script], { on: repo.machine, timeout: 10000 }).catch(() => null);
      const m = r?.code === 0 ? r.stdout.match(/cpu (\d+) mem (\d+)/) : null;
      this.machineLoad = m ? { key: repo.key, cpu: Number(m[1]), mem: Number(m[2]) } : null;
      cx.notify();
    });
  }

  // ---- keys ------------------------------------------------------------------------------

  /** Cards the status filters let through (shared FILTERS; the board and Pipeline). */
  filtered(cards) {
    const f = shared(FILTERS) ?? [];
    return f.length ? cards.filter((c) => f.includes(c.status)) : cards;
  }

  /** Cards in keyboard order: the board's column order, or the pipeline's rows, as filtered. Other views: none. */
  keyOrder() {
    const cards = this.filtered(this.cards().filter((c) => c.task));
    const view = this.view();
    if (view === "pipeline") return this.pipelineOrder(cards).map((c) => c.key);
    if (view === "board") return ORDER.flatMap((s) => cards.filter((c) => c.stage === s)).map((c) => c.key);
    return [];
  }

  pipelineOrder(cards) {
    const rank = (c) => (c.status === "blocked" ? 0 : c.status === "working" ? 1 : c.status === "done" ? 3 : 2);
    return [...cards].sort((a, b) => rank(a) - rank(b) || ORDER.indexOf(b.stage) - ORDER.indexOf(a.stage));
  }

  /** The task keys act on: the keyboard focus, else the open one. S / T / ↵ prefer a peeked card (boardKey). */
  keyTask() {
    const key = this.kf ?? shared(SELECTED);
    return typeof key === "string" && key.startsWith("task-") ? this.taskById(key.slice(5)) : null;
  }

  /** J/K: the keyboard focus moves; an open task follows it. */
  moveFocus(step) {
    const ord = this.keyOrder();
    if (!ord.length) return false;
    const sel = shared(SELECTED);
    let i = ord.indexOf(this.kf ?? sel);
    i = i < 0 ? 0 : Math.max(0, Math.min(ord.length - 1, i + step));
    this.kf = ord[i];
    if (typeof sel === "string") setShared(SELECTED, ord[i]);
    return true;
  }

  /** 1–6: the open task's tabs. */
  detailTab(k) {
    const tab = TABS[Number(k) - 1];
    if (!tab || typeof shared(SELECTED) !== "string") return false;
    setShared(TAB, tab);
    return true;
  }

  /** A: the recommended answer (Merge, Approve, a grilling question's) of the task's open question; nothing without one. */
  accept(task) {
    const q = this.questionsOf(task).find((x) => recAnswer(x));
    if (q) this.answer(q, recAnswer(q));
  }

  /** Needs you, in another space when `spaceId` names one (a toast's Open). */
  openNeeds(spaceId = null) {
    if (spaceId && spaceId !== this.space()?.id && spaces().some((s) => s.id === spaceId)) run("space.select", { id: spaceId });
    setShared(VIEW, "needs");
  }

  /** shepherd.answer:<json {space, q, task, text}> from a toast. The board copy answers, not the toast's:
   *  the toast closes at once, and a Shepherd it would start (no Shepherd up) needs a copy that stays. */
  answerFromToast(arg) {
    let a;
    try { a = JSON.parse(arg); } catch { return; }
    const space = spaces().find((s) => s.id === a?.space);
    if (space && a.q && a.text) this.answer({ id: a.q, task: a.task ?? null }, a.text, space);
  }

  /** R (and shepherd.reply): Needs you, with the keyboard in the oldest question's reply field. */
  replyNext(cx) {
    this.openNeeds();
    const q = this.questions()[0];
    const input = q ? this.replyInput(q.key) : null;
    if (input) cx.spawn(async () => { input.focus(); });
  }

  /** C: the bar takes the keyboard with "add " typed (design focusChat). */
  focusBar() { run("shepherd.focus-bar"); }

  /** A key command (keys.json `shepherd.<command>`, delivered to every shown copy): digest, history,
   *  focus, focus-bar, steer, terminal, pause, open, view:<v>, scope[:all|space], tab:<1-5>, next, prev. The board copy
   *  acts on all but focus-bar, which only the bar copy takes. Task commands act on the keyboard
   *  focus, else the open task; `:<id>` names one. */
  command(c, cx) {
    // Only the first ":" splits: an answer's JSON (shepherd.answer) has colons of its own.
    const str = String(c), at = str.indexOf(":");
    const [name, arg] = at < 0 ? [str, undefined] : [str.slice(0, at), str.slice(at + 1)];
    const panel = props()?.panel;
    if (panel === "spaces") {
      if (name === "new-folder") startNewFolder(this, cx);
      return;
    }
    if (panel === "bar") {
      if (name === "focus-bar") { this.barInput.set_value("add "); this.barInput.focus(); }
      return;
    }
    if (panel) return;
    // The spaces copy takes "new-folder"; the board re-sending it here would loop, since every
    // copy gets every command (the board's own F key calls overlayCommand directly).
    if (name === "new-folder") return;
    if (this.overlayCommand(name, arg)) return;
    const task = arg ? this.taskById(arg) : this.keyTask();
    if (name === "focus") this.keys.focus(); // pane.go, or a popup over the board closed
    else if (name === "digest") this.toggleDigest();
    else if (name === "history") this.toggleHistory();
    else if (name === "view" && VIEWS.includes(arg)) setShared(VIEW, arg);
    else if (name === "scope") setScope(arg === "all" || (arg !== "space" && shared(SCOPE) !== "all")); // all | space | toggle
    else if (name === "needs") this.openNeeds(arg || null);
    else if (name === "answer") this.answerFromToast(arg);
    else if (name === "reply") this.replyNext(cx);
    else if (name === "tab") this.detailTab(arg);
    else if (name === "next" || name === "prev") this.moveFocus(name === "next" ? 1 : -1);
    else if (!task) return;
    else if (name === "open") this.openTask(task._ref);
    else if (name === "steer") this.openSteer(task._ref, false);
    else if (name === "terminal") this.openTerminal(task.terminal, task._ref);
    else if (name === "pause") this.togglePause(task);
  }

  /** Commands that open the sidebar's overlays, from keys.json or the board's N, F, W, U.
   *  True when `name` was one of them. */
  overlayCommand(name, arg) {
    const act = {
      "new-space": () => openNewSpace(arg || null),
      "new-folder": () => { run("layout.show", { id: "sidebar" }); run("shepherd.new-folder"); },
      workflow: () => openWorkflow(),
      usage: () => openUsage(),
      "add-machine": () => openAddMachine(),
      machine: () => openMachine(arg || null),
      "start-shepherd": () => {
        const s = arg ? spaceByArg(arg) : this.space();
        if (s) this.startShepherd(s);
      },
      "setup-shepherd": () => {
        const s = arg ? spaceByArg(arg) : this.space();
        if (s?.machine) openSetup(s.machine, s.id);
      },
      "space-settings": () => {
        const s = arg ? spaceByArg(arg) : this.space();
        if (s) openSpaceSettings(s.id);
      },
    }[name];
    if (!act) return false;
    act();
    return true;
  }

  /** Board keys (RECIPE "Keys"). Plain letters, only while the board holds the keyboard. */
  boardKey(e, cx) {
    if (e.modifiers?.control || e.modifiers?.alt || e.modifiers?.platform) return;
    const k = e.key.toLowerCase();
    const done = () => { cx.stop_propagation(); cx.notify(); };
    if (this.gAt && Date.now() - this.gAt < 1200) {
      this.gAt = 0;
      const v = { b: "board", p: "pipeline", d: "deps", n: "needs" }[k];
      if (v) { setShared(VIEW, v); done(); }
      return;
    }
    const sel = shared(SELECTED);
    if (["1", "2", "3", "4", "5", "6"].includes(k)) { if (this.detailTab(k)) done(); return; }
    // The peek's footer names S / T / ↵: those act on the peeked card and close the peek; j/k and Esc
    // close it too (the keyboard moved on). P, A and key commands keep to the keyboard focus.
    const peeked = peekedKey(this);
    if (["j", "k", "down", "up", "enter", "escape", "s", "t"].includes(k)) closePeek(this);
    if (k === "j" || k === "k" || k === "down" || k === "up") { if (this.moveFocus(k === "j" || k === "down" ? 1 : -1)) done(); return; }
    const enterKey = peeked ?? this.kf;
    if (k === "enter" && enterKey?.startsWith("task-")) { this.openTask(enterKey.slice(5)); done(); return; }
    if (k === "escape") {
      if (typeof sel === "string") { setShared(SELECTED, null); run("layout.hide", { id: "detail" }); } else this.kf = null;
      done();
      return;
    }
    if (k === "g") { this.gAt = Date.now(); done(); return; }
    if (k === "d") { this.toggleDigest(); done(); return; }
    if (k === "c") { this.focusBar(); done(); return; }
    if (k === "r") { this.replyNext(cx); done(); return; }
    const key = { n: "new-space", f: "new-folder", w: "workflow", u: "usage" }[k];
    if (key && this.overlayCommand(key)) { done(); return; }
    const task = (k === "s" || k === "t") && peeked ? this.taskById(peeked.slice(5)) : this.keyTask();
    if (!task) return;
    if (k === "s") this.openSteer(task._ref, false);
    else if (k === "p") this.togglePause(task);
    else if (k === "t") this.openTerminal(task.terminal, task._ref);
    else if (k === "a") this.accept(task);
    else return;
    done();
  }

  /** The steer menu's Redirect… / Add context…: that mode's empty field, with the keyboard. */
  steerField(mode, cx) {
    this.steerMode = mode;
    this.steerInputs[mode].set_value("");
    this.steerInputs[mode].focus();
    cx.notify();
  }

  /** Steer menu keys: P (stays open, as in the design) R C S T ↵. Esc is Herdr's: it closes the popup. */
  steerKey(e, cx) {
    if (this.steerMode) return; // typing in the field
    const task = this.taskById(props()?.task);
    if (!task) return;
    const k = e.key.toLowerCase();
    const close = () => closeOverlay(props().overlay);
    if (k === "p") this.togglePause(task);
    else if (k === "r" || k === "c") this.steerField(k === "r" ? "redirect" : "context", cx);
    else if (k === "s") { close(); this.askStatus(task); }
    else if (k === "t") { close(); this.openTerminal(task.terminal, task._ref); }
    else if (k === "enter") { close(); this.openTask(task._ref); }
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  /** The terminal window's title bar holds the keyboard when the window opens: S steers, Esc closes.
   *  Clicking into the terminal hands it the keyboard (Herdr has no read-only terminal block), and
   *  Esc then goes to the agent; clicking the title bar or footer takes it back. */
  termKey(e, cx) {
    const p = props() ?? {};
    const k = e.key.toLowerCase();
    if (k === "escape") closeTermWindow(p.overlay);
    else if (k === "s" && p.task) this.openSteer(p.task, false);
    else return;
    cx.stop_propagation();
  }

  // ---- task detail ---------------------------------------------------------------------

  selectedTask() {
    // props.task opens a task without a click (a layout or overlay can pin one).
    const key = shared(SELECTED) ?? (props()?.task ? `task-${props().task}` : null);
    return typeof key === "string" && key.startsWith("task-") ? this.taskById(key.slice(5)) : null;
  }

  tint(c, a) { return tint(c, a); }

  entry(task) {
    const k = `${this.repo()?.key}#${task.id}`;
    return (this.gitCache[k] ??= { git: null, diffs: {}, files: {}, ui: { changesFile: null, open: new Set(), file: null }, loading: new Set() });
  }

  git(task) { return this.entry(task).git; }
  pr(task) { return this.entry(task).pr ?? null; }
  proof(task) { return this.entry(task).proof ?? null; }
  diff(task, f) { return this.entry(task).diffs[f.path] ?? null; }
  file(task, path) { return this.entry(task).files[path] ?? null; }
  ui(task) { return this.entry(task).ui; }

  /** A finding's file:line chip: Changes at that file when the task changed it, else Files at it
   *  (its folders opened). */
  openFileAt(task, path, inChanges = true) {
    const ui = this.ui(task);
    if (inChanges && this.git(task)?.files?.some((f) => f.path === path)) {
      ui.changesFile = path;
      setShared(TAB, "changes");
      return;
    }
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) ui.open.add(parts.slice(0, i).join("/"));
    ui.file = path;
    if (currentTab() !== "files") setShared(TAB, "files");
  }

  /** Starts whatever reads the shown tab needs and doesn't have yet: git for Changes and Files
   *  (and a local merge's diff size), gh for the PR card, proof.json for Proof. */
  ensureGit(task, cx) {
    const dir = worktreeOf(task);
    const tab = TABS.includes(shared(TAB)) ? shared(TAB) : "overview";
    const repo = this.repo();
    const e = this.entry(task);
    const on = repo?.machine ?? null;
    const once = (key, work) => {
      if (e.loading.has(key)) return;
      e.loading.add(key);
      cx.spawn(async (cx) => { try { await work(); } finally { e.loading.delete(key); } cx.notify(); });
    };
    const stale = (x, ms) => !x || Date.now() - (x.at ?? 0) > ms;
    if (repo && tab === "proof" && stale(e.proof, PROOF_STALE_MS)) once("proof", async () => { e.proof = await loadProof(repo, task); });
    const prCard = tab === "overview" && task.stage === "merge";
    if (repo && prCard && task.pr && stale(e.pr, PR_STALE_MS)) once("pr", async () => { e.pr = await loadPr(repo, task); });
    // Changes and Files read git; the other tabs too in a space on this computer (Changes' count on
    // the tab bar) and for a local merge's PR card, but not over ssh just for a count. No worktree
    // (Done: it was removed): no git.
    const gitTab = tab === "changes" || tab === "files";
    if (!dir || !(gitTab || !on || (prCard && !task.pr))) return;
    const gitStale = gitTab ? GIT_STALE_MS : GIT_COUNT_STALE_MS;
    if (!e.git || Date.now() - (e.git.at ?? 0) > gitStale) {
      once("git", async () => {
        const g = await loadGit(dir, on);
        // Fresh contents: drop cached diffs and files so they reload.
        if (e.git && g.at) { e.diffs = {}; e.files = {}; }
        e.git = g;
      });
    }
    const g = e.git;
    if (!g || g.error) return;
    if (tab === "changes" && g.files.length) {
      const sel = g.files.find((f) => f.path === e.ui.changesFile) ?? g.files[0];
      if (e.diffs[sel.path] == null) once(`diff:${sel.path}`, async () => { e.diffs[sel.path] = await loadDiff(dir, on, g.base, sel); });
    }
    // Files opens on the first changed file, its folders open, as the design does.
    if (tab === "files" && !e.ui.file && !e.ui.picked) {
      const first = g.files.find((f) => f.status !== "D");
      e.ui.picked = true;
      if (first) this.openFileAt(task, first.path, false);
    }
    if (tab === "files" && e.ui.file && !e.files[e.ui.file]) {
      const path = e.ui.file;
      once(`file:${path}`, async () => { e.files[path] = await loadFile(dir, on, g.base, path); });
    }
  }

  // ---- views -----------------------------------------------------------------------------

  view() {
    const v = shared(VIEW) ?? props()?.view ?? "board";
    return VIEWS.includes(v) ? v : "board";
  }

  /** The 32px pane header every view shares: title and subtitle; add filters after it.
   *  The view switch lives in the tab bar (panel "tabs"). */
  header(title, sub) {
    const t = palette();
    return h_flex().h(32).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().text_color(t.foreground).child(title))
      .child(div().text_color(t.dim).child(sub))
      .when(Boolean(this.error()), (el) => el.child(div().truncate().text_color(t.ansi1).child(this.error())))
      .child(div().flex_1());
  }

  render(cx) {
    const p = props() ?? {};
    if (isToast(p)) return renderToast(this);
    // A space switch or All spaces shows another repo: load it now rather than on the next tick.
    this.ensureLoaded(cx);
    if (p.panel === "status") return this.renderStatus();
    if (p.panel === "spaces") return renderSidebar(this);
    if (p.panel === "plus") return renderPlus();
    if (p.panel === "setup") return renderSetup(this);
    if (p.panel === "newtab") return renderNewTab(this);
    if (p.panel === "closetab") return renderCloseTab();
    if (p.panel === "machine") return renderMachinePop(this);
    if (p.panel === "usage") return renderUsagePop();
    if (p.panel === "addmachine") return renderAddMachine(this);
    if (p.panel === "newspace") return renderNewSpace(this, folders());
    if (p.panel === "workflow") return renderWorkflow(this);
    if (p.panel === "spacesettings") return renderSpaceSettings(this);
    if (p.panel === "tabs") return renderTabBar(this);
    if (p.panel === "steer") return renderSteer(this).track_focus(this.keys).on_key_down((e, cx) => this.steerKey(e, cx));
    if (p.panel === "term") return renderTermBar(this).track_focus(this.keys).on_key_down((e, cx) => this.termKey(e, cx));
    if (p.panel === "termfoot") return renderTermFoot(this).track_focus(this.keys)
      .on_mouse_down("left", () => this.keys.focus()).on_key_down((e, cx) => this.termKey(e, cx));
    if (p.panel === "digest") return renderDigest(this);
    if (p.panel === "history") return renderHistory(this);
    if (p.panel === "bar") return renderBar(this);
    if (p.panel === "detail") {
      const task = this.selectedTask();
      if (task) this.ensureGit(task, cx);
      // The Ask field follows the open task; its value is switched outside render.
      // The task's body starts at once, still inside render, where cx.notify() is refused: let the
      // foreground executor run it after this frame (cx.sleep), then switch and redraw.
      if ((task?.id ?? null) !== this.askTask) cx.spawn(async (cx) => { await cx.sleep(0); this.askFor(this.selectedTask()?.id ?? null); cx.notify(); });
      // The Terminal tab reads the agent's screen only while it's shown (term.js).
      syncTerm(this, task, cx);
      // 1–6 switch tabs while the detail pane holds the keyboard (the board handles them too), never
      // while typing in the Ask field, a question's reply field or the Terminal tab's field: their keys
      // bubble up here. A click in any of them stops there (detail.js, term.js), so this one doesn't take the keyboard from it.
      return renderDetail(this).track_focus(this.keys)
        .on_mouse_down("left", () => this.keys.focus())
        .on_key_down((e, cx) => {
          if (this.askFocused || this.termTab?.focused || this.slots.some((s) => s.focused)) return;
          if (!e.modifiers?.platform && !e.modifiers?.control && this.detailTab(e.key)) cx.stop_propagation();
        });
    }
    const view = this.view();
    // Needs you has reply fields: no board keys there, so typing a reply never steers a task.
    if (view === "needs") return renderNeeds(this);
    if (view !== "board" && this.peek) closePeek(this); // only the board's cards peek
    const body = view === "pipeline" ? renderPipeline(this) : view === "deps" ? renderDeps(this) : renderBoard(this);
    // Clicking anywhere on the board gives it the keyboard.
    return body.track_focus(this.keys)
      .on_mouse_down("left", () => this.keys.focus())
      .on_key_down((e, cx) => this.boardKey(e, cx));
  }

  renderStatus() {
    const t = palette();
    const s = this.settings();
    const space = this.space();
    const model = (stage) => s.stages?.[stage]?.model ?? null;
    const lim = s.limits;
    const l = this.machineLoad?.key === this.repo()?.key ? this.machineLoad : null;
    const gauge = (name, now, max) => div().text_color(now != null && now >= max ? t.ansi1 : t.dim)
      .child(now != null ? `${name} ${now}% ≤ ${max}%` : `${name} ≤ ${max}%`);
    return h_flex().id("shepherd-status").size_full().px(12).gap(14).items_center().bg(t.chrome)
      .border_t(1).border_color(t.border)
      .font_family("JetBrains Mono").text_size(11).text_color(t.dim)
      .child(`herdr-core · ${space?.machine ?? "local"}`)
      .when(Boolean(model("implement")), (el) => el.child(`implement ${model("implement")}`))
      .when(Boolean(model("review")), (el) => el.child(`review ${model("review")}`))
      .child(`max loops ${s.maxLoops}`)
      .child(gauge("cpu", l?.cpu, lim.maxCpu))
      .child(gauge("mem", l?.mem, lim.maxMem))
      .child(div().flex_1())
      .child("mods/shepherd");
  }
}
