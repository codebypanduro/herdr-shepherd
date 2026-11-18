#!/usr/bin/env node
// shep: the only way Shepherd changes .herdr/shepherd/tasks.json (docs/CONVENTIONS.md).
// Every write is atomic (temp file + rename), so the board never reads half a file.
// The file is found from --tasks <path>, $SHEP_FILE, or <git root of cwd>/.herdr/shepherd/tasks.json.
//
//   shep init <space>
//   shep add --title "…" [--id X-1] [--source you] [--stage grill] [--max-loops 3]
//            [--blocked-by "T-4,T-5"] [--parent T-3] [--brief "…"]                       prints the id
//   shep ready                        queued tasks whose blockers are all done, one id per line
//   shep start <id> <stage> [--terminal t6] [--model M] [--agent claude|codex] [--skill /wayfinder] [--note "…"]
//                                     opens a stage run (status working); --skill: the skill it runs when not the stage's own;
//                                     --agent: the program the run's agent is (default claude; a gpt/codex model means codex)
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

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, appendFileSync, readdirSync, createReadStream, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { dirname, join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

// Tokens a stage run's agent used, from its own session log. Claude Code keeps `<config>/sessions/<pid>.json` with
// the session id and folder while it runs, and the session's messages in `<config>/projects/<folder with every
// non-alphanumeric as ->/<id>.jsonl`, with sub-agents in `<id>/subagents/*.jsonl`. The run's session is noted at
// `start --terminal` (`hc get` gives the agent's pid) and used at the end; only a run without one asks its terminal
// then (an address can be reused, so a saved session always wins). Addresses on another machine (`vps/t3`) are
// skipped: their pid means nothing in this machine's sessions folder. Each API response's usage is logged once per
// content block, so lines are counted once per message id. tokens = input + cache writes + output; cache reads (the
// same context read again on every turn) are kept apart in `usage.cacheRead` and not counted. Only lines after an
// earlier run of the same session ended count, so an agent kept across runs isn't counted twice. Logs are streamed
// a line at a time (they reach tens of MB). Nothing from the log is printed or kept but the counts, the model and the
// session id and folder. Codex agents are read from their own logs instead (codexTokens).
const NO_AGENT = new Set(["ci", "merge"]); // CI is a plain program; Ready to merge waits on the person.
const AGENTS = ["claude", "codex"];
/** The program a run's agent is: what `start --agent` said, else Codex for a gpt/codex model, else Claude Code.
 *  common.js agentOf guesses the same from agent and model, but gives null with neither (the board draws no mark
 *  then), where shep reads Claude Code's log. */
const agentOfRun = (run) => (AGENTS.includes(run.agent) ? run.agent : /codex|gpt/i.test(run.model ?? "") ? "codex" : "claude");
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

// A run's session as { id, cwd }; runs saved by the first 10e build kept a string id and `sessionCwd`.
const sessionOfRun = (run) => (typeof run.session === "string" ? { id: run.session, cwd: run.sessionCwd ?? null } : run.session ?? null);

function claudeSession(address) {
  if (!address || address.includes("/")) return null;
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

async function logUsage(files, after) {
  const seen = new Map();
  let model = null;
  for (const f of files) {
    try {
      const lines = createInterface({ input: createReadStream(f, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.includes('"usage"')) continue;
        let d;
        try { d = JSON.parse(line); } catch { continue; }
        const m = d?.message;
        if (d?.type !== "assistant" || !m?.usage || m.model === "<synthetic>") continue;
        if (after && !((Date.parse(d.timestamp ?? "") || 0) > after)) continue;
        seen.set(m.id ?? d.requestId ?? d.uuid, m.usage);
        if (!d.isSidechain && !f.includes("/subagents/")) model = m.model ?? model;
      }
    } catch {}
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

async function agentTokens(t, run) {
  // A run of its own (a terminal or a session) never borrows the task's terminal, which may be a later agent.
  const own = Boolean(run.terminal || run.session);
  const address = own ? run.terminal : t.terminal;
  const session = sessionOfRun(run) ?? claudeSession(address);
  if (!session) {
    return { why: !address ? "the run has no terminal"
      : address.includes("/") ? `${address} is on another machine` : `${address} isn't a running Claude Code agent` };
  }
  const log = sessionLog(session);
  if (!log) return { why: `no session log for ${session.id}` };
  const sub = join(log.dir, session.id, "subagents");
  let files = [join(log.dir, log.name)];
  try { files = files.concat(readdirSync(sub).filter((f) => f.endsWith(".jsonl")).map((f) => join(sub, f))); } catch {}
  const after = t.history.filter((r) => r !== run && sessionOfRun(r)?.id === session.id && r.end)
    .reduce((n, r) => Math.max(n, Date.parse(r.end) || 0), 0);
  const r = await logUsage(files, after);
  if (!r.messages) return { why: `no usage in ${session.id}'s log since the run began` };
  return { session, ...r };
}

// Codex keeps every session in `<CODEX_HOME or ~/.codex>/sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<id>.jsonl`; the first
// line is its `session_meta` (id, cwd, start time), and sub-agents are rollouts of their own with the root's
// `session_id`. Codex writes a rollout only when its first prompt goes in, which can be minutes after the agent started
// (behind a first-run screen). Nothing ties a rollout to a pid, so a run's session is a root rollout in the agent's
// folder that no run of any task already has: one whose first prompt names the task (`$<skill> <id>: …`, every brief
// does) before one that doesn't, then the first started after the run began, else the latest before. Planners of
// different tasks share the repo's folder; an implementer and a reviewer share a worktree but never run together.
// Each model response is a `token_usage_record` with its usage and `response_id`; a forked sub-agent repeats its
// parent's records, so they count once per response id. Codex's input_tokens include the cached ones: tokens = input
// − cached + cache writes + output (reasoning is part of output), the cached ones kept apart in `usage.cacheRead`, as
// for Claude. Rollouts from before token_usage_record carry only running totals (`token_count` events): then the run is
// the last total minus the total before it began.
const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");
const realDir = (d) => { try { return realpathSync(d); } catch { return d; } };

async function firstLine(f) {
  const lines = createInterface({ input: createReadStream(f, { encoding: "utf8" }), crlfDelay: Infinity });
  try { for await (const line of lines) return line; } catch {} finally { lines.close(); }
  return null;
}

/** Whether a rollout's first prompts (its first 200 lines) name the task as `<id>:`. */
async function namesTask(f, id) {
  const lines = createInterface({ input: createReadStream(f, { encoding: "utf8" }), crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of lines) {
      if (++n > 200) break;
      if (line.includes('"role":"user"') && line.includes(`${id}:`)) return true;
    }
  } catch {} finally { lines.close(); }
  return false;
}

/** Rollouts started between `from` and `to` (ms), as [{file, meta}], from the day folders around them. */
async function codexRollouts(from, to) {
  const root = join(codexHome(), "sessions");
  const out = [];
  const pad = (n) => String(n).padStart(2, "0");
  const days = new Set();
  // Folders are named by local date; a day either side covers time zones.
  for (let d = from - 86400000; d <= to + 86400000; d += 86400000) {
    const x = new Date(d);
    days.add(join(root, String(x.getFullYear()), pad(x.getMonth() + 1), pad(x.getDate())));
  }
  for (const dir of days) {
    let names = [];
    try { names = readdirSync(dir).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl")); } catch { continue; }
    for (const n of names) {
      const file = join(dir, n);
      let meta;
      try { const d = JSON.parse(await firstLine(file) ?? ""); if (d?.type === "session_meta") meta = d.payload; } catch {}
      const at = Date.parse(meta?.timestamp ?? "");
      if (meta?.id && at >= from && at <= to) out.push({ file, meta, at });
    }
  }
  return out;
}

/** A session's files from `all`: its root rollout first (codexUsage reads the model and running totals from it),
 *  then its sub-agents'. */
const sessionFiles = (all, root) => [root.file,
  ...all.filter((r) => r !== root && r.meta.session_id === String(root.meta.id) && r.meta.parent_thread_id).map((r) => r.file)];

async function codexSession(t, run, cwd, taken) {
  const start = Date.parse(run.start) || 0;
  const end = Date.parse(run.end ?? "") || Date.now();
  const all = await codexRollouts(start - 300000, end);
  const want = realDir(cwd);
  const roots = all.filter((r) => !r.meta.parent_thread_id && !r.meta.source?.subagent && r.meta.cwd
    && realDir(r.meta.cwd) === want && !taken.has(String(r.meta.id)));
  if (!roots.length) return null;
  const mine = [];
  for (const r of roots) if (await namesTask(r.file, t.id)) mine.push(r);
  const pool = mine.length ? mine : roots;
  const after = pool.filter((r) => r.at >= start - 60000).sort((a, b) => a.at - b.at);
  const root = after[0] ?? pool.sort((a, b) => b.at - a.at)[0];
  return { id: String(root.meta.id), cwd: root.meta.cwd, agent: "codex", files: sessionFiles(all, root) };
}

async function codexUsage(files, after) {
  const seen = new Map();
  let model = null, before = null, last = null;
  for (const f of files) {
    const sub = f !== files[0];
    try {
      const lines = createInterface({ input: createReadStream(f, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.includes('"token_usage_record"') && !line.includes('"token_count"') && !line.includes('"turn_context"')) continue;
        let d;
        try { d = JSON.parse(line); } catch { continue; }
        const p = d?.payload;
        const at = Date.parse(d?.timestamp ?? "") || 0;
        if (d?.type === "turn_context" && !sub && p?.model) { if (!after || at > after) model = p.model; continue; }
        if (d?.type === "token_usage_record" && p?.usage) {
          if (after && !(at > after)) continue;
          seen.set(p.response_id ?? `${f}:${p.turn_id}:${at}`, p.usage);
        } else if (!sub && p?.type === "token_count" && p.info?.total_token_usage) {
          if (after && !(at > after)) before = p.info.total_token_usage;
          else last = p.info.total_token_usage;
        }
      }
    } catch {}
  }
  let parts = [...seen.values()];
  // An older rollout without records: the running total's growth over the run.
  if (!parts.length && last) {
    const k = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens"];
    parts = [Object.fromEntries(k.map((x) => [x, Math.max(0, (last[x] ?? 0) - (before?.[x] ?? 0))]))];
  }
  const u = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  for (const x of parts) {
    const cached = x.cached_input_tokens ?? 0;
    u.input += Math.max(0, (x.input_tokens ?? 0) - cached);
    u.cacheRead += cached;
    u.cacheWrite += x.cache_write_input_tokens ?? 0;
    u.output += x.output_tokens ?? 0;
  }
  const messages = seen.size || (parts.length && (u.input + u.output) ? 1 : 0);
  return { usage: u, tokens: u.input + u.cacheWrite + u.output, model, messages };
}

/** A terminal's folder (`hc get`: where it runs now, else where it started). */
function terminalCwd(address) {
  if (!address || address.includes("/")) return null;
  try {
    const info = JSON.parse(execFileSync("hc", ["get", address], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }));
    return info.foreground?.cwd ?? info.cwd ?? null;
  } catch { return null; }
}

async function codexTokens(t, run) {
  const own = Boolean(run.terminal || run.session);
  const address = own ? run.terminal : t.terminal;
  if (address?.includes("/")) return { why: `${address} is on another machine` };
  // The folder noted at start (the agent may be gone by now), else its terminal's, else the task's worktree.
  const cwd = run.session?.cwd ?? run.cwd ?? terminalCwd(address) ?? t.worktree;
  if (!cwd) return { why: "the run has no folder to find its Codex session by" };
  // Sessions earlier runs (of every task) already have.
  const runs = state.tasks.flatMap((x) => x.history ?? []);
  const after = (id) => runs.filter((r) => r !== run && r.session?.id === id && r.end)
    .reduce((n, r) => Math.max(n, Date.parse(r.end) || 0), 0);
  const read = async (session) => {
    const r = await codexUsage(session.files, after(session.id));
    const { files: _files, ...kept } = session;
    return r.messages ? { session: kept, ...r } : null;
  };
  // A session already known: this run's, or an earlier run's by the same agent (a planner kept from Spec to Tickets
  // began its session before this run did). An address hc reused for a new agent lends a session with nothing new in
  // it: then the run's own is looked for as for any other.
  const known = run.session?.agent === "codex" ? run
    : t.history.filter((r) => r !== run && run.terminal && r.terminal === run.terminal && r.session?.agent === "codex").pop();
  if (known) {
    const all = await codexRollouts((Date.parse(known.start) || 0) - 300000, Date.parse(run.end ?? "") || Date.now());
    const root = all.find((r) => r.meta.id === known.session.id);
    const got = root && await read({ ...known.session, files: sessionFiles(all, root) });
    if (got) return got;
  }
  const taken = new Set(runs.filter((r) => r !== run && r.session?.agent === "codex").map((r) => String(r.session.id)));
  const session = await codexSession(t, run, cwd, taken);
  if (!session) return { why: `no Codex session in ${cwd} since the run began` };
  return await read(session) ?? { why: `no usage in Codex session ${session.id} since the run began` };
}

// Closes a run: its end, and the tokens its agent used unless given by hand. Returns what it recorded, for `end`
// to print; problems go to stderr.
async function closeRun(t, run, given) {
  run.end = now();
  delete run.cost;
  if (given !== undefined && !Number.isNaN(given)) { run.tokens = given; return null; }
  if (NO_AGENT.has(run.stage)) return null;
  const r = agentOfRun(run) === "codex" ? await codexTokens(t, run) : await agentTokens(t, run);
  // The folder a Codex run noted at start is only for finding its session here.
  delete run.cwd;
  if (r.why) {
    process.stderr.write(`shep: ${t.id} ${run.stage}: tokens not recorded: ${r.why}\n`);
    return null;
  }
  run.session = r.session;
  delete run.sessionCwd;
  run.tokens = r.tokens;
  run.usage = r.usage;
  if (!run.model && r.model) run.model = r.model;
  return `${t.id} ${run.stage}: ${r.tokens} tokens (${r.messages} messages)`;
}

/** The person's workflow ($SHEP_WORKFLOW or --workflow; workflow.json beside workflow.example.json wins, since
 *  Workflow settings writes it) and the space's orchestra.json (its keys win). */
function settings(opt) {
  const read = (f) => { try { return f && existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {}; } catch { return {}; } };
  const named = typeof opt.workflow === "string" ? opt.workflow : process.env.SHEP_WORKFLOW;
  const mine = named?.replace(/workflow\.example\.json$/, "workflow.json");
  return { wf: read(mine && existsSync(mine) ? mine : named), orch: read(join(dirname(dirname(file)), "orchestra.json")) };
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
    if (open) { await closeRun(t, open); open.result = open.result === "running" ? "pass" : open.result ?? "pass"; }
    t.stage = stage;
    delete t.wait;
    // Ready to merge waits on the person.
    t.status = stage === "done" ? "done" : stage === "merge" ? "blocked" : "working";
    if (opt.terminal) t.terminal = opt.terminal;
    if (stage !== "done") {
      const run = { loop: t.loop, stage, result: "running", note: opt.note ?? "",
        start: now(), end: null, model: opt.model ?? null, tokens: null };
      // The skill this run uses when the workflow picked another than the stage's own (Spec: /wayfinder for a big one).
      if (typeof opt.skill === "string" && opt.skill) run.skill = opt.skill;
      if (opt.agent !== undefined && !AGENTS.includes(opt.agent)) die(`--agent one of ${AGENTS.join(" ")}`);
      if (AGENTS.includes(opt.agent)) run.agent = opt.agent;
      else if (!NO_AGENT.has(stage) && opt.model && agentOfRun(run) === "codex") run.agent = "codex";
      // The run keeps its own terminal, so its tokens are read from that agent even after another takes the task's,
      // and its session now (`hc get`, up to 10 s; the start time is already taken), in case the agent is gone or its
      // address reused by the time the run ends.
      if (typeof opt.terminal === "string") {
        run.terminal = opt.terminal;
        // A Codex session can't be found by pid: note the agent's folder now, the session is matched at the end.
        if (!NO_AGENT.has(stage) && agentOfRun(run) === "codex") { const cwd = terminalCwd(opt.terminal); if (cwd) run.cwd = cwd; }
        else if (!NO_AGENT.has(stage)) { const session = claudeSession(opt.terminal); if (session) run.session = session; }
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
    const recorded = await closeRun(t, open, num(opt.tokens));
    if (recorded) console.log(recorded);
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
    const { wf, orch } = settings(opt);
    // Defaults match LIMITS in mods/shepherd/common.js: change both together.
    const limits = { maxCpu: 80, maxMem: 85, ...wf.limits, ...orch.limits };
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
    // Codex keeps its trust per repo root (a worktree counts as its repo) in config.toml; nothing to copy there,
    // only whether its agents will stop at "Trust this folder?" (PROMPT, Codex agents). And the skills the briefs of
    // the workflow's Codex stages name (`$code-review`): Codex finds them in its own skills folder, ~/.agents/skills
    // or the repo's .agents/skills; one missing means that agent works without it.
    const codexLines = () => {
      let toml = "";
      try { toml = readFileSync(join(codexHome(), "config.toml"), "utf8"); } catch { return []; }
      const trustedIn = (r) => {
        const lines = toml.split("\n");
        const at = lines.findIndex((l) => l.trim() === `[projects."${r}"]` || l.trim() === `[projects.'${r}']`);
        if (at < 0) return false;
        for (const l of lines.slice(at + 1)) {
          if (l.trim().startsWith("[")) return false;
          if (/^\s*trust_level\s*=\s*"trusted"/.test(l)) return true;
        }
        return false;
      };
      const out = [[repo, real(repo)].some(trustedIn) ? `codex: ${repo} is trusted` : `codex: ${repo} isn't trusted in Codex; a Codex agent will ask`];
      const { wf, orch } = settings(opt);
      const skills = new Set();
      for (const k of new Set([...Object.keys(wf.stages ?? {}), ...Object.keys(orch.stages ?? {})])) {
        const st = { ...wf.stages?.[k], ...orch.stages?.[k] };
        if (!st.model || agentOfRun({ agent: st.agent, model: st.model }) !== "codex") continue;
        for (const sk of [st.skill, st.big]) if (typeof sk === "string" && sk.startsWith("/")) skills.add(sk.slice(1));
      }
      const roots = [join(codexHome(), "skills"), join(homedir(), ".agents", "skills"), join(repo, ".agents", "skills"), join(repo, ".codex", "skills")];
      const missing = [...skills].filter((n) => !roots.some((d) => existsSync(join(d, n, "SKILL.md"))));
      if (missing.length) out.push(`codex: skills Codex can't find: ${missing.map((n) => "$" + n).join(" ")}; its agents work without them`);
      return out;
    };
    const done = (line) => { console.log(line); for (const c of codexLines()) console.log(c); };
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
    if (!from) { done(`not trusted: ${repo} isn't trusted in Claude; the agent will ask`); break; }
    const mine = projects[dir] ?? {};
    const add = {};
    for (const k of KEYS) {
      const v = projects[from][k];
      if (v === undefined || (Array.isArray(v) && !v.length && Array.isArray(mine[k]) && mine[k].length)) continue;
      if (JSON.stringify(mine[k]) !== JSON.stringify(v)) add[k] = v;
    }
    if (!Object.keys(add).length) { done(`trusted already: ${dir}`); break; }
    // Claude Code rewrites this file itself: read, change these keys, replace atomically.
    c.projects = { ...projects, [dir]: { ...mine, ...add } };
    const tmp = `${cfg}.shep-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(c, null, 2));
    renameSync(tmp, cfg);
    done(`trusted ${dir} as ${from}: ${Object.keys(add).join(", ")}`);
    break;
  }
  case "get": console.log(JSON.stringify(task(need(), args[0]), null, 2)); break;
  case "ls":
    for (const t of need().tasks) console.log(`${t.id}\t${t.stage}\t${t.status}\tloop ${t.loop}/${t.maxLoops}\t${t.title}`);
    break;
  default:
    die("commands: init add ready start end loop set finding ask answer room say get ls (see the top of shep.mjs)");
}
