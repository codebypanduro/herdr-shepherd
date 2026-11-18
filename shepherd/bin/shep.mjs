#!/usr/bin/env node
// shep: the only way Shepherd changes .herdr/shepherd/tasks.json (docs/CONVENTIONS.md).
// Every write is atomic (temp file + rename), so the board never reads half a file.
// The file is found from --tasks <path>, $SHEP_FILE, or <git root of cwd>/.herdr/shepherd/tasks.json.
//
//   shep init <space>
//   shep add --title "…" [--id X-1] [--source you] [--stage grill] [--max-loops 3]
//            [--blocked-by "T-4,T-5"] [--parent T-3] [--brief "…"]                       prints the id
//   shep ready                        queued tasks whose blockers are all done, one id per line
//   shep start <id> <stage> [--terminal t6] [--model M] [--note "…"]      opens a stage run (status working)
//   shep end <id> pass|fail|ask [--note "…"] [--tokens N]                 closes the open stage run and records the
//                                     tokens its agent used, read from the agent's own session log (see agentTokens;
//                                     --tokens only overrides that by hand)
//   shep loop <id>                    next build loop; exits 2 when maxLoops is used up (ask the person)
//   shep set <id> key=value …         stage status terminal branch worktree pr prUrl proof summary title brief blockedBy
//                                     loop maxLoops
//                                     wait ("waiting for room on <machine>": the card's note until start clears it)
//   shep finding <id> add --text "…" [--file f] [--line n]                prints the finding id
//   shep finding <id> <fid> open|fixing|resolved
//   shep ask <id> --text "…" [--kind ask|escalate|merge|triage|grill|approve] [--from "t5 implementer"]
//            [--options "One more loop|Park it|I'll take it"] [--recommended "One more loop"]   prints q1, q2, …
//            [--why "one line: why the recommended one"]
//            grilling: --kind grill --question <file.json>   {q, options:[…], recommended, why}: one question at a
//                      time, with 2+ options and a recommended one;
//                      the file fills --text, --options, --recommended and --why (and spares quoting a "|")
//            approval: --kind approve --tickets <file.json>             [{key, title, brief, blockedBy:[keys]}]
//   shep answer <qid> "<answer>"      records the person's answer; the question leaves Needs you
//   shep room [--wait] [--workflow f] is this machine under the workflow's CPU and memory limits? exit 0 yes, 3 no,
//                                     1 if load.sh failed; --wait: check every 15 s until there is room (run it in
//                                     an hc terminal). It measures the machine shep runs on: Shepherd's, which is the
//                                     space's machine when start.sh ran in a terminal of that space.
//   shep say [--from shepherd|you] [--task T-3] "<text>"   a line of the History (chat.jsonl beside tasks.json)
//   shep get <id> | shep ls

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const STAGES = ["triage", "grill", "spec", "tickets", "implement", "review", "ci", "proof", "merge", "done"];
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

// Tokens a stage run's agent used, from its own session log. The run's terminal (`start --terminal`) is asked for
// its process (`hc get`); Claude Code keeps `<config>/sessions/<pid>.json` with the session id and folder while it
// runs, and the session's messages in `<config>/projects/<folder with every non-alphanumeric as ->/<id>.jsonl`, with
// sub-agents in `<id>/subagents/*.jsonl`. Each API response's usage is logged once per content block, so lines are
// counted once per message id. tokens = input + cache writes + output; cache reads (the same context read again on
// every turn) are kept apart in `usage.cacheRead` and not counted. Only lines after an earlier run of the same
// session ended count, so an agent kept across runs isn't counted twice. Nothing from the log is printed or kept
// but the counts, the model and the session id. Codex agents (10j) aren't read yet.
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

function claudeSession(address) {
  let info;
  try {
    info = JSON.parse(execFileSync("hc", ["get", address], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }));
  } catch { return null; }
  for (const pid of [info.foreground?.pid, info.pid].filter(Boolean)) {
    try {
      const s = JSON.parse(readFileSync(join(claudeHome(), "sessions", `${pid}.json`), "utf8"));
      if (s.sessionId) return { id: String(s.sessionId), cwd: s.cwd ?? null };
    } catch {}
  }
  return null;
}

function sessionLog(session) {
  const projects = join(claudeHome(), "projects");
  const name = `${session.id}.jsonl`;
  if (session.cwd) {
    const dir = join(projects, session.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    if (existsSync(join(dir, name))) return { dir, name };
  }
  // A long folder name is shortened by Claude Code; look for the session in every project instead.
  try {
    for (const d of readdirSync(projects)) if (existsSync(join(projects, d, name))) return { dir: join(projects, d), name };
  } catch {}
  return null;
}

function logUsage(files, after) {
  const seen = new Map();
  let model = null;
  for (const f of files) {
    let text;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.includes('"usage"')) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      const m = d?.message;
      if (d?.type !== "assistant" || !m?.usage || m.model === "<synthetic>") continue;
      if (after && !((Date.parse(d.timestamp ?? "") || 0) > after)) continue;
      seen.set(m.id ?? d.requestId ?? d.uuid, m.usage);
      if (!d.isSidechain && !f.includes("/subagents/")) model = m.model ?? model;
    }
  }
  const u = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  for (const x of seen.values()) {
    u.input += x.input_tokens ?? 0;
    u.cacheWrite += x.cache_creation_input_tokens ?? 0;
    u.cacheRead += x.cache_read_input_tokens ?? 0;
    u.output += x.output_tokens ?? 0;
  }
  return { usage: u, tokens: u.input + u.cacheWrite + u.output, model, messages: seen.size };
}

function agentTokens(t, run) {
  const address = run.terminal ?? t.terminal;
  const session = (address && claudeSession(address)) ?? (run.session ? { id: run.session, cwd: run.sessionCwd ?? null } : null);
  if (!session) return { why: address ? `${address} isn't a running Claude Code agent` : "the run has no terminal" };
  const log = sessionLog(session);
  if (!log) return { why: `no session log for ${session.id}` };
  const sub = join(log.dir, session.id, "subagents");
  let files = [join(log.dir, log.name)];
  try { files = files.concat(readdirSync(sub).filter((f) => f.endsWith(".jsonl")).map((f) => join(sub, f))); } catch {}
  const after = t.history.filter((r) => r !== run && r.session === session.id && r.end)
    .reduce((n, r) => Math.max(n, Date.parse(r.end) || 0), 0);
  return { session, ...logUsage(files, after) };
}

// Closes a run: its end, and the tokens its agent used unless given by hand.
function closeRun(t, run, given) {
  run.end = now();
  delete run.cost;
  if (given !== undefined && !Number.isNaN(given)) { run.tokens = given; return; }
  // CI is a plain program and Ready to merge waits on the person: no agent, no tokens.
  if (run.stage === "ci" || run.stage === "merge") return;
  const r = agentTokens(t, run);
  if (r.why) {
    if (run.terminal ?? t.terminal) process.stderr.write(`shep: ${t.id} ${run.stage}: tokens not recorded: ${r.why}\n`);
    return;
  }
  run.session = r.session.id;
  if (r.session.cwd) run.sessionCwd = r.session.cwd;
  run.tokens = r.tokens;
  run.usage = r.usage;
  if (!run.model && r.model) run.model = r.model;
  console.log(`${t.id} ${run.stage}: ${r.tokens} tokens (${r.messages} messages)`);
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
    const stage = opt.stage ?? "grill";
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
    if (open) { closeRun(t, open); open.result = open.result === "running" ? "pass" : open.result ?? "pass"; }
    t.stage = stage;
    delete t.wait;
    // Ready to merge waits on the person.
    t.status = stage === "done" ? "done" : stage === "merge" ? "blocked" : "working";
    if (opt.terminal) t.terminal = opt.terminal;
    if (stage !== "done") {
      const run = { loop: t.loop, stage, result: "running", note: opt.note ?? "",
        start: now(), end: null, model: opt.model ?? null, tokens: null };
      // The run keeps its own terminal, so its tokens are read from that agent even after another takes the task's.
      if (typeof opt.terminal === "string") {
        run.terminal = opt.terminal;
        // Its session now, in case the agent is gone by the time the run ends.
        const session = claudeSession(opt.terminal);
        if (session) { run.session = session.id; if (session.cwd) run.sessionCwd = session.cwd; }
      }
      t.history.push(run);
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
    closeRun(t, open, num(opt.tokens));
    open.result = result;
    if (opt.note) open.note = opt.note;
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
    const kind = opt.kind ?? "ask";
    if (!KINDS.includes(kind)) die(`kind one of ${KINDS.join(" ")}`);
    if (opt.questions) die("--questions is gone: grilling asks one question at a time with --question <file.json>");
    // --question <file.json>: one question {q, options, recommended, why}; flags given beside it win.
    let one = {};
    if (typeof opt.question === "string") {
      try { one = JSON.parse(readFileSync(opt.question, "utf8")); } catch (e) { die(`--question ${opt.question}: ${e.message}`); }
      if (!one || typeof one !== "object" || Array.isArray(one) || typeof one.q !== "string" || !one.q.trim())
        die("--question must be a JSON object with q (and options, recommended, why)");
      if (one.options != null && (!Array.isArray(one.options) || one.options.some((o) => typeof o !== "string")))
        die("--question: options must be a list of strings");
    }
    const text = typeof opt.text === "string" ? opt.text : one.q;
    if (!text) die("ask <id> --text \"…\" (or --question <file.json>)");
    state.questions = state.questions ?? [];
    const n = state.questions.reduce((m, q) => Math.max(m, parseInt(String(q.id).slice(1), 10) || 0), 0) + 1;
    const options = typeof opt.options === "string" ? opt.options.split("|").map((x) => x.trim()).filter(Boolean)
      : (one.options ?? []).map((x) => x.trim()).filter(Boolean);
    const recommended = typeof opt.recommended === "string" && opt.recommended.trim() ? opt.recommended.trim()
      : typeof one.recommended === "string" && one.recommended.trim() ? one.recommended.trim() : null;
    if (kind === "grill" && (options.length < 2 || !recommended)) die("a grilling question needs 2 or more options and a recommended one");
    if (recommended && options.length && !options.includes(recommended)) die("--recommended must be one of --options");
    const why = typeof opt.why === "string" ? opt.why : typeof one.why === "string" && one.why.trim() ? one.why.trim() : null;
    let tickets;
    if (typeof opt.tickets === "string") {
      try { tickets = JSON.parse(readFileSync(opt.tickets, "utf8")); } catch (e) { die(`--tickets ${opt.tickets}: ${e.message}`); }
      if (!Array.isArray(tickets) || !tickets.length) die("--tickets must be a non-empty JSON array");
    }
    if (kind === "approve" && !tickets) die("--kind approve needs --tickets <file.json>");
    for (const k of tickets ?? []) if (!k.key || !k.title) die("each ticket needs key and title");
    const q = { id: `q${n}`, task: t.id, kind, from: typeof opt.from === "string" ? opt.from : "shepherd",
      text, options, recommended, asked: now(), answer: null, answered: null };
    if (why) q.why = why;
    // The asker's file name (grill-<n>): the mods send the answer straight to the asker as "<ref> answer: …".
    if (typeof opt.question === "string") q.ref = basename(opt.question).replace(/\.json$/, "");
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
    // workflow.json beside workflow.example.json wins: Workflow settings writes it (mods/shepherd/settings.js).
    const named = typeof opt.workflow === "string" ? opt.workflow : process.env.SHEP_WORKFLOW;
    const mine = named?.replace(/workflow\.example\.json$/, "workflow.json");
    const wf = mine && existsSync(mine) ? mine : named;
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
  case "trust": {
    // trust <worktree>: a task worktree is a new folder to Claude Code, so its agent would stop at
    // "Do you trust this folder?" and at "New MCP server found" again. Copy the person's own answers
    // (~/.claude.json projects[…]: trust and the project MCP choices) from its repo, else from another
    // worktree of it in the same folder. Never decides anything they haven't: without an earlier
    // answer the agent asks.
    const wt = args[0];
    if (!wt || !existsSync(wt)) die("trust <worktree folder>");
    const real = (d) => { try { return execFileSync("realpath", [d], { encoding: "utf8" }).trim(); } catch { return d; } };
    const dir = real(wt);
    let repo;
    try {
      repo = dirname(execFileSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());
    } catch { die(`trust: ${wt} isn't a git worktree`); }
    const cfg = process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : join(homedir(), ".claude.json");
    let c;
    try { c = JSON.parse(readFileSync(cfg, "utf8")); } catch (e) { die(`trust: can't read ${cfg}: ${e.message}`); }
    const projects = c.projects ?? {};
    const KEYS = ["hasTrustDialogAccepted", "enabledMcpjsonServers", "disabledMcpjsonServers", "enableAllProjectMcpServers"];
    const answered = (k) => projects[k]?.hasTrustDialogAccepted === true;
    const siblings = dirname(dir);
    // The repo's answers first; then the most complete sibling worktree's (MCP answers are made there too).
    const from = [repo, real(repo)].find(answered)
      ?? Object.keys(projects).filter((k) => k !== dir && dirname(k) === siblings && answered(k))
        .sort((x, y) => KEYS.filter((k) => projects[y][k] !== undefined).length - KEYS.filter((k) => projects[x][k] !== undefined).length)[0];
    if (!from) { console.log(`not trusted: ${repo} isn't trusted in Claude; the agent will ask`); break; }
    const mine = projects[dir] ?? {};
    const add = {};
    for (const k of KEYS) {
      const v = projects[from][k];
      if (v === undefined || (Array.isArray(v) && !v.length && Array.isArray(mine[k]) && mine[k].length)) continue;
      if (JSON.stringify(mine[k]) !== JSON.stringify(v)) add[k] = v;
    }
    if (!Object.keys(add).length) { console.log(`trusted already: ${dir}`); break; }
    // Claude Code rewrites this file itself: read, change these keys, replace atomically.
    c.projects = { ...projects, [dir]: { ...mine, ...add } };
    const tmp = `${cfg}.shep-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(c, null, 2));
    renameSync(tmp, cfg);
    console.log(`trusted ${dir} as ${from}: ${Object.keys(add).join(", ")}`);
    break;
  }
  case "get": console.log(JSON.stringify(task(need(), args[0]), null, 2)); break;
  case "ls":
    for (const t of need().tasks) console.log(`${t.id}\t${t.stage}\t${t.status}\tloop ${t.loop}/${t.maxLoops}\t${t.title}`);
    break;
  default:
    die("commands: init add ready start end loop set finding ask answer room say get ls (see the top of shep.mjs)");
}
