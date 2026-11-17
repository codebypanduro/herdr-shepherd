// Shepherd: one mod, several roles. props.view picks the main view (board, pipeline, deps, needs;
// the person's switch in shared "shepherd.view" wins), props.panel a side role (spaces, tabs,
// detail, status, bar) or an overlay (steer, term, termfoot, digest, history, plus, machine, usage,
// newspace, addmachine, workflow, spacesettings).
// Everything reads the shown space's <repo>/.herdr/shepherd/tasks.json, written by Shepherd
// through shepherd/bin/shep.mjs. The repo is the `shepherd.dir` label on the space's Shepherd
// terminal, else the space's folder. Answers and messages go to Shepherd with `hc send`.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, ScrollHandle } from "gpui-base";
import {
  props, terminals, spaces, focused, theme, shared, setShared, readTextFile, watchFolder,
  hc, notify, playSound, exec, run, openOverlay, closeOverlay, nextCommand,
} from "herdr";
import {
  TASKS, CHAT, MAX_LOOPS, STAGES, ORDER, STUCK_MIN, LIMITS, VIEW, VIEWS, SELECTED, DIGEST_OPEN, HISTORY_OPEN,
  localId, machineOf, palette, mins, tint,
} from "./common.js";
import { renderBoard } from "./board.js";
import { renderNeeds } from "./needs.js";
import { renderBar } from "./bar.js";
import { renderDetail, TAB, TABS } from "./detail.js";
import { loadGit, loadDiff, loadFile, worktreeOf } from "./git.js";
import { loadPr, loadProof } from "./ship.js";
import { renderTabBar } from "./tabbar.js";
import { renderPipeline, renderDeps } from "./views.js";
import { renderSteer, renderTermBar, renderTermFoot } from "./steer.js";
import { renderDigest } from "./digest.js";
import { renderHistory } from "./history.js";
import { initSidebar, renderSidebar, renderPlus, startNewFolder, folders } from "./sidebar.js";
import { renderMachinePop, renderUsagePop } from "./machines.js";
import { initAddMachine, renderAddMachine, initNewSpace, renderNewSpace } from "./dialogs.js";
import { initWorkflow, renderWorkflow, initSpaceSettings, renderSpaceSettings } from "./settings.js";
import {
  openNewSpace, openAddMachine, openMachine, openSpaceSettings, openUsage, openWorkflow, readWorkflow, shepherdOn,
  execSafe, failLine, TERM_WINDOW, closeTermWindow,
} from "./ui.js";

const REFRESH_MS = 5000;
const PENDING = "shepherd.pending"; // question ids answered here that tasks.json hasn't caught up with
const ALERTED = "shepherd.alerted"; // "<repo key>#<question id>" already alerted
const ALERT_WINDOW_MS = 15 * 60000; // older questions found on first sight are not news
const REPLY_SLOTS = 12; // InputStates can't be made in render: a fixed pool for Needs you cards
const GIT_STALE_MS = 10000; // Changes and Files reload this often while shown
const PR_STALE_MS = 30000; // gh pr view, for the PR card's checks
const PROOF_STALE_MS = 15000;
const LOAD_MS = 15000; // the status bar's machine load
const CHAT_MAX = 500; // History keeps the newest lines

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
    }
    if (p.panel === "steer") {
      this.steerMode = null; // null: the menu; "redirect" | "context": the text field
      this.steerInput = InputState.new({ placeholder: "" });
      this.steerInput.on("submit", () => this.sendSteer());
    }
    if (p.panel === "history") {
      this.historyInput = InputState.new({ placeholder: "Talk to shepherd · try “add a dark mode toggle”" });
      this.historyInput.on("submit", () => { if (this.tell(this.historyInput.value().trim())) this.historyInput.set_value(""); });
      this.historyScroll = ScrollHandle.new();
      this.historyCount = 0;
    }
    if (p.panel === "spaces") initSidebar(this, cx, InputState);
    if (p.panel === "addmachine") initAddMachine(this, cx, InputState);
    if (p.panel === "newspace") initNewSpace(this, cx, InputState);
    if (p.panel === "workflow") initWorkflow(this, cx);
    if (p.panel === "spacesettings") initSpaceSettings(this, cx, InputState);
    // D and ⌘J toggle these: the open copy's overlay id, cleared in close().
    if (p.panel === "digest") setShared(DIGEST_OPEN, p.overlay ?? null);
    if (p.panel === "history") setShared(HISTORY_OPEN, p.overlay ?? null);
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

  async close() {
    const p = props() ?? {};
    if (p.panel === "digest" && shared(DIGEST_OPEN) === p.overlay) setShared(DIGEST_OPEN, null);
    if (p.panel === "history" && shared(HISTORY_OPEN) === p.overlay) setShared(HISTORY_OPEN, null);
  }

  // ---- where things are ----------------------------------------------------------------

  space() {
    const id = focused()?.space;
    return spaces().find((s) => s.id === id) ?? spaces().find((s) => s.active) ?? null;
  }

  shepherd(space = this.space(), all = terminals()) {
    if (!space) return null;
    return all.find((x) => x.state === "live" && x.labels?.["herdr.role"] === "shepherd"
      && x.labels?.["herdr.space"] === localId(space) && machineOf(x) === (space.machine ?? null)) ?? null;
  }

  /** Where the space's tasks live: { machine, dir, key, workflow }, or null. */
  repo(space = this.space(), all = undefined) {
    if (!space) return null;
    const sh = this.shepherd(space, all);
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
      // The chat (History): JSON lines; a half-written last line is skipped until it's whole.
      const chat = await readTextFile(`${repo.dir}/${CHAT}`, { on: repo.machine }).catch(() => null);
      next.chat = (chat ?? "").split("\n").slice(-CHAT_MAX).flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } });
    } catch (e) {
      // Keep the last good state; shep writes atomically, so this is a hand edit gone wrong.
      next = { ...prev, error: `tasks.json: ${e.message ?? e}` };
    }
    // Settings: the person's workflow, then the space's orchestra.json on top. Here that's the one
    // workflow.json Workflow settings writes (ui.js readWorkflow); on another machine, workflow.json
    // beside the file Shepherd's label names there, else that file.
    let wf = {}, orch = {};
    try {
      if (!repo.machine) wf = (await readWorkflow(this)).wf;
      else if (repo.workflow) {
        const mine = repo.workflow.replace(/workflow\.example\.json$/, "workflow.json");
        wf = (await this.readJson(mine, repo.machine)) ?? (await this.readJson(repo.workflow, repo.machine)) ?? {};
      }
    } catch { /* defaults */ }
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
    this.data[repo.key] = { ...next, alerts, settings, wf, orch };
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
    if (line && this.tell(line)) this.barInput.set_value("");
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
      stuckText: stuck ? `stuck · over ${mins(limit)} in ${STAGES[task.stage]?.title ?? task.stage}` : null,
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

  // ---- spaces ----------------------------------------------------------------------------

  /** shepherd/start.sh for a space, on its machine, in the background (it starts Shepherd in its
   *  own tab). Here the script is this mod's own checkout's, found through the mods/shepherd link;
   *  on another machine it's that machine's checkout, run with its login shell's PATH (shepherdOn;
   *  `known` is a result already asked for). One start per space at a time on this copy
   *  (`starting`, which Space settings shows as "Starting…"): start.sh's own check for a running
   *  Shepherd is check-then-act, so two quick clicks could start two. Resolves when it's done. */
  startShepherd(space, known = null) {
    const dir = space ? space.folder || this.repo(space)?.dir : null;
    const starting = (this.starting ??= new Set());
    if (!dir || starting.has(space.id)) return Promise.resolve();
    starting.add(space.id);
    const machine = space.machine ?? null;
    const fail = (body) => notify({ title: "Shepherd didn't start", body, level: "error" });
    return (async () => {
      const s = known?.dir ? known : await shepherdOn(this, machine);
      if (!s.dir) return fail(machine ? `${machine}: ${s.reason}` : s.reason);
      const args = [`${s.dir}/start.sh`, "--space", localId(space), dir];
      const r = machine ? await execSafe("sh", ["-c", 'PATH="$1"; shift; exec sh "$@"', "start", s.path, ...args], { on: machine, timeout: 60000 })
        : await execSafe("sh", args, { timeout: 60000 });
      if (r.code !== 0) fail(r.code === -1 ? failLine(r) : (r.stderr || r.stdout || `exit ${r.code}`).trim().split("\n").pop());
    })().catch((e) => fail(String(e?.message ?? e))).finally(() => starting.delete(space.id));
  }

  // ---- steering and overlays --------------------------------------------------------------

  taskById(id) { return id ? (this.state().tasks ?? []).find((x) => x.id === id) ?? null : null; }

  /** shep.mjs beside Shepherd's workflow file (its shepherd.workflow label), on the space's machine. */
  shepBin(name) {
    const wf = this.repo()?.workflow;
    return wf ? `${wf.replace(/\/[^/]*$/, "")}/bin/${name}` : null;
  }

  /** Keeps a line of the chat (History): `shep say --from you|shepherd`, appended to chat.jsonl. */
  record(from, text, task = null) {
    const repo = this.repo();
    const shep = this.shepBin("shep.mjs");
    if (!repo || !shep) return;
    const args = [shep, "--tasks", `${repo.dir}/${TASKS}`, "say", "--from", from, ...(task ? ["--task", task] : []), text];
    exec("node", args, { on: repo.machine, timeout: 10000 }).catch(() => null);
  }

  /** A line to this space's Shepherd (CONVENTIONS.md "Talking to Shepherd"), kept in the chat. */
  tell(line, task = null) {
    const sh = this.shepherd();
    if (!sh) { notify({ title: "No Shepherd in this space", body: "Start one with shepherd/start.sh.", level: "warning" }); return false; }
    hc(["send", sh.address, line]);
    this.record("you", line, task);
    return true;
  }

  togglePause(task) {
    if (!task || !["working", "paused"].includes(task.status)) return;
    this.tell(`${task.status === "paused" ? "resume" : "pause"} ${task.id}`, task.id);
  }

  /** Ask for status: Shepherd answers in its own output (and the History), so show History. */
  askStatus(task) {
    if (task && this.tell(`status ${task.id}?`, task.id)) this.toggleHistory(true);
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

  /** An agent's real terminal in a window: a title bar to drag it by, the terminal, a footer.
   *  `name`: what the footer calls a terminal that's neither Shepherd nor a task's (a tab's name). */
  openTerminal(address, taskId, name = null) {
    if (!address) return;
    const bar = (panel, px) => ({ type: "block", size: { px }, content: { mod: "shepherd", props: { panel, terminal: address, task: taskId, name } } });
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
    const text = this.steerInput.value().trim();
    const id = props()?.task;
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

  /** Cards in keyboard order: the board's column order, or the pipeline's rows. Other views: none. */
  keyOrder() {
    const cards = this.cards().filter((c) => c.task);
    const view = this.view();
    if (view === "pipeline") return this.pipelineOrder(cards).map((c) => c.key);
    if (view === "board") return ORDER.flatMap((s) => cards.filter((c) => c.stage === s)).map((c) => c.key);
    return [];
  }

  pipelineOrder(cards) {
    const rank = (c) => (c.status === "blocked" ? 0 : c.status === "working" ? 1 : c.status === "done" ? 3 : 2);
    return [...cards].sort((a, b) => rank(a) - rank(b) || ORDER.indexOf(b.stage) - ORDER.indexOf(a.stage));
  }

  /** The task keys act on: the keyboard focus, else the open one. */
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

  /** 1–5: the open task's tabs. */
  detailTab(k) {
    const tab = TABS[Number(k) - 1];
    if (!tab || typeof shared(SELECTED) !== "string") return false;
    setShared(TAB, tab);
    return true;
  }

  /** A: the recommended answer (Merge, Approve) of the task's open question; nothing without one. */
  accept(task) {
    const q = this.questions().find((x) => x.task === task.id && x.kind !== "grill" && x.recommended);
    if (q) this.answer(q, q.recommended);
  }

  /** C: the bar takes the keyboard with "add " typed (design focusChat). */
  focusBar() { run("shepherd.focus-bar"); }

  /** A key command (keys.json `shepherd.<command>`, delivered to every shown copy): digest, history,
   *  focus, focus-bar, steer, terminal, pause, open, view:<v>, tab:<1-5>, next, prev. The board copy
   *  acts on all but focus-bar, which only the bar copy takes. Task commands act on the keyboard
   *  focus, else the open task; `:<id>` names one. */
  command(c, cx) {
    const [name, arg] = String(c).split(":");
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
    else if (name === "tab") this.detailTab(arg);
    else if (name === "next" || name === "prev") this.moveFocus(name === "next" ? 1 : -1);
    else if (!task) return;
    else if (name === "open") this.openTask(task.id);
    else if (name === "steer") this.openSteer(task.id, false);
    else if (name === "terminal") this.openTerminal(task.terminal, task.id);
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
      "space-settings": () => {
        const s = arg ? spaces().find((x) => x.id === arg || localId(x) === arg) : this.space();
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
    if (["1", "2", "3", "4", "5"].includes(k)) { if (this.detailTab(k)) done(); return; }
    if (k === "j" || k === "k" || k === "down" || k === "up") { if (this.moveFocus(k === "j" || k === "down" ? 1 : -1)) done(); return; }
    if (k === "enter" && this.kf) { this.openTask(this.kf.slice(5)); done(); return; }
    if (k === "escape") {
      if (typeof sel === "string") { setShared(SELECTED, null); run("layout.hide", { id: "detail" }); } else this.kf = null;
      done();
      return;
    }
    if (k === "g") { this.gAt = Date.now(); done(); return; }
    if (k === "d") { this.toggleDigest(); done(); return; }
    if (k === "c") { this.focusBar(); done(); return; }
    const key = { n: "new-space", f: "new-folder", w: "workflow", u: "usage" }[k];
    if (key && this.overlayCommand(key)) { done(); return; }
    const task = this.keyTask();
    if (!task) return;
    if (k === "s") this.openSteer(task.id, false);
    else if (k === "p") this.togglePause(task);
    else if (k === "t") this.openTerminal(task.terminal, task.id);
    else if (k === "a") this.accept(task);
    else return;
    done();
  }

  /** Steer menu keys: P (stays open, as in the design) R C S T ↵. Esc is Herdr's: it closes the popup. */
  steerKey(e, cx) {
    if (this.steerMode) return; // typing in the field
    const task = this.taskById(props()?.task);
    if (!task) return;
    const k = e.key.toLowerCase();
    const close = () => closeOverlay(props().overlay);
    if (k === "p") this.togglePause(task);
    else if (k === "r" || k === "c") { this.steerMode = k === "r" ? "redirect" : "context"; this.steerInput.focus(); }
    else if (k === "s") { close(); this.askStatus(task); }
    else if (k === "t") { close(); this.openTerminal(task.terminal, task.id); }
    else if (k === "enter") { close(); this.openTask(task.id); }
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
    if (p.panel === "spaces") return renderSidebar(this);
    if (p.panel === "plus") return renderPlus();
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
      // 1–5 switch tabs while the detail pane holds the keyboard (the board handles them too).
      return renderDetail(this).track_focus(this.keys)
        .on_mouse_down("left", () => this.keys.focus())
        .on_key_down((e, cx) => {
          if (!e.modifiers?.platform && !e.modifiers?.control && this.detailTab(e.key)) cx.stop_propagation();
        });
    }
    const view = this.view();
    // Needs you has reply fields: no board keys there, so typing a reply never steers a task.
    if (view === "needs") return renderNeeds(this);
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
