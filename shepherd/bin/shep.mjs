#!/usr/bin/env node
// shep: the only way Shepherd changes .herdr/shepherd/tasks.json (docs/CONVENTIONS.md).
// Every write is atomic (temp file + rename), so the board never reads half a file.
// The file is found from --tasks <path>, $SHEP_FILE, or <git root of cwd>/.herdr/shepherd/tasks.json.
//
//   shep init <space>
//   shep add --title "…" [--id X-1] [--source you] [--stage spec] [--max-loops 3]
//            [--blocked-by "T-4,T-5"] [--parent T-3] [--brief "…"]                       prints the id
//   shep ready                        queued tasks whose blockers are all done, one id per line
//   shep start <id> <stage> [--terminal t6] [--model M] [--note "…"]      opens a stage run (status working)
//   shep end <id> pass|fail|ask [--note "…"] [--tokens N] [--cost N]      closes the open stage run
//   shep loop <id>                    next build loop; exits 2 when maxLoops is used up (ask the person)
//   shep set <id> key=value …         stage status terminal branch worktree pr prUrl proof summary title brief blockedBy
//                                     wait ("waiting for room on <machine>": the card's note until start clears it)
//   shep finding <id> add --text "…" [--file f] [--line n]                prints the finding id
//   shep finding <id> <fid> open|fixing|resolved
//   shep ask <id> --text "…" [--kind ask|escalate|merge|triage|grill|approve] [--from "t5 implementer"]
//            [--options "One more loop|Park it|I'll take it"] [--recommended "One more loop"]   prints q1, q2, …
//            grilling: --kind grill --round 2 --questions <file.json>   [{q, options:[…], recommended, why}]
//            approval: --kind approve --tickets <file.json>             [{key, title, brief, blockedBy:[keys]}]
//   shep answer <qid> "<answer>"      records the person's answer; the question leaves Needs you
//   shep room [--wait] [--workflow f] is this machine under the workflow's CPU and memory limits? exit 0 yes, 3 no,
//                                     1 if load.sh failed; --wait: check every 15 s until there is room (run it in
//                                     an hc terminal). It measures the machine shep runs on: Shepherd's, which is the
//                                     space's machine when start.sh ran in a terminal of that space.
//   shep say [--from shepherd|you] [--task T-3] "<text>"   a line of the History (chat.jsonl beside tasks.json)
//   shep get <id> | shep ls

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const STAGES = ["triage", "spec", "tickets", "implement", "review", "ci", "proof", "merge", "done"];
const STATUSES = ["working", "blocked", "queued", "paused", "parked", "done"];
const RESULTS = ["pass", "fail", "ask"];
const KINDS = ["triage", "grill", "approve", "ask", "escalate", "merge"];

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
    for (const b of typeof opt["blocked-by"] === "string" ? opt["blocked-by"].split(",").map((x) => x.trim()).filter(Boolean) : []) {
      if (!state.tasks.some((t) => t.id === b)) die(`--blocked-by ${b}: no such task`);
    }
    state.tasks.push({
      id, title: opt.title, source: opt.source ?? "you", stage, status: "queued",
      loop: 1, maxLoops: num(opt["max-loops"]) ?? 3,
      blockedBy: typeof opt["blocked-by"] === "string" ? opt["blocked-by"].split(",").map((x) => x.trim()).filter(Boolean) : [],
      parent: typeof opt.parent === "string" ? opt.parent : null,
      brief: typeof opt.brief === "string" ? opt.brief : "",
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
    delete t.wait;
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
      else if (["stage", "status", "terminal", "branch", "worktree", "summary", "title", "prUrl", "proof", "brief", "wait"].includes(k)) t[k] = v === "" ? null : v;
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
  case "ask": {
    need();
    const t = task(state, args[0]);
    if (!opt.text || opt.text === true) die("ask <id> --text \"…\"");
    const kind = opt.kind ?? "ask";
    if (!KINDS.includes(kind)) die(`kind one of ${KINDS.join(" ")}`);
    state.questions = state.questions ?? [];
    const n = state.questions.reduce((m, q) => Math.max(m, parseInt(String(q.id).slice(1), 10) || 0), 0) + 1;
    const options = typeof opt.options === "string" ? opt.options.split("|").map((x) => x.trim()).filter(Boolean) : [];
    const recommended = typeof opt.recommended === "string" ? opt.recommended : null;
    if (recommended && options.length && !options.includes(recommended)) die("--recommended must be one of --options");
    const readList = (k) => {
      if (typeof opt[k] !== "string") return undefined;
      let v;
      try { v = JSON.parse(readFileSync(opt[k], "utf8")); } catch (e) { die(`--${k} ${opt[k]}: ${e.message}`); }
      if (!Array.isArray(v) || !v.length) die(`--${k} must be a non-empty JSON array`);
      return v;
    };
    const questions = readList("questions");
    const tickets = readList("tickets");
    if (kind === "grill" && !questions) die("--kind grill needs --questions <file.json>");
    if (kind === "approve" && !tickets) die("--kind approve needs --tickets <file.json>");
    for (const g of questions ?? []) if (!g.q || !Array.isArray(g.options) || !g.options.length) die("each grilling question needs q and options");
    for (const k of tickets ?? []) if (!k.key || !k.title) die("each ticket needs key and title");
    const q = { id: `q${n}`, task: t.id, kind, from: typeof opt.from === "string" ? opt.from : "shepherd",
      text: opt.text, options, recommended, asked: now(), answer: null, answered: null };
    if (questions) { q.round = num(opt.round) ?? 1; q.questions = questions; }
    if (tickets) q.tickets = tickets.map((k) => ({ ...k, blockedBy: Array.isArray(k.blockedBy) ? k.blockedBy : k.blockedBy ? [k.blockedBy] : [] }));
    state.questions.push(q);
    t.status = "blocked";
    save(file, state);
    console.log(`q${n}`);
    break;
  }
  case "answer": {
    need();
    const [qid, ...words] = args;
    const q = (state.questions ?? []).find((x) => x.id === qid);
    if (!q) die(`no question ${qid}`);
    if (!words.length) die("answer <qid> \"<answer>\"");
    q.answer = words.join(" ");
    q.answered = now();
    // The task goes back to work unless another question of it is still open.
    const t = state.tasks.find((x) => x.id === q.task);
    if (t && t.status === "blocked" && t.stage !== "merge"
      && !state.questions.some((x) => x.task === t.id && x.answer == null)) t.status = "working";
    save(file, state);
    break;
  }
  case "ready": {
    const done = new Set(need().tasks.filter((t) => t.stage === "done").map((t) => t.id));
    for (const t of state.tasks) {
      if (t.status === "queued" && (t.blockedBy ?? []).every((b) => done.has(b))) console.log(t.id);
    }
    break;
  }
  case "room": {
    // Limits: the person's workflow ($SHEP_WORKFLOW or --workflow), the space's orchestra.json on top.
    const read = (f) => { try { return f && existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {}; } catch { return {}; } };
    const wf = typeof opt.workflow === "string" ? opt.workflow : process.env.SHEP_WORKFLOW;
    // Defaults match LIMITS in mods/shepherd/common.js: change both together.
    const limits = { maxCpu: 80, maxMem: 85, ...read(wf).limits, ...read(join(dirname(dirname(file)), "orchestra.json")).limits };
    const loadSh = join(dirname(fileURLToPath(import.meta.url)), "load.sh");
    const sample = () => {
      let out;
      try { out = execFileSync("sh", [loadSh], { encoding: "utf8" }); } catch (e) { die(`load.sh failed: ${e.message.split("\n")[0]}`, 1); }
      const m = out.match(/cpu (\d+) mem (\d+)/);
      if (!m) die(`load.sh gave no numbers: ${out.trim()}`, 1);
      return { cpu: Number(m[1]), mem: Number(m[2]) };
    };
    const check = () => {
      const l = sample();
      const room = l.cpu < limits.maxCpu && l.mem < limits.maxMem;
      console.log(`cpu ${l.cpu}% (max ${limits.maxCpu}) mem ${l.mem}% (max ${limits.maxMem}): ${room ? "room" : "no room"}`);
      return room;
    };
    if (check()) break;
    if (!opt.wait) process.exit(3);
    const timer = setInterval(() => { if (check()) { clearInterval(timer); process.exit(0); } }, 15000);
    break;
  }
  case "say": {
    // Appends (never rewrites), so the board and Shepherd can both add lines without losing one.
    const text = args.join(" ").trim();
    if (!text) die("say [--from shepherd|you] [--task T-3] \"<text>\"");
    const from = opt.from === "you" ? "you" : "shepherd";
    const line = { at: now(), from, text, ...(typeof opt.task === "string" ? { task: opt.task } : {}) };
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(join(dirname(file), "chat.jsonl"), JSON.stringify(line) + "\n");
    break;
  }
  case "get": console.log(JSON.stringify(task(need(), args[0]), null, 2)); break;
  case "ls":
    for (const t of need().tasks) console.log(`${t.id}\t${t.stage}\t${t.status}\tloop ${t.loop}/${t.maxLoops}\t${t.title}`);
    break;
  default:
    die("commands: init add ready start end loop set finding ask answer room say get ls (see the top of shep.mjs)");
}
