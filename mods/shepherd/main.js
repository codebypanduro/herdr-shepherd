// Shepherd: one mod, several roles. props.view picks the main view (board, needs; the person's
// switch in shared "shepherd.view" wins), props.panel a side role (detail, status, bar).
// Everything reads the shown space's <repo>/.herdr/shepherd/tasks.json, written by Shepherd
// through shepherd/bin/shep.mjs. The repo is the `shepherd.dir` label on the space's Shepherd
// terminal, else the space's folder. Answers and messages go to Shepherd with `hc send`.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState } from "gpui-base";
import {
  props, terminals, spaces, focused, theme, shared, setShared, readTextFile, watchFolder,
  hc, notify, playSound,
} from "herdr";
import { TASKS, MAX_LOOPS, STAGES, localId, machineOf, palette } from "./common.js";
import { renderBoard } from "./board.js";
import { renderNeeds } from "./needs.js";
import { renderBar } from "./bar.js";
import { renderDetail, tint, TAB, TABS } from "./detail.js";
import { loadGit, loadDiff, loadFile, worktreeOf } from "./git.js";
import { loadPr, loadProof } from "./ship.js";

const REFRESH_MS = 5000;
const VIEW = "shepherd.view";
const PENDING = "shepherd.pending"; // question ids answered here that tasks.json hasn't caught up with
const ALERTED = "shepherd.alerted"; // "<repo key>#<question id>" already alerted
const ALERT_WINDOW_MS = 15 * 60000; // older questions found on first sight are not news
const REPLY_SLOTS = 12; // InputStates can't be made in render: a fixed pool for Needs you cards
const GIT_STALE_MS = 10000; // Changes and Files reload this often while shown
const PR_STALE_MS = 30000; // gh pr view, for the PR card's checks
const PROOF_STALE_MS = 15000;

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
    if (props()?.panel === "bar") {
      this.barInput = InputState.new({ placeholder: "Tell Shepherd what to build, or ask about any task…" });
      this.barInput.on("submit", () => this.say(this.barInput.value()));
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
    // Alerts: the person's workflow (Shepherd's label), then the space's orchestra.json on top.
    let alerts = { toast: true, sound: true, phone: false, ntfy: "" };
    try {
      if (repo.workflow) alerts = { ...alerts, ...((await this.readJson(repo.workflow, repo.machine))?.alerts ?? {}) };
      alerts = { ...alerts, ...((await this.readJson(`${repo.dir}/.herdr/orchestra.json`, repo.machine))?.alerts ?? {}) };
    } catch { /* a broken settings file keeps the defaults */ }
    this.data[repo.key] = { ...next, alerts };
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
    const note = task.status === "parked" ? "parked"
      : task.status === "paused" ? "paused"
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

  view() { return shared(VIEW) ?? props()?.view ?? "board"; }

  /** The 32px pane header every view shares: title, subtitle, view switch; add filters after it. */
  header(title, sub) {
    const t = palette();
    const view = this.view();
    const n = this.questions().length;
    const tab = (key, label, count) => h_flex().id(`view-${key}`).h(22).px(8).gap(5).items_center().rounded(5)
      .bg(view === key ? t.selected : t.surface).text_color(view === key ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover))
      .on_click(() => setShared(VIEW, key))
      .child(label)
      .when(count > 0, (el) => el.child(div().px(5).rounded(4).bg(t.blocked).text_color(t.background)
        .text_size(10.5).font_semibold().child(String(count))));
    return h_flex().h(32).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().text_color(t.foreground).child(title))
      .child(div().text_color(t.dim).child(sub))
      .when(Boolean(this.error()), (el) => el.child(div().truncate().text_color(t.ansi1).child(this.error())))
      .child(h_flex().gap(2).child(tab("board", "Board", 0)).child(tab("needs", "Needs you", n)))
      .child(div().flex_1());
  }

  render(cx) {
    const p = props() ?? {};
    // A space switch shows another repo: load it now rather than on the next tick.
    const repo = this.repo();
    if (repo && !(repo.key in this.data)) { this.data[repo.key] = { tasks: [], questions: [], alerts: {} }; this.sync(cx); }
    if (p.panel === "status") return this.renderStatus();
    if (p.panel === "bar") return renderBar(this);
    if (p.panel === "detail") {
      const task = this.selectedTask();
      if (task) this.ensureGit(task, cx);
      return renderDetail(this);
    }
    return this.view() === "needs" ? renderNeeds(this) : renderBoard(this);
  }

  renderStatus() {
    const t = palette();
    return h_flex().id("shepherd-status").size_full().px(12).gap(14).items_center().bg(t.chrome)
      .border_t(1).border_color(t.border)
      .font_family("JetBrains Mono").text_size(11).text_color(t.dim)
      .child("herdr-core · local")
      .child(`max loops ${MAX_LOOPS}`)
      .child(div().flex_1())
      .child("mods/shepherd");
  }
}
