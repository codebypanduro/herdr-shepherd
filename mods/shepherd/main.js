// Shepherd: one mod, several views. props.view picks the main view (board), props.panel a side
// role (detail, status). Slice 1: the board reads every terminal labelled `shepherd.stage` and
// groups it into the nine stage columns. No tasks.json yet.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, terminals, spaces, focused, theme, run, shared, setShared } from "herdr";

const GROUPS = [
  { key: "plan", label: "PLAN", stages: ["triage", "spec", "tickets"] },
  { key: "build", label: "BUILD LOOP · MAX 3", stages: ["implement", "review", "ci", "proof"] },
  { key: "ship", label: "SHIP", stages: ["merge", "done"] },
];
const STAGES = {
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
const MAX_LOOPS = 3;
const COL_MIN = 172;
const SELECTED = "shepherd.selected";
const FILTERS = "shepherd.filters";

/** A space's id as its own machine knows it (labels there omit the `<machine>/` prefix). */
const localId = (s) => (s?.machine && s.id.startsWith(`${s.machine}/`) ? s.id.slice(s.machine.length + 1) : s?.id);
const machineOf = (x) => (String(x.address).includes("/") ? String(x.address).split("/")[0] : null);

/** Group color by theme name: plan purple, build loop working, ship done (CONVENTIONS.md). */
const groupColor = (t, key) => (key === "plan" ? t.ansi5 : key === "build" ? t.working : t.done);

/** The board's status for a card: blocked = needs you. Plain programs report none: idle. */
const statusOf = (x, stage) => {
  if (stage === "done" || x.state === "finished") return "done";
  if (x.status === "blocked") return "blocked";
  if (x.status === "working") return "working";
  if (x.status === "done") return "done";
  return "idle";
};

function age(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`;
}

export default class Shepherd extends View {
  init(_props, cx) {
    // address -> { stage, since }: when a terminal was first seen in its current stage.
    this.since = {};
    // Time-in-stage text changes by the minute; nothing else here needs a timer.
    cx.timer.every(60000, (cx) => cx.notify());
  }

  render(cx) {
    const p = props() ?? {};
    if (p.panel === "status") return this.renderStatus();
    if (p.panel === "detail") return div().id("shepherd-detail").size_full().bg(theme().surface);
    return this.renderBoard(cx);
  }

  space() {
    const id = focused()?.space;
    return spaces().find((s) => s.id === id) ?? spaces().find((s) => s.active) ?? null;
  }

  /** Cards: terminals with a shepherd.stage label in the shown space (or with no space at all). */
  cards() {
    const space = this.space();
    const now = Date.now();
    const seen = new Set();
    const out = [];
    for (const x of terminals()) {
      const l = x.labels ?? {};
      const stage = l["shepherd.stage"];
      if (!STAGES[stage] || l["herdr.role"] === "shepherd") continue;
      if (x.state === "finished" && stage !== "done") continue;
      const sp = l["herdr.space"];
      if (sp && (sp !== localId(space) || machineOf(x) !== (space?.machine ?? null))) continue;
      seen.add(x.address);
      const prev = this.since[x.address];
      if (!prev || prev.stage !== stage) {
        this.since[x.address] = { stage, since: prev ? now : (x.created_ms ?? now) };
      }
      const loop = Math.max(1, parseInt(l["shepherd.loop"] ?? "1", 10) || 1);
      out.push({
        address: x.address,
        id: l["shepherd.task"] ?? x.name ?? x.address,
        title: l["shepherd.title"] ?? x.title ?? x.name ?? (x.argv ?? []).join(" "),
        stage,
        loop,
        status: statusOf(x, stage),
        note: x.report ?? (x.argv ?? []).join(" "),
        since: this.since[x.address].since,
      });
    }
    for (const a of Object.keys(this.since)) if (!seen.has(a)) delete this.since[a];
    return out.sort((a, b) => a.since - b.since);
  }

  renderBoard() {
    const t = theme();
    const space = this.space();
    const all = this.cards();
    const filters = shared(FILTERS) ?? [];
    const shown = filters.length ? all.filter((c) => filters.includes(c.status)) : all;
    const selected = shared(SELECTED);
    const now = Date.now();
    const statusColor = (s) => t[s] ?? t.idle;

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
        .child(div().size(6).rounded(3).bg(statusColor(s)))
        .child(div().text_color(on ? t.foreground : t.muted).child(`${n} ${label}`));
    };

    const header = h_flex().h(32).flex_none().px(12).gap(8).items_center()
      .border_b(1).border_color(t.border)
      .child(div().font_semibold().text_color(t.foreground).child("pipeline"))
      .child(div().text_color(t.dim).child(`${space?.name ?? "—"} · ${all.length} task${all.length === 1 ? "" : "s"}`))
      .child(div().flex_1())
      .child(filter("working", "working"))
      .child(filter("blocked", "need you"))
      .child(filter("done", "done"))
      .when(filters.length > 0, (el) => el.child(
        div().id("filter-clear").px(7).h(22).flex().items_center().rounded(5).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => setShared(FILTERS, []))
          .child("✕ clear")));

    const loopDots = (c) => h_flex().gap(3).children(Array.from({ length: MAX_LOOPS }, (_, i) => {
      const n = i + 1;
      const color = n < c.loop ? t.muted : n === c.loop ? statusColor(c.status) : t.raised;
      return div().size(6).rounded(1).bg(color);
    }));

    const card = (c) => {
      const isSel = selected === c.address;
      const blocked = c.status === "blocked";
      const border = isSel ? t.accent : blocked ? t.blocked : t.border;
      const inBuild = GROUPS[1].stages.includes(c.stage);
      return v_flex().id(`card-${c.address}`).flex_none().gap(6).p(10).rounded(6)
        .bg(blocked ? t.raised : t.surface).border(1).border_color(border)
        .hover((s) => s.border_color(isSel ? t.accent : t.input))
        .on_click(() => setShared(SELECTED, isSel ? null : c.address))
        .child(h_flex().gap(6).items_center()
          .child(div().font_family("JetBrains Mono").text_size(11).text_color(t.muted).child(c.id))
          .child(div().flex_1().min_w(0).truncate().font_family("JetBrains Mono").text_size(10.5).text_color(t.dim)
            .child(STAGES[c.stage].skill))
          .when(inBuild, (el) => el.child(loopDots(c)))
          .child(div().id(`peek-${c.address}`).px(3).rounded(4).text_color(t.dim)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("terminal.peek", { terminal: c.address }); })
            .child("⋯")))
        .child(div().text_size(13).line_height(1.35).text_color(t.foreground).child(c.title))
        .child(h_flex().gap(6).items_center()
          .child(c.status === "working"
            ? div().size(6).rounded(3).bg(t.working).loop("opacity", { from: 0.35, to: 1, period: 1200 })
            : div().size(6).rounded(3).bg(statusColor(c.status)))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(c.note))
          .child(div().font_family("JetBrains Mono").text_size(10.5).text_color(t.dim).child(age(now - c.since))));
    };

    const column = (stage, group, first) => {
      const cards = shown.filter((c) => c.stage === stage);
      const color = groupColor(t, group.key);
      return v_flex().id(`col-${stage}`).flex_1().min_w(COL_MIN).gap(8)
        .child(div().h(14).text_size(10.5).font_semibold().text_color(color).child(first ? group.label : ""))
        .child(h_flex().h(24).items_center().justify_between().border_b(2).border_color(color)
          .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(STAGES[stage].title))
          .child(div().text_size(11).text_color(t.dim).child(String(cards.length))))
        .child(v_flex().id(`cards-${stage}`).flex_1().min_h(0).gap(8).overflow_y_scrollbar()
          .when(cards.length === 0, (el) => el.child(
            div().h(40).flex().items_center().justify_center().rounded(6).border(1).border_dashed()
              .border_color(t.border).text_size(11).text_color(t.dim).child("empty")))
          .children(cards.map(card)));
    };

    const columns = GROUPS.flatMap((g) => g.stages.map((s, i) => column(s, g, i === 0)));

    return v_flex().id("shepherd-board").size_full().bg(t.surface).text_size(12).text_color(t.foreground)
      .child(header)
      .child(div().id("board-scroll").flex_1().min_h(0).overflow_x_scrollbar()
        .child(h_flex().h_full().min_w(COL_MIN * 9 + 8 * 10 + 24).px(12).py(10).gap(10).items_stretch()
          .children(columns)));
  }

  renderStatus() {
    const t = theme();
    return h_flex().id("shepherd-status").size_full().px(12).gap(14).items_center().bg(t.chrome)
      .border_t(1).border_color(t.border)
      .font_family("JetBrains Mono").text_size(11).text_color(t.dim)
      .child("herdr-core · local")
      .child(`max loops ${MAX_LOOPS}`)
      .child(div().flex_1())
      .child("mods/shepherd");
  }
}
