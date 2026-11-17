#!/usr/bin/env node
// shep: the only way Shepherd changes .herdr/shepherd/tasks.json (docs/CONVENTIONS.md).
// Every write is atomic (temp file + rename), so the board never reads half a file.
// The file is found from --tasks <path>, $SHEP_FILE, or <git root of cwd>/.herdr/shepherd/tasks.json.
//
//   shep init <space>
//   shep add --title "…" [--id X-1] [--source you] [--stage implement] [--max-loops 3]   prints the id
//   shep start <id> <stage> [--terminal t6] [--model M] [--note "…"]      opens a stage run (status working)
//   shep end <id> pass|fail|ask [--note "…"] [--tokens N] [--cost N]      closes the open stage run
//   shep loop <id>                    next build loop; exits 2 when maxLoops is used up (ask the person)
//   shep set <id> key=value …         stage status terminal branch worktree pr summary title blockedBy
//   shep finding <id> add --text "…" [--file f] [--line n]                prints the finding id
//   shep finding <id> <fid> open|fixing|resolved
//   shep get <id> | shep ls

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { execFileSync } from "node:child_process";

const STAGES = ["triage", "spec", "tickets", "implement", "review", "ci", "proof", "merge", "done"];
const STATUSES = ["working", "blocked", "queued", "paused", "parked", "done"];
const RESULTS = ["pass", "fail", "ask"];

const die = (msg, code = 1) => { process.stderr.write(`shep: ${msg}\n`); process.exit(code); };

function parse(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) opt[k] = true;
      else { opt[k] = v; i++; }
    } else pos.push(a);
  }
  return { pos, opt };
}

function fileFor(opt) {
  if (opt.tasks) return opt.tasks;
  if (process.env.SHEP_FILE) return process.env.SHEP_FILE;
  let root = process.cwd();
  try { root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(); } catch {}
  return join(root, ".herdr", "shepherd", "tasks.json");
}

const load = (file) => {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (e) { die(`${file}: ${e.message}`); }
};

function save(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, file);
}

const now = () => new Date().toISOString();
const num = (v) => (v === undefined || v === true ? undefined : Number(v));

function task(state, id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) die(`no task ${id}`);
  return t;
}

function openRun(t) {
  for (let i = t.history.length - 1; i >= 0; i--) if (!t.history[i].end) return t.history[i];
  return null;
}

const { pos, opt } = parse(process.argv.slice(2));
const [cmd, ...args] = pos;
const file = fileFor(opt);
let state = load(file);
const need = () => state ?? die(`${file} missing: run shep init <space> first`);

switch (cmd) {
  case "init": {
    if (state) { console.log(file); break; }
    if (!args[0]) die("init <space>");
    state = { space: args[0], tasks: [], questions: [] };
    save(file, state);
    console.log(file);
    break;
  }
  case "add": {
    need();
    if (!opt.title || opt.title === true) die("add --title \"…\"");
    const stage = opt.stage ?? "spec";
    if (!STAGES.includes(stage)) die(`stage must be one of ${STAGES.join(" ")}`);
    let id = opt.id;
    if (!id) {
      const prefix = (state.prefix ?? "T");
      const n = state.tasks.reduce((m, t) => Math.max(m, parseInt(String(t.id).split("-").pop(), 10) || 0), 0) + 1;
      id = `${prefix}-${n}`;
    }
    if (state.tasks.some((t) => t.id === id)) die(`task ${id} exists`);
    state.tasks.push({
      id, title: opt.title, source: opt.source ?? "you", stage, status: "queued",
      loop: 1, maxLoops: num(opt["max-loops"]) ?? 3, blockedBy: [],
      terminal: null, worktree: null, branch: null, pr: null,
      history: [], findings: [], summary: "",
    });
    save(file, state);
    console.log(id);
    break;
  }
  case "start": {
    need();
    const [id, stage] = args;
    if (!STAGES.includes(stage)) die(`start <id> <stage>; stage one of ${STAGES.join(" ")}`);
    const t = task(state, id);
    const open = openRun(t);
    if (open) { open.end = now(); open.result = open.result ?? "pass"; }
    t.stage = stage;
    // Ready to merge waits on the person.
    t.status = stage === "done" ? "done" : stage === "merge" ? "blocked" : "working";
    if (opt.terminal) t.terminal = opt.terminal;
    if (stage !== "done") {
      t.history.push({ loop: t.loop, stage, result: "running", note: opt.note ?? "",
        start: now(), end: null, model: opt.model ?? null, tokens: null, cost: null });
    }
    save(file, state);
    break;
  }
  case "end": {
    need();
    const [id, result] = args;
    if (!RESULTS.includes(result)) die(`end <id> ${RESULTS.join("|")}`);
    const t = task(state, id);
    const open = openRun(t);
    if (!open) die(`${id} has no open stage run`);
    open.end = now();
    open.result = result;
    if (opt.note) open.note = opt.note;
    if (num(opt.tokens) !== undefined) open.tokens = num(opt.tokens);
    if (num(opt.cost) !== undefined) open.cost = num(opt.cost);
    if (result === "ask") t.status = "blocked";
    save(file, state);
    break;
  }
  case "loop": {
    need();
    const t = task(state, args[0]);
    if (t.loop >= t.maxLoops) {
      t.status = "blocked";
      save(file, state);
      die(`${t.id} used all ${t.maxLoops} loops: ask the person (One more loop / Park it / I'll take it)`, 2);
    }
    t.loop += 1;
    save(file, state);
    console.log(t.loop);
    break;
  }
  case "set": {
    need();
    const [id, ...pairs] = args;
    const t = task(state, id);
    for (const p of pairs) {
      const i = p.indexOf("=");
      if (i < 1) die(`set <id> key=value; got ${p}`);
      const k = p.slice(0, i), v = p.slice(i + 1);
      if (k === "stage" && !STAGES.includes(v)) die(`stage one of ${STAGES.join(" ")}`);
      if (k === "status" && !STATUSES.includes(v)) die(`status one of ${STATUSES.join(" ")}`);
      if (k === "blockedBy") t.blockedBy = v ? v.split(",") : [];
      else if (["loop", "maxLoops", "pr"].includes(k)) t[k] = v === "" ? null : Number(v);
      else if (["stage", "status", "terminal", "branch", "worktree", "summary", "title"].includes(k)) t[k] = v === "" ? null : v;
      else die(`unknown key ${k}`);
    }
    save(file, state);
    break;
  }
  case "finding": {
    need();
    const [id, sub, state2] = args;
    const t = task(state, id);
    if (sub === "add") {
      if (!opt.text || opt.text === true) die("finding <id> add --text \"…\"");
      const fid = `f${t.findings.length + 1}`;
      t.findings.push({ id: fid, loop: t.loop, file: opt.file ?? null, line: num(opt.line) ?? null,
        text: opt.text, state: "open", history: [{ loop: t.loop, state: "found" }] });
      save(file, state);
      console.log(fid);
    } else {
      const f = t.findings.find((x) => x.id === sub);
      if (!f) die(`no finding ${sub} on ${id}`);
      if (!["open", "fixing", "resolved"].includes(state2)) die("finding <id> <fid> open|fixing|resolved");
      f.state = state2;
      f.history = f.history ?? [];
      f.history.push({ loop: t.loop, state: state2 === "resolved" ? "fixed" : state2 === "open" ? "still open" : "fixing" });
      save(file, state);
    }
    break;
  }
  case "get": console.log(JSON.stringify(task(need(), args[0]), null, 2)); break;
  case "ls":
    for (const t of need().tasks) console.log(`${t.id}\t${t.stage}\t${t.status}\tloop ${t.loop}/${t.maxLoops}\t${t.title}`);
    break;
  default:
    die("commands: init add start end loop set finding get ls (see the top of shep.mjs)");
}
