// Shepherd: one mod, several roles. props.view picks the main view (board, pipeline, deps, needs;
// the person's switch in shared "shepherd.view" wins), props.panel a side role (tabs, detail,
// status, bar) or an overlay (steer, term, termfoot, digest).
// Everything reads the shown space's <repo>/.herdr/shepherd/tasks.json, written by Shepherd
// through shepherd/bin/shep.mjs. The repo is the `shepherd.dir` label on the space's Shepherd
// terminal, else the space's folder. Answers and messages go to Shepherd with `hc send`.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState } from "gpui-base";
import {
  props, terminals, spaces, focused, theme, shared, setShared, readTextFile, watchFolder,
  hc, notify, playSound, exec, run, openOverlay, closeOverlay, nextCommand,
} from "herdr";
import { TASKS, MAX_LOOPS, STAGES, ORDER, STUCK_MIN, LIMITS, localId, machineOf, palette } from "./common.js";
import { renderBoard } from "./board.js";
import { renderNeeds } from "./needs.js";
import { renderBar } from "./bar.js";
import { renderDetail, tint, TAB, TABS } from "./detail.js";
import { loadGit, loadDiff, loadFile, worktreeOf } from "./git.js";
import { loadPr, loadProof } from "./ship.js";
import { renderTabBar } from "./tabbar.js";
import { renderPipeline, renderDeps } from "./views.js";
import { renderSteer, renderTermBar, renderTermFoot } from "./steer.js";
import { renderDigest } from "./digest.js";

const REFRESH_MS = 5000;
const VIEW = "shepherd.view";
const PENDING = "shepherd.pending"; // question ids answered here that tasks.json hasn't caught up with
const ALERTED = "shepherd.alerted"; // "<repo key>#<question id>" already alerted
const ALERT_WINDOW_MS = 15 * 60000; // older questions found on first sight are not news
const REPLY_SLOTS = 12; // InputStates can't be made in render: a fixed pool for Needs you cards
const GIT_STALE_MS = 10000; // Changes and Files reload this often while shown
const PR_STALE_MS = 30000; // gh pr view, for the PR card's checks
const PROOF_STALE_MS = 15000;
const LOAD_MS = 15000; // the status bar's machine load
const SELECTED = "shepherd.selected";
const FOCUS_BAR = "shepherd.focusBar"; // C: the board asks the bar to take the keyboard
export const VIEWS = ["board", "pipeline", "deps", "needs"];

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
    this.since = {}; // address -> { stage, since }: label-only cards' time in stage
    this.data = {}; // repo key -> { tasks, questions, alerts, error? }
    this.watching = new Set();
    this.gitCache = {}; // "<repo key>#<task id>" -> { git, diffs: {path: text}, files: {path: {text, added}}, ui, loading }
    this.slots = Array.from({ length: REPLY_SLOTS }, () => ({ q: null, input: InputState.new({ placeholder: "Or write your own answer…" }) }));
    for (const s of this.slots) s.input.on("submit", () => { const q = this.questionById(s.q); if (q) this.answer(q, s.input.value()); });
    const p = props() ?? {};
    if (p.panel === "bar") {
      this.barInput = InputState.new({ placeholder: "Tell Shepherd what to build, or ask about any task…" });
      this.barInput.on("submit", () => this.say(this.barInput.value()));
      this.barFocusSeen = shared(FOCUS_BAR) ?? 0;
    }
    if (p.panel === "steer") {
      this.steerMode = null; // null: the menu; "redirect" | "context": the text field
      this.steerInput = InputState.new({ placeholder: "" });
      this.steerInput.on("submit", () => this.sendSteer());
    }
    // The board and the steer menu take keys (J/K, S, P, T, …): only while they hold the keyboard,
    // so typing in the bar or a terminal never triggers them.
    if (!p.panel || p.panel === "steer" || p.panel === "detail") {
      this.keys = cx.focus_handle();
      if (!p.panel || p.panel === "steer") cx.spawn(async () => { this.keys.focus(); });
    }
    // Key commands from keys.json ("shepherd.digest", "shepherd.view:pipeline", …): the board copy acts.
    if (!p.panel) {
      cx.spawn(async (cx) => {
        for (;;) {
          const c = await nextCommand();
          this.command(c);
          cx.notify();
        }
      });
    }
    if (p.panel === "status") {
      cx.timer.every(LOAD_MS, (cx) => this.readLoad(cx));
      this.readLoad(cx);
    }
    // Time in stage changes by the minute; the 5 s tick also reloads remote repos and
    // retries a watch that failed (no tasks.json yet).
    cx.timer.every(60000, (cx) => cx.notify());
    cx.timer.every(REFRESH_MS, (cx) => {
      this.sync(cx);
      if (props()?.panel === "detail") { const task = this.selectedTask(); if (task) this.ensureGit(task, cx); }
    });
    this.sync(cx);
  }

  // ---- where things are ----------------------------------------------------------------

  space() {
    const id = focused()?.space;
    return spaces().find((s) => s.id === id) ?? spaces().find((s) => s.active) ?? null;
  }

  shepherd(space = this.space()) {
    if (!space) return null;
    return terminals().find((x) => x.state === "live" && x.labels?.["herdr.role"] === "shepherd"
      && x.labels?.["herdr.space"] === localId(space) && machineOf(x) === (space.machine ?? null)) ?? null;
  }

  /** Where the space's tasks live: { machine, dir, key, workflow }, or null. */
  repo(space = this.space()) {
    if (!space) return null;
    const sh = this.shepherd(space);
    const dir = sh?.labels?.["shepherd.dir"] ?? space.folder ?? null;
    const machine = space.machine ?? null;
    return dir ? { machine, dir, key: `${machine ?? ""}:${dir}`, workflow: sh?.labels?.["shepherd.workflow"] ?? null } : null;
  }

  state() {
    const repo = this.repo();
    return (repo && this.data[repo.key]) ?? { tasks: [], questions: [], alerts: {} };
  }

  error() { return this.state().error ?? null; }

  /** The workflow settings in force for the shown space (defaults until loaded). */
  settings() {
    return this.state().settings ?? { maxLoops: MAX_LOOPS, limits: LIMITS, stuckMinutes: STUCK_MIN, stages: {} };
  }

  // ---- loading ---------------------------------------------------------------------------

  sync(cx) {
    const repo = this.repo();
    if (!repo) return;
    // Each load gets its own cx: a timer's cx is only good during its callback.
    cx.spawn(async (cx) => { await this.load(repo); this.alert(repo); cx.notify(); });
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

  async readJson(path, machine) {
    const text = await readTextFile(path, { on: machine }).catch(() => null);
    if (text == null) return null;
    return JSON.parse(text);
  }

  async load(repo) {
    const prev = this.data[repo.key] ?? { tasks: [], questions: [], alerts: {} };
    let next;
    try {
      const s = (await this.readJson(`${repo.dir}/${TASKS}`, repo.machine)) ?? {};
      next = { tasks: s.tasks ?? [], questions: s.questions ?? [] };
    } catch (e) {
      // Keep the last good state; shep writes atomically, so this is a hand edit gone wrong.
      next = { ...prev, error: `tasks.json: ${e.message ?? e}` };
    }
    // Settings: the person's workflow (Shepherd's label), then the space's orchestra.json on top.
    let wf = {}, orch = {};
    try { if (repo.workflow) wf = (await this.readJson(repo.workflow, repo.machine)) ?? {}; } catch { /* defaults */ }
    try { orch = (await this.readJson(`${repo.dir}/.herdr/orchestra.json`, repo.machine)) ?? {}; } catch { /* defaults */ }
    const alerts = { toast: true, sound: true, phone: false, ntfy: "", ...wf.alerts, ...orch.alerts };
    const settings = {
      maxLoops: orch.maxLoops ?? wf.maxLoops ?? MAX_LOOPS,
      limits: { ...LIMITS, ...wf.limits, ...orch.limits },
      stuckMinutes: { ...STUCK_MIN, ...wf.stuckMinutes, ...orch.stuckMinutes },
      // Per stage, the space's keys win over the person's (a space may set only its CI command).
      stages: Object.fromEntries([...new Set([...Object.keys(wf.stages ?? {}), ...Object.keys(orch.stages ?? {})])]
        .map((k) => [k, { ...wf.stages?.[k], ...orch.stages?.[k] }])),
    };
    this.data[repo.key] = { ...next, alerts, settings };
    // Answers tasks.json has recorded are no longer pending.
    const pending = shared(PENDING) ?? [];
    const open = new Set(next.questions.filter((q) => q.answer == null).map((q) => `${repo.key}#${q.id}`));
    const still = pending.filter((k) => !k.startsWith(`${repo.key}#`) || open.has(k));
    if (still.length !== pending.length) setShared(PENDING, still);
  }

  // ---- questions -------------------------------------------------------------------------

  /** Open questions of the shown space, oldest first, each with its task as taskObj. */
  questions() {
    const repo = this.repo();
    if (!repo) return [];
    const { tasks, questions } = this.state();
    const pending = new Set(shared(PENDING) ?? []);
    return (questions ?? [])
      .filter((q) => q.answer == null && !pending.has(`${repo.key}#${q.id}`))
      .map((q) => ({ ...q, taskObj: tasks.find((x) => x.id === q.task) ?? null }))
      .sort((a, b) => (Date.parse(a.asked) || 0) - (Date.parse(b.asked) || 0));
  }

  questionById(id) { return id ? this.questions().find((q) => q.id === id) ?? null : null; }

  /** The reply field for a question; questions keep their slot while open. */
  replyInput(qid) {
    let slot = this.slots.find((s) => s.q === qid);
    if (!slot) {
      const open = new Set(this.questions().map((q) => q.id));
      slot = this.slots.find((s) => !s.q || !open.has(s.q));
      if (!slot) return null;
      slot.q = qid;
      slot.input.set_value("");
    }
    return slot.input;
  }

  answer(q, text) {
    const answer = String(text ?? "").trim();
    const sh = this.shepherd();
    const repo = this.repo();
    if (!answer || !sh || !repo) return;
    hc(["send", sh.address, `answer ${q.id}: ${answer}`]);
    setShared(PENDING, [...(shared(PENDING) ?? []), `${repo.key}#${q.id}`]);
  }

  /** The picked option for grilling question i: the person's pick, else the recommended one. */
  grillPick(qid, i, g) { return this.grillPicks?.[qid]?.[i] ?? g.recommended ?? g.options[0]; }
  setGrillPick(qid, i, o) { ((this.grillPicks ??= {})[qid] ??= {})[i] = o; }

  sendRound(q) {
    const line = q.questions.map((g, i) => `${i + 1}. ${this.grillPick(q.id, i, g)}`).join(" ");
    const sh = this.shepherd();
    const repo = this.repo();
    if (!sh || !repo) return;
    hc(["send", sh.address, `round ${q.id}: ${line}`]);
    setShared(PENDING, [...(shared(PENDING) ?? []), `${repo.key}#${q.id}`]);
  }

  /** A message from the bar: plain text to Shepherd. */
  say(text) {
    const line = String(text ?? "").trim();
    const sh = this.shepherd();
    if (!line || !sh) return;
    hc(["send", sh.address, line]);
    this.barInput.set_value("");
  }

  /** Toast, sound and phone push for each new question. Only the bar alerts, so it happens once. */
  alert(repo) {
    if (props()?.panel !== "bar") return;
    const d = this.data[repo.key];
    if (!d) return;
    const seen = new Set(shared(ALERTED) ?? []);
    const now = Date.now();
    const fresh = (d.questions ?? []).filter((q) => q.answer == null && !seen.has(`${repo.key}#${q.id}`));
    if (!fresh.length) return;
    setShared(ALERTED, [...seen, ...fresh.map((q) => `${repo.key}#${q.id}`)].slice(-500));
    const news = fresh.filter((q) => now - (Date.parse(q.asked) || 0) < ALERT_WINDOW_MS);
    if (!news.length) return;
    const a = d.alerts ?? {};
    for (const q of news) {
      const title = `${q.task} needs you`;
      if (a.toast !== false) {
        notify({ title, body: q.text, level: "warning", action: { name: "layout.switch", args: { name: "shepherd" } } });
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

  /** A card from a task in tasks.json. Its live agent's status wins over the file's. */
  taskCard(task, byAddress, asked) {
    const term = task.terminal ? byAddress.get(task.terminal) : null;
    const live = term && term.state === "live" ? term.status : null;
    let status = TASK_STATUS[task.status] ?? "idle";
    if (task.status === "working" && (live === "blocked" || live === "working")) status = live;
    if (asked) status = "blocked";
    const runs = task.history ?? [];
    const last = runs[runs.length - 1];
    const cur = [...runs].reverse().find((r) => r.stage === task.stage);
    const since = Date.parse(cur?.start ?? "") || Date.now();
    // Blockers still to finish; done ones no longer hold the task.
    const doneIds = new Set((this.state().tasks ?? []).filter((x) => x.stage === "done").map((x) => x.id));
    const blockers = (task.blockedBy ?? []).filter((b) => b && !doneIds.has(b));
    const minutes = (Date.now() - since) / 60000;
    const limit = this.settings().stuckMinutes[task.stage];
    const stuck = task.status === "working" && !asked && limit != null && minutes > limit;
    const note = task.status === "parked" ? "parked"
      : task.status === "paused" ? "paused by you"
      : task.wait && task.status === "queued" ? task.wait
      : task.status === "queued" && blockers.length ? `blocked by ${blockers.join(", ")}`
      : task.status === "queued" && task.stage === "tickets" ? "ready-for-agent"
      : (last?.note || (term?.report ?? "") || task.status);
    return {
      address: task.terminal ?? null,
      key: `task-${task.id}`,
      id: task.id,
      title: task.title ?? task.id,
      stage: STAGES[task.stage] ? task.stage : "spec",
      loop: Math.max(1, task.loop ?? 1),
      maxLoops: Math.max(1, task.maxLoops ?? MAX_LOOPS),
      status,
      note,
      since,
      after: blockers,
      asked,
      stuck,
      stuckText: stuck ? `stuck · over ${limit}m in ${STAGES[task.stage]?.title ?? task.stage}` : null,
      paused: task.status === "paused",
      task,
    };
  }

  /** Cards: the space's tasks, then terminals with a shepherd.stage label that no task claims,
   *  in the shown space (or with no space at all). */
  cards() {
    const space = this.space();
    const tasks = this.state().tasks ?? [];
    const askedTasks = new Set(this.questions().map((q) => q.task));
    const all = terminals();
    const byAddress = new Map(all.map((x) => [x.address, x]));
    const claimed = new Set(tasks.map((t) => t.id));
    const now = Date.now();
    const seen = new Set();
    const out = tasks.map((t) => this.taskCard(t, byAddress, askedTasks.has(t.id)));
    for (const x of all) {
      const l = x.labels ?? {};
      const stage = l["shepherd.stage"];
      if (!STAGES[stage] || l["herdr.role"] === "shepherd") continue;
      if (claimed.has(l["shepherd.task"])) continue;
      if (x.state === "finished" && stage !== "done") continue;
      const sp = l["herdr.space"];
      if (sp && (sp !== localId(space) || machineOf(x) !== (space?.machine ?? null))) continue;
      seen.add(x.address);
      const prev = this.since[x.address];
      if (!prev || prev.stage !== stage) this.since[x.address] = { stage, since: prev ? now : (x.created_ms ?? now) };
      out.push({
        address: x.address,
        key: `term-${x.address}`,
        id: l["shepherd.task"] ?? x.name ?? x.address,
        title: l["shepherd.title"] ?? x.title ?? x.name ?? (x.argv ?? []).join(" "),
        stage,
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

  /** The newest thing that happened, for the bar: "T-2 review fail · 1 finding". */
  lastEvent() {
    let best = null;
    for (const task of this.state().tasks ?? []) {
      for (const r of task.history ?? []) {
        const at = Date.parse(r.end ?? r.start ?? "") || 0;
        if (!best || at > best.at) best = { at, text: `${task.id} ${STAGES[r.stage]?.title.toLowerCase() ?? r.stage} ${r.result}${r.note ? ` · ${r.note}` : ""}` };
      }
    }
    return best?.text ?? null;
  }

  // ---- steering and overlays --------------------------------------------------------------

  /** A line to this space's Shepherd (CONVENTIONS.md "Talking to Shepherd"). */
  tell(line) {
    const sh = this.shepherd();
    if (!sh) { notify({ title: "No Shepherd in this space", body: "Start one with shepherd/start.sh.", level: "warning" }); return false; }
    hc(["send", sh.address, line]);
    return true;
  }

  togglePause(task) {
    if (!task || !["working", "paused"].includes(task.status)) return;
    this.tell(`${task.status === "paused" ? "resume" : "pause"} ${task.id}`);
  }

  /** Ask for status: Shepherd answers in its own output, so show its terminal. */
  askStatus(task) {
    if (!task || !this.tell(`status ${task.id}?`)) return;
    const sh = this.shepherd();
    if (sh) this.openTerminal(sh.address, null);
  }

  openTask(id) {
    setShared(SELECTED, `task-${id}`);
    run("layout.show", { id: "detail" });
  }

  /** The steer menu (⋯ or right-click: at the pointer; S or a key command: near the board's top
   *  left, since the pointer may be anywhere). */
  openSteer(id, atPointer = true) {
    openOverlay({ mod: "shepherd", kind: "popup", width: 290, height: 244, props: { panel: "steer", task: id },
      ...(atPointer ? {} : { at: { x: 420, y: 120 } }) });
  }

  /** An agent's real terminal in a window: a title bar to drag it by, the terminal, a footer. */
  openTerminal(address, taskId) {
    if (!address) return;
    const bar = (panel, px) => ({ type: "block", size: { px }, content: { mod: "shepherd", props: { panel, terminal: address, task: taskId } } });
    openOverlay({
      kind: "window", key: "shepherd-terminal", width: 900, height: 640,
      layout: { type: "column", children: [bar("term", 40), { type: "block", content: { terminal: address } }, bar("termfoot", 30)] },
    });
  }

  openDigest() {
    openOverlay({ mod: "shepherd", kind: "dialog", width: 720, height: 480, props: { panel: "digest" } });
  }

  sendSteer() {
    const text = this.steerInput.value().trim();
    const id = props()?.task;
    if (!text || !id || !this.steerMode) return;
    if (this.tell(`steer ${id} ${this.steerMode}: ${text}`)) closeOverlay(props().overlay);
  }

  /** The machine's CPU and memory, for the status bar: shepherd/bin/load.sh where the space lives. */
  readLoad(cx) {
    const repo = this.repo();
    if (!repo?.workflow) { this.load = null; return; }
    const script = `${repo.workflow.replace(/\/[^/]*$/, "")}/bin/load.sh`;
    cx.spawn(async (cx) => {
      const r = await exec("sh", [script], { on: repo.machine, timeout: 10000 }).catch(() => null);
      const m = r?.code === 0 ? r.stdout.match(/cpu (\d+) mem (\d+)/) : null;
      this.load = m ? { cpu: Number(m[1]), mem: Number(m[2]) } : null;
      cx.notify();
    });
  }

  // ---- keys ------------------------------------------------------------------------------

  /** Cards in keyboard order: the board's column order, or the pipeline's rows. */
  keyOrder() {
    const cards = this.cards().filter((c) => c.task);
    if (this.view() === "pipeline") return this.pipelineOrder(cards).map((c) => c.key);
    return ORDER.flatMap((s) => cards.filter((c) => c.stage === s)).map((c) => c.key);
  }

  pipelineOrder(cards) {
    const rank = (c) => (c.status === "blocked" ? 0 : c.status === "working" ? 1 : c.status === "done" ? 3 : 2);
    return [...cards].sort((a, b) => rank(a) - rank(b) || ORDER.indexOf(b.stage) - ORDER.indexOf(a.stage));
  }

  /** The task keys act on: the keyboard focus, else the open one. */
  keyTask() {
    const key = this.kf ?? shared(SELECTED);
    return typeof key === "string" ? (this.state().tasks ?? []).find((x) => `task-${x.id}` === key) ?? null : null;
  }

  /** A key command: digest, steer, terminal, pause, open, view:<board|pipeline|deps|needs>,
   *  tab:<1-5>, next, prev. Task commands act on the keyboard focus, else the open task. */
  command(c) {
    const [name, arg] = String(c).split(":");
    const task = this.keyTask();
    if (name === "digest") this.openDigest();
    else if (name === "view" && VIEWS.includes(arg)) setShared(VIEW, arg);
    else if (name === "tab" && TABS[Number(arg) - 1]) setShared(TAB, TABS[Number(arg) - 1]);
    else if (name === "next" || name === "prev") {
      const ord = this.keyOrder();
      if (!ord.length) return;
      let i = ord.indexOf(this.kf ?? shared(SELECTED));
      i = i < 0 ? 0 : Math.max(0, Math.min(ord.length - 1, i + (name === "next" ? 1 : -1)));
      this.kf = ord[i];
      if (typeof shared(SELECTED) === "string") setShared(SELECTED, ord[i]);
    } else if (name === "open" && (arg || this.kf)) this.openTask(arg ?? this.kf.slice(5));
    else if (!task && !arg) return;
    else if (name === "steer") this.openSteer(arg ?? task.id, false);
    else if (name === "terminal") { const x = arg ? (this.state().tasks ?? []).find((y) => y.id === arg) : task; if (x) this.openTerminal(x.terminal, x.id); }
    else if (name === "pause") this.togglePause(arg ? (this.state().tasks ?? []).find((y) => y.id === arg) : task);
  }

  /** Board keys (RECIPE "Keys"). Plain letters, only while the board holds the keyboard. */
  boardKey(e, cx) {
    if (e.modifiers?.control || e.modifiers?.alt || e.modifiers?.platform) return;
    const k = e.key.toLowerCase();
    const stop = () => cx.stop_propagation();
    if (this.gAt && Date.now() - this.gAt < 1200) {
      this.gAt = 0;
      const v = { b: "board", p: "pipeline", d: "deps", n: "needs" }[k];
      if (v) { setShared(VIEW, v); stop(); }
      return;
    }
    const sel = shared(SELECTED);
    const task = this.keyTask();
    if (["1", "2", "3", "4", "5"].includes(k) && typeof sel === "string") { setShared(TAB, TABS[Number(k) - 1]); stop(); return; }
    if (k === "j" || k === "k" || k === "down" || k === "up") {
      const ord = this.keyOrder();
      if (!ord.length) return;
      const down = k === "j" || k === "down";
      let i = ord.indexOf(this.kf ?? sel);
      i = i < 0 ? 0 : down ? Math.min(ord.length - 1, i + 1) : Math.max(0, i - 1);
      this.kf = ord[i];
      if (typeof sel === "string") setShared(SELECTED, ord[i]); // the open task follows
      stop(); cx.notify();
      return;
    }
    if (k === "enter" && this.kf) { this.openTask(this.kf.slice(5)); stop(); return; }
    if (k === "escape") {
      if (typeof sel === "string") { setShared(SELECTED, null); run("layout.hide", { id: "detail" }); } else this.kf = null;
      stop(); cx.notify();
      return;
    }
    if (k === "g") { this.gAt = Date.now(); stop(); return; }
    if (k === "d") { this.openDigest(); stop(); return; }
    if (k === "c") { setShared(FOCUS_BAR, Date.now()); stop(); return; }
    if (!task) return;
    if (k === "s") { this.openSteer(task.id, false); stop(); }
    else if (k === "p") { this.togglePause(task); stop(); }
    else if (k === "t") { this.openTerminal(task.terminal, task.id); stop(); }
    else if (k === "a") {
      // Accept: the recommended answer (Merge, Approve) of the task's open question.
      const q = this.questions().find((x) => x.task === task.id && x.kind !== "grill");
      const pick = q?.recommended ?? q?.options?.[0];
      if (q && pick) this.answer(q, pick);
      stop();
    }
  }

  /** Steer menu keys: P R C S T ↵. */
  steerKey(e, cx) {
    if (this.steerMode) return; // typing in the field
    const task = (this.state().tasks ?? []).find((x) => x.id === props()?.task);
    if (!task) return;
    const k = e.key.toLowerCase();
    const close = () => closeOverlay(props().overlay);
    if (k === "p") { this.togglePause(task); close(); }
    else if (k === "r" || k === "c") { this.steerMode = k === "r" ? "redirect" : "context"; this.steerInput.focus(); cx.notify(); }
    else if (k === "s") { close(); this.askStatus(task); }
    else if (k === "t") { close(); this.openTerminal(task.terminal, task.id); }
    else if (k === "enter") { close(); this.openTask(task.id); }
    else return;
    cx.stop_propagation();
  }

  // ---- task detail ---------------------------------------------------------------------

  selectedTask() {
    // props.task opens a task without a click (a layout or overlay can pin one).
    const key = shared("shepherd.selected") ?? (props()?.task ? `task-${props().task}` : null);
    if (typeof key !== "string" || !key.startsWith("task-")) return null;
    return (this.state().tasks ?? []).find((x) => `task-${x.id}` === key) ?? null;
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
    const wantGit = tab === "changes" || tab === "files" || (prCard && !task.pr);
    if (!dir || !wantGit) return;
    if (!e.git || Date.now() - (e.git.at ?? 0) > GIT_STALE_MS) {
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
    // A space switch shows another repo: load it now rather than on the next tick.
    const repo = this.repo();
    if (repo && !(repo.key in this.data)) { this.data[repo.key] = { tasks: [], questions: [], alerts: {} }; this.sync(cx); }
    if (p.panel === "status") return this.renderStatus();
    if (p.panel === "tabs") return renderTabBar(this);
    if (p.panel === "steer") return renderSteer(this).track_focus(this.keys).on_key_down((e, cx) => this.steerKey(e, cx));
    if (p.panel === "term") return renderTermBar(this);
    if (p.panel === "termfoot") return renderTermFoot(this);
    if (p.panel === "digest") return renderDigest(this);
    if (p.panel === "bar") {
      const ask = shared(FOCUS_BAR) ?? 0;
      if (ask > this.barFocusSeen) { this.barFocusSeen = ask; cx.spawn(async () => { this.barInput.focus(); }); }
      return renderBar(this);
    }
    if (p.panel === "detail") {
      const task = this.selectedTask();
      if (task) this.ensureGit(task, cx);
      // 1–5 switch tabs while the detail pane holds the keyboard (the board handles them too).
      return renderDetail(this).track_focus(this.keys)
        .on_mouse_down("left", () => this.keys.focus())
        .on_key_down((e, cx) => {
          const k = e.key;
          if (["1", "2", "3", "4", "5"].includes(k) && !e.modifiers?.platform && !e.modifiers?.control) { setShared(TAB, TABS[Number(k) - 1]); cx.stop_propagation(); }
        });
    }
    const view = this.view();
    const body = view === "needs" ? renderNeeds(this) : view === "pipeline" ? renderPipeline(this)
      : view === "deps" ? renderDeps(this) : renderBoard(this);
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
    const l = this.load;
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
