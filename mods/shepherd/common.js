// Shared by every Shepherd view: stages, colors and small helpers.

import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, shared, setShared } from "herdr";

/** The theme, with the board's status colors on the design's hues: working blue, needs-you amber,
 *  done green. Herdr's own status colors differ by theme (graphite: working yellow, blocked red,
 *  done blue); the ANSI colors keep these hues in every theme, light and dark. */
export function palette() {
  const t = theme();
  return { ...t, working: t.ansi4, blocked: t.ansi3, done: t.ansi2 };
}

export const TASKS = ".herdr/shepherd/tasks.json";
export const CHAT = ".herdr/shepherd/chat.jsonl"; // History: one {at, from, text, task?} per line (shep say)

/** Shared-state keys every copy reads. */
export const VIEW = "shepherd.view";
export const SELECTED = "shepherd.selected";
export const DIGEST_OPEN = "shepherd.digestOpen"; // the open digest's overlay id
export const HISTORY_OPEN = "shepherd.historyOpen"; // the open History's overlay id
export const STEER_OPEN = "shepherd.steerOpen"; // the open steer menu's overlay id (no peek over it)
export const TAB = "shepherd.detailTab"; // the task detail's open tab
export const FILTERS = "shepherd.filters"; // the board and Pipeline's status filters: ["working", "blocked", "done"]
export const PENDING = "shepherd.pending"; // "<repo key>#<question id>" answered here that tasks.json hasn't caught up with
export const REMOTE_MS = 30000; // a space on another machine that isn't shown is read this often (All spaces, the sidebar's badges)
export const SCOPE = "shepherd.scope"; // "all": the board, Needs you, History, bar, tab bar and digest read every Shepherd space

/** A task or question across spaces: "<space id>/<id>" (task ids hold no "/"; remote space ids do,
 *  so the last one splits). A bare id (no "/") means the copy's own space. */
export const refOf = (sid, id) => (sid ? `${sid}/${id}` : String(id));
export function parseRef(ref) {
  const s = String(ref ?? ""), i = s.lastIndexOf("/");
  return i < 0 ? { sid: null, id: s } : { sid: s.slice(0, i), id: s.slice(i + 1) };
}

/** The task detail's tabs, in order (1–6 switch them). */
export const TABS = ["overview", "review", "changes", "files", "proof", "terminal"];
/** The open task's tab (shared, so the board's 1–6 keys switch it too). */
export const currentTab = () => (TABS.includes(shared(TAB)) ? shared(TAB) : "overview");

/** A terminal screen as lines: ANSI (CSI, OSC, charset selects, 2-byte escapes) and \r stripped,
 *  trailing spaces and the blank rows under the last text gone. */
export function screenLines(text) {
  const lines = String(text ?? "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()*+][0-9A-Za-z]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r/g, "")
    .split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines;
}

/** The main views, in the tab bar's order. */
export const VIEW_LIST = [["board", "Board"], ["pipeline", "Pipeline"], ["deps", "Dependencies"], ["needs", "Needs you"]];
export const VIEWS = VIEW_LIST.map(([k]) => k);
export const MAX_LOOPS = 3;
export const MONO = "JetBrains Mono";

export const GROUPS = [
  { key: "plan", label: "PLAN", stages: ["triage", "grill", "spec", "tickets"] },
  { key: "build", label: "BUILD LOOP", stages: ["implement", "review", "ci", "proof"] },
  { key: "ship", label: "SHIP", stages: ["merge", "done"] },
];
export const STAGES = {
  triage: { title: "Triage", skill: "/triage" },
  grill: { title: "Grill", skill: "/grill-with-docs" },
  spec: { title: "Spec", skill: "/to-spec" },
  tickets: { title: "Tickets", skill: "/to-tickets" },
  implement: { title: "Implement", skill: "/implement" },
  review: { title: "Code review", skill: "/code-review" },
  ci: { title: "CI", skill: "" },
  proof: { title: "Proof", skill: "" },
  merge: { title: "Ready to merge", skill: "" },
  done: { title: "Done", skill: "" },
};

export const ORDER = GROUPS.flatMap((g) => g.stages);

/** A group's label over its first column: the build loop's carries the workflow's max loops. */
export const groupLabel = (g, maxLoops) => (g.key === "build" ? `${g.label} · MAX ${maxLoops}` : g.label);

/** Who works each stage, for the steer menu and comments. */
export const ROLE = { triage: "triager", grill: "griller", spec: "planner", tickets: "planner", implement: "implementer", review: "reviewer", ci: "ci", proof: "qa", merge: "shepherd" };

/** A working task goes stuck past its stage's limit (minutes); workflow.json's stuckMinutes wins.
 *  The clock restarts at the person's last answer in the stage (Grill waits on them between questions). */
export const STUCK_MIN = { triage: 40, grill: 30, spec: 120, tickets: 60, implement: 50, review: 25, ci: 20, proof: 20 };

/** Machine load limits (percent) when the workflow sets none. Same defaults as `shep room`
 *  (shepherd/bin/shep.mjs): change both together. */
export const LIMITS = { maxCpu: 80, maxMem: 85 };

/** Stuck uses ansi red (CONVENTIONS.md). */
export const stuckColor = (t) => t.ansi1;

/** Question kinds: chip label, icon (a drawn one from icons/, else a glyph) and group (for its color). */
export const KINDS = {
  triage: { label: "triage", svg: "kind-triage", group: "plan" },
  grill: { label: "grilling", icon: "?", group: "plan" },
  approve: { label: "approve tickets", svg: "kind-tickets", group: "plan" },
  ask: { label: "question", icon: "?", group: "build" },
  escalate: { label: "loops used up", icon: "↻", group: "build" },
  merge: { label: "ready to merge", svg: "kind-merge", group: "ship" },
};

/** A question kind's 11px icon in `color`: the design's funnel, list and merge drawings, else its glyph. */
export const kindIcon = (kind, color) => (kind.svg
  ? svg(`mods/shepherd/icons/${kind.svg}.svg`).size(11).flex_none().text_color(color)
  : div().w(11).flex_none().flex().justify_center().font_family(MONO).text_size(11).line_height(1).child(kind.icon));

/** Group color by theme name: plan purple, build loop working, ship done (CONVENTIONS.md). */
export const groupColor = (t, key) => (key === "plan" ? t.ansi5 : key === "build" ? t.working : t.done);
export const stageGroup = (stage) => GROUPS.find((g) => g.stages.includes(stage))?.key ?? "plan";

/** A space's id as its own machine knows it (labels there omit the `<machine>/` prefix). */
export const localId = (s) => (s?.machine && s.id.startsWith(`${s.machine}/`) ? s.id.slice(s.machine.length + 1) : s?.id);
export const machineOf = (x) => (String(x.address).includes("/") ? String(x.address).split("/")[0] : null);

export function age(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`;
}

/** An ISO time as "just now" (under a minute) or "<age> ago"; "" without one. */
export function ago(at, now = Date.now()) {
  const x = Date.parse(at ?? "");
  return x ? (now - x < 60000 ? "just now" : `${age(now - x)} ago`) : "";
}

/** Text for use inside a RegExp, as is. */
export const escRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Minutes as the design writes them: 45m, 2h, 1h 20m. */
export function mins(m) {
  m = Math.max(0, Math.round(m));
  if (m < 60) return `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`;
}

/** Tokens of stage runs (null until runs record them), and of a whole task. */
export const runTokens = (runs) => (runs ?? []).reduce((n, r) => n + (r.tokens ?? 0), 0);
export const taskTokens = (task) => runTokens(task?.history);

export const kTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n ?? 0));

/** A question's one-click answer: Merge / Approve for those kinds, else its recommended answer.
 *  A (accept) and the toast's button both use it; the toast leaves grilling questions out (design). */
export const recAnswer = (q) => (q?.kind === "merge" ? "Merge" : q?.kind === "approve" ? "Approve" : q?.recommended ?? null);

/** A question's id in shared shepherd.pending / shepherd.answered: "<repo key>#<question id>". */
export const pendingId = (key, qid) => `${key}#${qid}`;

/** A theme color with alpha, for tints (theme colors are #rrggbb). */
export const tint = (c, a) => (/^#[0-9a-f]{6}$/i.test(c) ? `${c}${Math.round(a * 255).toString(16).padStart(2, "0")}` : c);

/** A card's status color (palette() names); idle for anything else. */
export const statusColor = (t, s) => t[s] ?? t.idle;

/** One 6px square per allowed loop: done loops grey, the current one in the status color. */
export const loopDots = (t, c, radius = 1) => h_flex().gap(3).children(Array.from({ length: c.maxLoops }, (_, i) => {
  const n = i + 1;
  return div().size(6).rounded(radius).bg(n < c.loop ? t.muted : n === c.loop ? statusColor(t, c.status) : t.raised);
}));

/** One color per state, for every place the detail shows one: run results, finding states, review
 *  cells and where the task is now. Pass/fixed/done green, fail/found/stuck red, running/fixing
 *  blue, open/waiting amber; anything else `fallback`. */
export function stateColor(t, s, fallback = t.muted) {
  if (["pass", "approved", "resolved", "fixed", "done"].includes(s)) return t.done;
  if (["fail", "found", "stuck"].includes(s)) return t.ansi1;
  if (["running", "fixing", "working"].includes(s)) return t.working;
  if (["open", "still open", "waiting", "ask"].includes(s)) return t.blocked;
  return fallback;
}

/** A section heading: "COMMENTS", "SHEPHERD SUMMARY", "CHECKS · …" (11px, dim). */
export const sectionHeading = (t, text) => div().text_size(11).text_color(t.dim).child(text);

/** "1 file", "3 files". */
export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Seconds (or a string kept as is) as the design's m:ss: 0:23, 2:14; "" for nothing. */
export function clock(x) {
  if (typeof x === "string") return x;
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0) return "";
  const s = Math.round(x);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The m:ss between two ISO times, "" when either is missing. */
export const spanClock = (start, end) => {
  const a = Date.parse(start ?? ""), b = Date.parse(end ?? "");
  return a && b ? clock((b - a) / 1000) : "";
};

/** The status filters (● N working, ● N need you, ● N done, ✕ clear) after a view's header; the
 *  board and Pipeline share them (shared FILTERS). `all`: the view's cards before filtering. */
export function statusFilters(m, t, all, header) {
  const filters = shared(FILTERS) ?? [];
  const toggle = (s) => {
    const f = shared(FILTERS) ?? [];
    setShared(FILTERS, f.includes(s) ? f.filter((x) => x !== s) : [...f, s]);
  };
  const filter = (s, label) => {
    const n = all.filter((c) => c.status === s).length;
    const on = filters.includes(s);
    return h_flex().id(`filter-${s}`).gap(5).items_center().px(7).h(22).rounded(5)
      .when(on, (el) => el.bg(t.selected))
      .hover((el) => el.bg(t.hover))
      .on_click(() => toggle(s))
      .child(div().size(6).rounded(3).bg(statusColor(t, s)))
      .child(div().text_color(on ? t.foreground : t.muted).child(`${n} ${label}`));
  };
  return header
    .child(filter("working", "working"))
    .child(filter("blocked", "need you"))
    .child(filter("done", "done"))
    .when(filters.length > 0, (el) => el.child(
      div().id("filter-clear").px(7).h(22).flex().items_center().rounded(5).text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => setShared(FILTERS, []))
        .child("✕ clear")));
}

/** What runs Proof, for its heading and the PR card's row: nothing by hand when the workflow's
 *  `stages.proof.headless` is off, else its browser, else "headless browser". */
export const proofBrowser = (proof) => (proof?.headless === false ? "run by hand" : String(proof?.browser || "headless browser"));
