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
  props, terminals, panes, spaces, focused, theme, shared, setShared, readTextFile, watchFolder,
  hc, notify, playSound, exec, run, openOverlay, closeOverlay, nextCommand,
} from "herdr";
import {
  TASKS, CHAT, MAX_LOOPS, STAGES, ORDER, STUCK_MIN, LIMITS, VIEW, VIEWS, SELECTED, DIGEST_OPEN, HISTORY_OPEN, STEER_OPEN,
  localId, machineOf, palette, mins, tint, recAnswer, pendingId,
} from "./common.js";
import { renderBoard } from "./board.js";
import { peekedKey, closePeek } from "./peek.js";
import { renderNeeds } from "./needs.js";
import { renderBar } from "./bar.js";
import { renderDetail, TAB, TABS } from "./detail.js";
import { loadGit, loadDiff, loadFile, worktreeOf } from "./git.js";
import { loadPr, loadProof } from "./ship.js";
import { renderTabBar, renderCloseTab } from "./tabbar.js";
import { renderPipeline, renderDeps } from "./views.js";
import { renderSteer, renderTermBar, renderTermFoot } from "./steer.js";
import { renderDigest } from "./digest.js";
import { renderHistory } from "./history.js";
import { initSidebar, renderSidebar, renderPlus, startNewFolder, folders } from "./sidebar.js";
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
const PR_STALE_MS = 30000; // gh pr view, for the PR card's checks
const PROOF_STALE_MS = 15000;
const LOAD_MS = 15000; // the status bar's machine load
const CHAT_MAX = 500; // History keeps the newest lines
const QINDEX = new WeakMap(); // questions array → questionIndex(), so it is worked out once per load
const START_STALE_MS = 120000; // a "starting" mark older than this (start.sh done, no Shepherd showed) is dropped
const QUEUE_IDLE_MS = 5000; // queued lines go once Shepherd has been idle (or done) this long
const QUEUE_FALLBACK_MS = 90000; // a Shepherd that never reports a status gets queued lines after this
const QUEUE_CLAIM_MS = 60000; // a copy sending a line holds it this long, so two copies never send it twice

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
      this.prunePending(next.chat);
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

  /** Open questions of the shown space, oldest first, each with its task as taskObj. */
  questions() {
    const repo = this.repo();
    if (!repo) return [];
    const { tasks, questions } = this.state();
    const pending = new Set(shared(PENDING) ?? []);
    const { grillNo } = this.questionIndex(questions ?? []);
    return (questions ?? [])
      .filter((q) => q.answer == null && !pending.has(pendingId(repo.key, q.id)))
      .map((q) => ({ ...q, taskObj: tasks.find((x) => x.id === q.task) ?? null,
        // A grilling question's number in its task's grilling (they come one at a time, no limit).
        grillNo: grillNo.get(q.id) ?? null }))
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

  /** `space`: the question's space when it isn't the shown one (a toast). */
  answer(q, text, space = this.space()) {
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
  sentAnswer(q, space = this.space()) {
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

  /** The shown space's queued lines as chat lines (`queued`: shown as waiting for Shepherd). */
  queuedChat(space = this.space()) {
    return this.queued(space).map((x) => ({ at: x.at, from: "you", text: x.line, task: x.task ?? null, queued: true }));
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
    // Stuck counts from the stage run's start or the person's last answer in it, whichever is later:
    // time waiting on the person isn't the agent being stuck.
    const answeredAt = Math.max(0, ...(this.questionIndex().answers.get(task.id) ?? [])
      .filter(([asked]) => asked >= since).map(([, answered]) => answered));
    const minutes = (Date.now() - Math.max(since, answeredAt)) / 60000;
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
      live: term?.state === "live",
      key: `task-${task.id}`,
      id: task.id,
      title: task.title ?? task.id,
      stage: STAGES[task.stage] ? task.stage : "spec",
      // The workflow's skill for the stage where it names one (Grill: /grill-me when picked).
      skill: this.settings().stages?.[task.stage]?.skill ?? STAGES[task.stage]?.skill ?? "",
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
        live: x.state === "live",
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

  taskById(id) { return id ? (this.state().tasks ?? []).find((x) => x.id === id) ?? null : null; }

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
    this.tell(`${task.status === "paused" ? "resume" : "pause"} ${task.id}`, task.id);
  }

  /** Ask for status: Shepherd answers with `say --task`, in the History, so show it. */
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

  /** 1–5: the open task's tabs. */
  detailTab(k) {
    const tab = TABS[Number(k) - 1];
    if (!tab || typeof shared(SELECTED) !== "string") return false;
    setShared(TAB, tab);
    return true;
  }

  /** A: the recommended answer (Merge, Approve, a grilling question's) of the task's open question; nothing without one. */
  accept(task) {
    const q = this.questions().find((x) => x.task === task.id && recAnswer(x));
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
    const input = q ? this.replyInput(q.id) : null;
    if (input) cx.spawn(async () => { input.focus(); });
  }

  /** C: the bar takes the keyboard with "add " typed (design focusChat). */
  focusBar() { run("shepherd.focus-bar"); }

  /** A key command (keys.json `shepherd.<command>`, delivered to every shown copy): digest, history,
   *  focus, focus-bar, steer, terminal, pause, open, view:<v>, tab:<1-5>, next, prev. The board copy
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
    else if (name === "needs") this.openNeeds(arg || null);
    else if (name === "answer") this.answerFromToast(arg);
    else if (name === "reply") this.replyNext(cx);
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
    if (["1", "2", "3", "4", "5"].includes(k)) { if (this.detailTab(k)) done(); return; }
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
    if (isToast(p)) return renderToast(this);
    // A space switch shows another repo: load it now rather than on the next tick.
    const repo = this.repo();
    if (repo && !(repo.key in this.data)) { this.data[repo.key] = { tasks: [], questions: [], alerts: {} }; this.sync(cx); }
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
      // 1–5 switch tabs while the detail pane holds the keyboard (the board handles them too), never
      // while typing in the Ask field: its keys bubble up here. A click in the field stops there
      // (detail.js), so this one doesn't take the keyboard from it.
      return renderDetail(this).track_focus(this.keys)
        .on_mouse_down("left", () => this.keys.focus())
        .on_key_down((e, cx) => {
          if (this.askFocused) return;
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
