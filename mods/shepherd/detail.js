// Task detail: header, worktree line and six tabs (Overview, Review, Changes, Files, Proof, Terminal).
// Changes and Files come from git in the task's worktree (see git.js), Terminal mirrors the task's
// agent (term.js); the rest is tasks.json.

import { div, image } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { run, setShared } from "herdr";
import { STAGES, MONO, ROLE, SELECTED, TAB, TABS, currentTab, groupColor, stageGroup, age, ago, escRe, palette, tint, kTokens, mins, runTokens, stateColor, sectionHeading } from "./common.js";
import { renderChanges, renderFiles, fileIcon, worktreeOf } from "./git.js";
import { renderPrCard, renderProof } from "./ship.js";
import { questionCard } from "./needs.js";
import { renderTerm, termBlocked, termState } from "./term.js";
import { shepherdMark, programIcon } from "./start.js";

export { TAB, TABS, currentTab };
const TAB_TITLES = { overview: "Overview", review: "Review", changes: "Changes", files: "Files", proof: "Proof", terminal: "Terminal" };
const BUILD = ["implement", "review", "ci", "proof"];

export { tint };

const ms = (r, now) => Math.max(0, (Date.parse(r.end ?? "") || now) - (Date.parse(r.start ?? "") || now));

export function closeDetail() {
  setShared(SELECTED, null);
  run("layout.hide", { id: "detail" });
}

/** Where the task's worktree is, as the design words it before and after: none yet for plan
 *  stages and queued tickets, "merged · worktree removed" once done. */
function worktreeLine(m, task) {
  if (task.stage === "done") return { branch: task.branch ?? "merged", path: "merged · worktree removed", active: false };
  if (!task.worktree) return { branch: "no worktree yet", path: "one is made when the ticket starts", active: false };
  return { branch: task.branch ?? "—", path: `${m.space()?.machine ?? "this mac"}:${task.worktree}`, active: true };
}

export function renderDetail(m) {
  const t = palette();
  const task = m.selectedTask();
  const root = v_flex().id("shepherd-detail").size_full().bg(t.surface).text_size(12).text_color(t.foreground);
  if (!task) {
    return root.items_center().justify_center()
      .child(div().text_color(t.dim).child("Pick a task on the board."));
  }
  const tab = currentTab();
  const runs = task.history ?? [];
  const tokens = runTokens(runs);
  const where = m.taskNow(task);
  // The design's chip: 12% fill, 45% edge, in the group's color, amber while it waits on you.
  const color = where.kind === "waiting" && stageGroup(task.stage) !== "ship" ? t.blocked : groupColor(t, stageGroup(task.stage));
  const stageIcon = task.stage === "merge" ? "⑃ " : task.stage === "done" ? "✓ " : "";
  const skill = m.skillOf(task.stage);
  const loopText = BUILD.includes(task.stage) ? `loop ${task.loop ?? 1}/${Math.max(task.maxLoops ?? 3, task.loop ?? 1)}`
    : stageGroup(task.stage) === "plan" ? skill : "";
  const wt = worktreeLine(m, task);
  const meta = (text) => div().flex_none().font_family(MONO).text_size(11).text_color(t.muted).child(text);

  // The agent's terminal: a live one opens the terminal window (as T does); greyed when there's none
  // ("no agent") or it isn't running (its address, ended).
  const term = termState(m, task);
  const live = term.state === "live";
  const termChip = h_flex().id("detail-term").flex_none().h(24).px(8).gap(6).items_center().rounded(5)
    .border(1).border_color(t.input).font_family(MONO).text_size(11)
    .text_color(live ? t.foreground : t.dim)
    .tooltip(live ? "Open terminal (T)" : term.state === "none" ? "No agent running"
      : term.state === "unknown" ? `${task.terminal} isn't running` : `${task.terminal} has ended`)
    .when(live, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => m.openTerminal(task.terminal, task.id)))
    .child(div().w(12).h(9).rounded(2).border(1).border_color(live ? t.muted : t.dim))
    .child(term.state === "none" ? "no agent" : live ? task.terminal : `${task.terminal} · ended`);

  const header = v_flex().flex_none().px(14).pt(12).pb(9).gap(6)
    .child(h_flex().gap(10).items_start()
      .child(h_flex().flex_1().min_w(0).flex_wrap().gap(10).items_center()
        .child(div().flex_none().font_family(MONO).text_size(12).text_color(t.muted).child(task.id))
        .child(div().min_w(0).truncate().text_size(15).font_semibold().child(task.title ?? ""))
        .child(div().flex_none().px(8).h(20).flex().items_center().rounded(10).border(1)
          .border_color(tint(color, 0.45)).bg(tint(color, 0.12)).text_size(11).text_color(color)
          .child(`${stageIcon}${STAGES[task.stage]?.title ?? task.stage}`))
        .when(Boolean(loopText), (el) => el.child(meta(loopText)))
        .when(tokens > 0, (el) => el.child(meta(`${kTokens(tokens)} tokens`))))
      .child(termChip)
      .child(div().id("detail-close").flex_none().size(24).flex().items_center().justify_center().rounded(4).text_color(t.muted)
        .tooltip("Close (Esc)")
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => closeDetail()).child("✕")))
    .child(h_flex().min_w(0).gap(8).items_center().font_family(MONO).text_size(11).text_color(t.dim)
      .child(div().flex_none().text_color(wt.active ? t.accent : t.dim).child(`⑂ ${wt.branch}`))
      .child(div().flex_none().text_color(t.border).child("·"))
      .child(div().min_w(0).truncate().child(wt.path)));

  // Review = open findings (the person's call, 2026-11-18: a to-do count), Changes = changed files (once git has read them).
  const g = worktreeOf(task) ? m.git(task) : null;
  const counts = {
    review: (task.findings ?? []).filter((f) => f.state !== "resolved").length || null,
    changes: g && !g.error && g.files.length ? g.files.length : null,
  };
  const tabs = h_flex().flex_none().px(10).gap(2).border_b(1).border_color(t.border)
    .children(TABS.map((k, i) => h_flex().id(`dtab-${k}`).pt(7).pb(7).px(10).gap(6).items_center()
      .border_b(2).border_color(tab === k ? t.foreground : t.surface)
      .text_size(12.5).text_color(tab === k ? t.foreground : t.muted)
      .hover((s) => s.text_color(t.foreground))
      .on_click(() => setShared(TAB, k))
      .child(TAB_TITLES[k])
      .when(counts[k] != null, (el) => el.child(div().px(5).rounded(8).bg(t.raised)
        .font_family(MONO).text_size(10.5).text_color(t.muted).child(String(counts[k]))))
      // The agent waits on the person (a permission or trust prompt): an amber dot on Terminal.
      .when(k === "terminal" && termBlocked(m, task), (el) => el.child(div().size(6).rounded(3).bg(t.blocked)))
      .child(div().font_family(MONO).text_size(10).text_color(t.dim).child(String(i + 1)))));

  const body = tab === "overview" ? overview(m, task, t, where)
    : tab === "review" ? review(task, t)
    : tab === "changes" ? renderChanges(m, task, t)
    : tab === "files" ? renderFiles(m, task, t)
    : tab === "terminal" ? renderTerm(m, task, t)
    : renderProof(m, task, t);

  return root.child(header).child(tabs).child(body);
}

// ---- Overview ------------------------------------------------------------------------------

/** A run's color by its result; an open run (no result yet) is running. */
const resultColor = (t, r) => stateColor(t, !r ? "running" : r, t.working);

/** A timeline segment's tooltip, as the design: "Loop 2 · Code review · fail · 12m · 45k tokens · opus — 1 finding".
 *  Plan stages have no loop; a running stage reads "run"; the model goes with the tokens (no $). */
export const segmentTitle = (r, now = Date.now()) => [
  stageGroup(r.stage) === "plan" ? null : `Loop ${r.loop ?? 1}`,
  STAGES[r.stage]?.title ?? r.stage,
  !r.result || r.result === "running" ? "run" : r.result,
  mins(ms(r, now) / 60000),
  r.tokens ? `${kTokens(r.tokens)} tokens${r.model ? ` · ${r.model}` : ""}` : null,
].filter(Boolean).join(" · ") + (r.note ? ` — ${r.note}` : "");

/** The design's short stage names, for labels inside timeline segments ("impl 14m"). */
const SHORT = { triage: "triage", grill: "grill", spec: "spec", tickets: "tickets", implement: "impl", review: "review", ci: "ci", proof: "proof", merge: "merge", done: "done" };

/** Who wrote a comment: name and color per role (the design's), purple for plan roles and review. */
const ROLES = (t) => ({
  shepherd: ["Shepherd", t.accent], you: ["You", t.foreground], implementer: ["Implementer", t.working],
  reviewer: ["Reviewer", t.ansi5], planner: ["Planner", t.ansi5], griller: ["Griller", t.ansi5], triager: ["Triager", t.ansi5],
  ci: ["CI", t.muted], qa: ["QA", t.ansi6],
});

/** Which agent a model runs in: Codex for codex/gpt models, else Claude Code; null with no model. */
const agentOf = (model) => (!model ? null : /codex|gpt/i.test(model) ? "codex" : "claude");

/** A comment's 22px avatar: the agent's icon (Claude Code, Codex, or the Shepherd terminal's own
 *  program) with a corner in the role's color, else the role's initial on its color. */
function avatar(t, role, { model = null, program = null } = {}) {
  const [name, color] = ROLES(t)[role] ?? [role, t.muted];
  const agent = agentOf(model);
  const icon = program?.icon ? programIcon(t, program, 14)
    : agent ? image(`icons/${agent}.svg`).size(14).flex_none() : null;
  const tile = div().size(22).rounded(5).flex().items_center().justify_center();
  return div().relative().size(22).flex_none()
    .tooltip(icon ? `${program?.name ?? (agent === "codex" ? "Codex" : "Claude Code")} · ${name}` : name)
    .child(icon ? tile.bg(t.raised).border(1).border_color(t.border).child(icon)
      : role === "shepherd" ? shepherdMark(t, 22)
      : tile.bg(color).text_color(t.background).text_size(11).font_semibold().child(name[0]))
    .when(Boolean(icon), (el) => el.child(div().absolute().right(-3).bottom(-3).size(9).rounded(3)
      .border(2).border_color(t.surface).bg(color)));
}

function overview(m, task, t, where) {
  const now = Date.now();
  const runs = task.history ?? [];
  const total = runs.reduce((n, r) => n + ms(r, now), 0) || 1;
  const tokens = runTokens(runs);
  const findings = task.findings ?? [];
  const open = findings.filter((f) => f.state !== "resolved").length;
  const shepherd = m.shepherd();

  // Timeline: one segment per stage run, flexed by its share of the time (2% floor), tinted in
  // its result color with "impl 14m" inside when it's wide enough; "plan" / "loop n" over the first
  // segment of each part, a small gap between parts.
  const part = (r) => (stageGroup(r.stage) === "plan" ? 0 : r.loop ?? 1);
  const segs = runs.map((r, i) => {
    const share = Math.max(0.02, ms(r, now) / total);
    const fresh = i === 0 || part(runs[i - 1]) !== part(r);
    return { r, i, share, fresh, mark: fresh ? (part(r) ? `loop ${part(r)}` : "plan") : "" };
  });
  const cell = (s) => div().flex_basis(0).flex_grow(s.share).min_w(3).when(s.fresh && s.i > 0, (el) => el.ml(5));
  const timeline = segs.length === 0
    ? h_flex().h(22).px(5).items_center().rounded(3).border(1).border_color(t.border).bg(t.raised)
      .font_family(MONO).text_size(10).text_color(t.dim).child("not started")
    : h_flex().h(22).gap(2).children(segs.map((s) => {
      const c = resultColor(t, s.r.result);
      return cell(s).id(`seg-${s.i}`).h_full().flex().items_center().px(5).overflow_hidden().rounded(3)
        .bg(tint(c, 0.22)).border(1).border_color(tint(c, 0.55))
        .tooltip(segmentTitle(s.r, now))
        .when(s.r.result === "running", (el) => el.loop("opacity", { from: 0.45, to: 1, period: 1600 }))
        .when(s.share > 0.07, (el) => el.child(div().min_w(0).truncate().font_family(MONO).text_size(10).text_color(t.foreground)
          .child(`${SHORT[s.r.stage] ?? s.r.stage} ${mins(ms(s.r, now) / 60000)}`)));
    }));
  // A mark stays inside its part's first cell (clipped there), so it never runs into the next one.
  const marks = h_flex().h(14).gap(2).children(segs.map((s) => cell(s).flex().items_end().overflow_hidden()
    .font_family(MONO).text_size(10).text_color(t.muted).child(div().min_w(0).whitespace_nowrap().child(s.mark))));

  // One comment: avatar, who, "model · skill", "loop n", a state chip, a file:line chip, the text.
  const comment = ({ role, model = null, program = null, sub = null, loop = null, state = null, file = null, line = null, chipId = null, text, fg = t.foreground, subColor = t.dim }) => {
    const [name] = ROLES(t)[role] ?? [role];
    return h_flex().gap(10).py(10).items_start().border_t(1).border_color(t.border)
      .child(avatar(t, role, { model, program }))
      .child(v_flex().flex_1().min_w(0).gap(5)
        .child(h_flex().gap(8).items_center().flex_wrap()
          .child(div().text_size(12).font_semibold().child(name))
          .when(Boolean(sub), (el) => el.child(div().font_family(MONO).text_size(11).text_color(subColor).child(sub)))
          .when(loop != null, (el) => el.child(div().font_family(MONO).text_size(11).text_color(t.dim).child(`loop ${loop}`)))
          .child(div().flex_1())
          .when(Boolean(state), (el) => el.child(div().px(7).h(18).flex().items_center().rounded(9).border(1)
            .border_color(stateColor(t, state)).text_size(10.5).text_color(stateColor(t, state)).child(state))))
        .when(Boolean(file), (el) => el.child(fileChip(m, task, t, file, line, chipId)))
        .child(div().text_size(13).line_height(1.5).text_color(fg).child(text)));
  };
  const modelSub = (role, stage, model) => {
    const skill = role === "implementer" ? "" : m.skillOf(stage);
    return [model, skill.startsWith("/") ? skill : ""].filter(Boolean).join(" · ") || null;
  };

  const comments = [
    ...runs.filter((r) => r.note).map((r) => {
      const role = r.stage === "merge" ? "shepherd" : ROLE[r.stage] ?? r.stage;
      // As the design: only a passed review gets a chip on a run's note ("approved"); findings carry
      // their own open / fixing / resolved.
      const state = r.result === "pass" && r.stage === "review" ? "approved" : null;
      return {
        at: Date.parse(r.end ?? r.start ?? "") || 0,
        el: comment({ role, model: r.model, sub: modelSub(role, r.stage, r.model),
          loop: stageGroup(r.stage) === "plan" ? null : r.loop ?? 1, state, text: r.note }),
      };
    }),
    // The task's chat (chat.jsonl lines with this task): your `re <id>: …` lines as your text, the
    // board's other lines (pause, steer, status, answers) as short events, and Shepherd's replies.
    ...m.taskChat(task.id).map((c) => ({
      at: Date.parse(c.at) || now,
      el: chatComment(c, task.id, now),
    })),
    ...findings.map((f, i) => {
      // Findings carry no time: place each just after the review run that found it.
      const rev = runs.filter((r) => r.stage === "review" && (r.loop ?? 1) === (f.loop ?? 1)).slice(-1)[0];
      return {
        at: (Date.parse(rev?.end ?? "") || 0) + 1,
        el: comment({ role: "reviewer", model: rev?.model, sub: modelSub("reviewer", "review", rev?.model),
          loop: f.loop ?? 1, state: f.state, file: f.file, line: f.line, chipId: `fchip-${f.id ?? i}`, text: f.text }),
      };
    }),
  ].sort((a, b) => a.at - b.at).map((c) => c.el);

  function chatComment(c, id, now) {
    const text = String(c.text ?? "");
    if (c.from !== "you") return comment({ role: "shepherd", program: shepherd?.program, sub: ago(c.at, now), text, fg: t.muted });
    const asked = text.match(new RegExp(`^re ${escRe(id)}:\\s*([\\s\\S]*)$`));
    if (asked) {
      return comment({ role: "you", text: asked[1],
        sub: c.failed ? `not kept in the History: ${c.failed}` : c.queued ? "waits for Shepherd…" : c.pending ? "sending…" : ago(c.at, now),
        subColor: c.failed ? t.ansi1 : c.queued ? t.blocked : t.dim });
    }
    // Lines the board sent about this task: one short line each, like the History's ⎿ events.
    return h_flex().gap(8).px(2).py(6).items_start().border_t(1).border_color(t.border)
      .font_family(MONO).text_size(11).text_color(t.muted)
      .child(div().text_color(t.dim).child("⎿"))
      .child(div().flex_1().min_w(0).child(boardEvent(text, id)))
      .child(div().flex_none().text_color(t.dim).child(ago(c.at, now)));
  }

  const heading = (text) => sectionHeading(t, text);

  // 120px under the Ask field: the floating bar covers the pane's bottom, and the field is last.
  return v_flex().id("ov-scroll").flex_1().min_h(0).overflow_y_scrollbar().px(18).pt(16).pb(120).gap(18)
    // What the task waits on you for, answerable here as in Needs you (a merge question is the PR card's).
    .children(m.questions().filter((q) => q.task === task.id && q.kind !== "merge").map((q) => questionCard(m, q, t, { id: "ov-q" })))
    .when(task.stage === "merge", (el) => el.child(renderPrCard(m, task, t)))
    .child(v_flex().gap(8)
      .child(h_flex().gap(8).items_center().child(shepherdMark(t, 16)).child(heading("SHEPHERD SUMMARY")))
      .child(div().text_size(14).line_height(1.55).text_color(task.summary ? t.foreground : t.dim)
        .child(task.summary || "Shepherd hasn't written a summary yet."))
      .child(v_flex().gap(6).pt(4)
        .when(segs.length > 0, (el) => el.child(marks))
        .child(timeline)
        .child(h_flex().flex_wrap().gap(14).font_family(MONO).text_size(11).text_color(t.muted)
          .when(runs.length > 0, (el) => el.child(`${mins(total / 60000)} total`))
          .when(tokens > 0, (el) => el.child(`${kTokens(tokens)} tokens`))
          // stuck red, waiting on you amber, done green; the plain time in stage muted.
          .child(div().text_color(["stuck", "waiting", "done"].includes(where.kind) ? stateColor(t, where.kind) : t.muted).child(where.text)))))
    .child(v_flex()
      .child(h_flex().gap(10).pb(8).items_center()
        .child(heading("COMMENTS"))
        .child(div().font_family(MONO).text_size(11).text_color(t.dim)
          .child(findings.length ? `${findings.length} from review · ${open} open` : "no review findings")))
      .when(comments.length === 0, (el) => el.child(div().py(10).border_t(1).border_color(t.border).text_color(t.dim).child("No comments yet.")))
      .children(comments))
    .child(askField(m, task, t));
}

/** A finding's file:line as a chip that opens it: in Changes when the task changed it, else in Files
 *  (the design always goes to Changes; a file review flagged but the task didn't change has no diff).
 *  Without a worktree (not made, or removed once Done) it's only a label. */
function fileChip(m, task, t, file, line, id) {
  const open = Boolean(worktreeOf(task));
  return h_flex().id(id).self_start().gap(6).px(7).py(2).items_center().rounded(4).bg(t.raised)
    .font_family(MONO).text_size(11).text_color(open ? t.accent : t.muted)
    .when(open, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { m.openFileAt(task, file); cx.notify(); }))
    .child(fileIcon(t, file))
    .child(`${file}${line ? `:${line}` : ""}`);
}

/** A board line about a task (CONVENTIONS "Talking to Shepherd") as a short event. */
function boardEvent(text, id) {
  const i = escRe(id);
  let x;
  if (new RegExp(`^pause ${i}$`).test(text)) return "paused by you";
  if (new RegExp(`^resume ${i}$`).test(text)) return "resumed by you";
  if (new RegExp(`^status ${i}\\?$`).test(text)) return "you asked for status";
  if ((x = text.match(new RegExp(`^steer ${i} (redirect|context):\\s*([\\s\\S]*)$`)))) return `you ${x[1] === "redirect" ? "redirected" : "added context"}: ${x[2]}`;
  if ((x = text.match(/^answer [^:]+:\s*([\s\S]*)$/))) return `you answered: ${x[1]}`;
  return `you: ${text}`;
}

/** "❯ Ask Shepherd about T-4…" + Send: Enter or Send sends `re T-4: <text>` (main.js askAbout). */
function askField(m, task, t) {
  const empty = !(m.askInput?.value() ?? "");
  // A press in the field stops here, so the pane's own mouse-down doesn't take the keyboard from it.
  return h_flex().id("ask-field").flex_none().gap(8).px(10).py(8).items_center().rounded(6).border(1)
    .border_color(t.input).bg(t.background)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .child(div().font_family(MONO).text_size(12).text_color(t.accent).child("❯"))
    .child(div().relative().flex_1().min_w(0).h(18)
      .when(empty, (el) => el.child(div().absolute().inset_0().flex().items_center().truncate()
        .font_family(MONO).text_size(12).text_color(t.dim).child(`Ask Shepherd about ${task.id}…`)))
      .when(Boolean(m.askInput), (el) => el.child(Input.new(m.askInput).absolute().inset_0()
        .font_family(MONO).text_size(12).text_color(t.foreground))))
    .child(div().id("ask-send").px(10).py(3).rounded(4).bg(t.raised).cursor_pointer()
      .text_size(11).text_color(empty ? t.dim : t.foreground)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => m.askAbout(cx))
      .child("Send"));
}

// ---- Review --------------------------------------------------------------------------------

/** What a finding was in a loop: found, still open, fixing, fixed, or "" (not alive then). */
export function cellState(f, loop) {
  const h = f.history ?? [{ loop: f.loop ?? 1, state: "found" }];
  const first = Math.min(...h.map((x) => x.loop));
  if (loop < first) return "";
  const fixedAt = h.find((x) => x.state === "fixed")?.loop ?? (f.state === "resolved" ? Math.max(...h.map((x) => x.loop)) : Infinity);
  if (loop > fixedAt) return "";
  const inLoop = h.filter((x) => x.loop === loop);
  if (inLoop.length) {
    const s = inLoop[inLoop.length - 1].state;
    return s === "open" ? "still open" : s;
  }
  return "still open";
}

function review(task, t) {
  const findings = task.findings ?? [];
  const runs = task.history ?? [];
  const cur = task.loop ?? 1;
  // A column for every loop up to the current one or the last a finding was found or changed in.
  const last = Math.max(cur, ...findings.flatMap((f) => [f.loop ?? 1, ...(f.history ?? []).map((x) => x.loop)]));
  const loops = Array.from({ length: last }, (_, i) => i + 1);
  const cellColor = (s) => stateColor(t, s, t.dim);
  const fixed = findings.filter((f) => f.state === "resolved").length;
  const heading = (text) => sectionHeading(t, text);

  // The grid: a finding column, then one per loop; the current loop's column is shaded.
  const COLW = 112;
  const shade = (el, l) => el.when(l === cur, (e) => e.bg(t.raised));
  const headerRow = h_flex().bg(t.raised).border_b(1).border_color(t.border).font_family(MONO).text_size(11).text_color(t.muted)
    .child(div().flex_1().min_w(0).px(10).py(8).child("finding"))
    .children(loops.map((l) => div().w(COLW).flex_none().px(10).py(8).truncate().child(`loop ${l}${l === cur ? " · now" : ""}`)));
  const row = (f, i) => h_flex().items_stretch().when(i > 0, (el) => el.border_t(1).border_color(t.border))
    .child(v_flex().flex_1().min_w(0).px(10).py(9).gap(3).justify_center()
      .child(div().text_size(12.5).line_height(1.4).child(f.text))
      .child(div().truncate().font_family(MONO).text_size(10.5).text_color(t.dim)
        .child(f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "general")))
    .children(loops.map((l) => {
      const s = cellState(f, l);
      const c = cellColor(s);
      return shade(div().w(COLW).flex_none().px(10).flex().items_center(), l)
        .when(Boolean(s), (el) => el.child(div().px(7).py(2).rounded(9).bg(tint(c, 0.14))
          .text_size(10.5).text_color(c).child(s === "fixed" ? "✓ fixed" : s)));
    }));

  const perLoop = loops.map((l) => {
    const impl = runs.filter((r) => r.loop === l && r.stage === "implement").slice(-1)[0];
    const rev = runs.filter((r) => r.loop === l && r.stage === "review").slice(-1)[0];
    const fresh = findings.filter((f) => cellState(f, l) === "found").length;
    const fixedN = findings.filter((f) => cellState(f, l) === "fixed").length;
    const carried = findings.filter((f) => ["still open", "fixing"].includes(cellState(f, l))).length;
    const revText = !rev ? "not reached" : rev.result === "pass" ? "approved"
      : !rev.result || rev.result === "running" ? "in progress" : `${rev.result}${rev.note ? ` · ${rev.note}` : ""}`;
    const label = (k, v) => h_flex().gap(4).text_size(12.5).text_color(t.foreground)
      .child(div().flex_none().text_color(t.dim).child(k)).child(div().min_w(0).child(v));
    return h_flex().gap(12).py(9).items_start().border_t(1).border_color(t.border)
      .child(div().w(56).flex_none().font_family(MONO).text_size(11).text_color(t.muted).child(`loop ${l}`))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(label("Implementer:", impl?.note || "—"))
        .child(label("Review:", revText)))
      .child(h_flex().flex_none().gap(6).font_family(MONO).text_size(10.5)
        .when(fresh > 0, (el) => el.child(div().text_color(t.ansi1).child(`${fresh} new`)))
        .when(fixedN > 0, (el) => el.child(div().text_color(t.done).child(`${fixedN} fixed`)))
        .when(carried > 0, (el) => el.child(div().text_color(t.blocked).child(`${carried} carried`))));
  });

  return v_flex().id("rv-scroll").flex_1().min_h(0).overflow_y_scrollbar().px(18).py(16).gap(18)
    .child(h_flex().gap(12).items_center()
      .child(heading("FINDINGS ACROSS LOOPS"))
      .child(div().font_family(MONO).text_size(11).text_color(t.muted)
        .child(`${findings.length} found · ${fixed} fixed · ${findings.length - fixed} open`)))
    .child(findings.length === 0
      ? div().text_size(13).text_color(t.dim).child("No review findings yet.")
      : v_flex().rounded(7).border(1).border_color(t.border).overflow_hidden().child(headerRow).children(findings.map(row)))
    .child(v_flex().child(div().pb(6).child(heading("LOOP BY LOOP"))).children(perLoop));
}

export { age };
