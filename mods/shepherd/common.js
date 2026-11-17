// Shared by every Shepherd view: stages, colors and small helpers.

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme } from "herdr";

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

/** The main views, in the tab bar's order. */
export const VIEW_LIST = [["board", "Board"], ["pipeline", "Pipeline"], ["deps", "Dependencies"], ["needs", "Needs you"]];
export const VIEWS = VIEW_LIST.map(([k]) => k);
export const MAX_LOOPS = 3;
export const MONO = "JetBrains Mono";

export const GROUPS = [
  { key: "plan", label: "PLAN", stages: ["triage", "spec", "tickets"] },
  { key: "build", label: "BUILD LOOP · MAX 3", stages: ["implement", "review", "ci", "proof"] },
  { key: "ship", label: "SHIP", stages: ["merge", "done"] },
];
export const STAGES = {
  triage: { title: "Triage", skill: "/triage" },
  spec: { title: "Spec", skill: "/to-spec" },
  tickets: { title: "Tickets", skill: "/to-tickets" },
  implement: { title: "Implement", skill: "/implement" },
  review: { title: "Code review", skill: "/code-review" },
  ci: { title: "CI", skill: "ci" },
  proof: { title: "Proof", skill: "proof" },
  merge: { title: "Ready to merge", skill: "gh pr" },
  done: { title: "Done", skill: "" },
};

export const ORDER = GROUPS.flatMap((g) => g.stages);

/** Who works each stage, for the steer menu and comments. */
export const ROLE = { triage: "triager", spec: "planner", tickets: "planner", implement: "implementer", review: "reviewer", ci: "ci", proof: "qa", merge: "shepherd" };

/** A working task goes stuck past its stage's limit (minutes); workflow.json's stuckMinutes wins. */
export const STUCK_MIN = { triage: 40, spec: 120, tickets: 60, implement: 50, review: 25, ci: 20, proof: 20 };

/** Machine load limits (percent) when the workflow sets none. Same defaults as `shep room`
 *  (shepherd/bin/shep.mjs): change both together. */
export const LIMITS = { maxCpu: 80, maxMem: 85 };

/** Stuck uses ansi red (CONVENTIONS.md). */
export const stuckColor = (t) => t.ansi1;

/** Question kinds: chip label, glyph and group (for its color). */
export const KINDS = {
  triage: { label: "triage", icon: "⏷", group: "plan" },
  grill: { label: "grilling", icon: "?", group: "plan" },
  approve: { label: "approve tickets", icon: "☰", group: "plan" },
  ask: { label: "question", icon: "?", group: "build" },
  escalate: { label: "loops used up", icon: "↻", group: "build" },
  merge: { label: "ready to merge", icon: "⑃", group: "ship" },
};

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

/** Minutes as the design writes them: 45m, 2h, 1h 20m. */
export function mins(m) {
  m = Math.max(0, Math.round(m));
  if (m < 60) return `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`;
}

export const money = (n) => `$${(n ?? 0).toFixed(2)}`;
export const kTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n ?? 0));

/** A theme color with alpha, for tints (theme colors are #rrggbb). */
export const tint = (c, a) => (/^#[0-9a-f]{6}$/i.test(c) ? `${c}${Math.round(a * 255).toString(16).padStart(2, "0")}` : c);

/** A card's status color (palette() names); idle for anything else. */
export const statusColor = (t, s) => t[s] ?? t.idle;

/** One 6px square per allowed loop: done loops grey, the current one in the status color. */
export const loopDots = (t, c, radius = 1) => h_flex().gap(3).children(Array.from({ length: c.maxLoops }, (_, i) => {
  const n = i + 1;
  return div().size(6).rounded(radius).bg(n < c.loop ? t.muted : n === c.loop ? statusColor(t, c.status) : t.raised);
}));
