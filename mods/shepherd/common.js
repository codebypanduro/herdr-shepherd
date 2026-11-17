// Shared by every Shepherd view: stages, colors and small helpers.

export const TASKS = ".herdr/shepherd/tasks.json";
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
