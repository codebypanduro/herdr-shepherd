// Task detail: header, worktree line and six tabs (Overview, Review, Changes, Files, Proof, Terminal).
// Changes and Files come from git in the task's worktree (see git.js), Terminal mirrors the task's
// agent (term.js); the rest is tasks.json.

import { div } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { theme, run, shared, setShared } from "herdr";
import { STAGES, MONO, ROLE, SELECTED, groupColor, stageGroup, age, ago, escRe, palette, tint, kTokens, mins, runTokens } from "./common.js";
import { renderChanges, renderFiles } from "./git.js";
import { renderPrCard, renderProof } from "./ship.js";
import { questionCard } from "./needs.js";
import { renderTerm, termBlocked } from "./term.js";

export const TAB = "shepherd.detailTab";
export const TABS = ["overview", "review", "changes", "files", "proof", "terminal"];
const TAB_TITLES = { overview: "Overview", review: "Review", changes: "Changes", files: "Files", proof: "Proof", terminal: "Terminal" };
/** The open task's tab (shared, so the board's 1–6 keys switch it too). */
export const currentTab = () => (TABS.includes(shared(TAB)) ? shared(TAB) : "overview");
const BUILD = ["implement", "review", "ci", "proof"];

export { tint };

const ms = (r, now) => Math.max(0, (Date.parse(r.end ?? "") || now) - (Date.parse(r.start ?? "") || now));
function dur(x) {
  const s = Math.round(x / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function closeDetail() {
  setShared(SELECTED, null);
  run("layout.hide", { id: "detail" });
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
  const color = groupColor(t, stageGroup(task.stage));
  const stageIcon = task.stage === "merge" ? "⑃ " : task.stage === "done" ? "✓ " : "";

  const chip = (text, c) => div().px(7).h(20).flex().items_center().rounded(5).border(1).border_color(c)
    .text_size(11).text_color(c).child(text);

  const header = v_flex().flex_none().px(14).pt(12).pb(10).gap(8).border_b(1).border_color(t.border)
    .child(h_flex().gap(8).items_center()
      .child(div().font_family(MONO).text_size(11.5).text_color(t.muted).child(task.id))
      .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().child(task.title ?? ""))
      .child(div().id("detail-close").px(6).rounded(4).text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => closeDetail()).child("✕")))
    .child(h_flex().gap(8).items_center()
      .child(chip(`${stageIcon}${STAGES[task.stage]?.title ?? task.stage}`, color))
      .when(BUILD.includes(task.stage), (el) => el.child(
        div().font_family(MONO).text_size(11).text_color(t.muted).child(`loop ${task.loop ?? 1}/${task.maxLoops ?? 3}`)))
      .when(tokens > 0, (el) => el.child(div().font_family(MONO).text_size(11).text_color(t.muted).child(`${kTokens(tokens)} tokens`)))
      .when(Boolean(task.terminal), (el) => el.child(
        div().id("detail-term").px(7).h(20).flex().items_center().rounded(5).bg(t.raised).cursor_pointer()
          .font_family(MONO).text_size(11).text_color(t.foreground)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("terminal.peek", { terminal: task.terminal }))
          .child(`▭ ${task.terminal}`))))
    .when(Boolean(task.worktree), (el) => el.child(
      div().truncate().font_family(MONO).text_size(10.5).text_color(t.dim)
        .child(`⑂ ${task.branch ?? "—"} · ${m.space()?.machine ?? "this mac"}:${task.worktree}`)));

  const tabs = h_flex().flex_none().h(32).px(10).gap(2).items_center().border_b(1).border_color(t.border)
    .children(TABS.map((k, i) => h_flex().id(`dtab-${k}`).h(24).px(9).gap(5).items_center().rounded(5)
      .bg(tab === k ? t.selected : t.surface).text_color(tab === k ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover))
      .on_click(() => setShared(TAB, k))
      .child(TAB_TITLES[k])
      // The agent waits on the person (a permission or trust prompt): an amber dot on Terminal.
      .when(k === "terminal" && termBlocked(m, task), (el) => el.child(div().size(6).rounded(3).bg(t.blocked)))
      .child(div().font_family(MONO).text_size(10).text_color(t.dim).child(String(i + 1)))));

  const body = tab === "overview" ? overview(m, task, t)
    : tab === "review" ? review(task, t)
    : tab === "changes" ? renderChanges(m, task, t)
    : tab === "files" ? renderFiles(m, task, t)
    : tab === "terminal" ? renderTerm(m, task, t)
    : renderProof(m, task, t);

  return root.child(header).child(tabs).child(body);
}

// ---- Overview ------------------------------------------------------------------------------

const RESULT_COLOR = (t, r) => (r === "pass" ? t.done : r === "fail" ? t.ansi1 : r === "ask" ? t.blocked : t.working);

/** A timeline segment's tooltip, as the design: "Loop 2 · Code review · fail · 12m · 45k tokens · opus — 1 finding".
 *  Plan stages have no loop; a running stage reads "run"; the model goes with the tokens (no $). */
export const segmentTitle = (r, now = Date.now()) => [
  stageGroup(r.stage) === "plan" ? null : `Loop ${r.loop ?? 1}`,
  STAGES[r.stage]?.title ?? r.stage,
  !r.result || r.result === "running" ? "run" : r.result,
  mins(ms(r, now) / 60000),
  r.tokens ? `${kTokens(r.tokens)} tokens${r.model ? ` · ${r.model}` : ""}` : null,
].filter(Boolean).join(" · ") + (r.note ? ` — ${r.note}` : "");

function overview(m, task, t) {
  const now = Date.now();
  const runs = task.history ?? [];
  const total = runs.reduce((n, r) => n + ms(r, now), 0) || 1;
  const tokens = runTokens(runs);
  const loops = [...new Set(runs.map((r) => r.loop ?? 1))];

  // Segments flex by their share of the time; a 2% floor keeps short stages visible.
  const segment = (r, i) => {
    const c = RESULT_COLOR(t, r.result);
    return div().id(`seg-${i}`).h_full().flex_basis(0).flex_grow(Math.max(0.02, ms(r, now) / total)).min_w(4).rounded(3).bg(c)
      .tooltip(segmentTitle(r, now))
      .when(r.result === "running", (el) => el.loop("opacity", { from: 0.45, to: 1, period: 1400 }));
  };
  const loopGroup = (l) => {
    const rs = runs.map((r, i) => ({ r, i })).filter(({ r }) => (r.loop ?? 1) === l);
    const share = rs.reduce((n, { r }) => n + ms(r, now), 0) / total;
    return v_flex().gap(4).flex_basis(0).flex_grow(Math.max(0.06, share)).min_w(30)
      .child(div().font_family(MONO).text_size(10).text_color(t.dim).child(`loop ${l}`))
      .child(h_flex().h(10).gap(2).children(rs.map(({ r, i }) => segment(r, i))))
      .child(div().truncate().text_size(10).text_color(t.dim).child(rs.map(({ r }) => STAGES[r.stage]?.title ?? r.stage).join(" · ")));
  };

  const comment = ({ who, color, where = null, text, state = null, fg = t.foreground, whereColor = t.dim }) => v_flex().gap(4).p(10).rounded(6).bg(t.raised)
    .child(h_flex().gap(7).items_center()
      .child(div().w(3).h(12).rounded(2).bg(color))
      .child(div().text_size(11.5).font_semibold().child(who))
      .when(Boolean(where), (el) => el.child(div().font_family(MONO).text_size(10.5).text_color(whereColor).child(where)))
      .child(div().flex_1())
      .when(Boolean(state), (el) => el.child(div().px(6).h(18).flex().items_center().rounded(4).border(1)
        .border_color(state === "resolved" ? t.done : state === "fixing" ? t.working : t.blocked)
        .text_size(10.5).text_color(state === "resolved" ? t.done : state === "fixing" ? t.working : t.blocked)
        .child(state))))
    .child(div().text_size(12.5).line_height(1.4).text_color(fg).child(text));

  const comments = [
    ...runs.filter((r) => r.note).map((r) => ({
      at: Date.parse(r.end ?? r.start ?? "") || 0,
      el: comment({ who: `${ROLE[r.stage] ?? r.stage} · ${r.model ?? "agent"}`, color: RESULT_COLOR(t, r.result),
        where: `${STAGES[r.stage]?.title ?? r.stage} · loop ${r.loop ?? 1}`, text: r.note,
        state: r.result === "running" ? null : r.result === "fail" ? "open" : null }),
    })),
    // The task's chat (chat.jsonl lines with this task): your `re <id>: …` lines as your text, the
    // board's other lines (pause, steer, status, answers) as short events, and Shepherd's replies.
    ...m.taskChat(task.id).map((c) => ({
      at: Date.parse(c.at) || now,
      el: chatComment(c, task.id, now),
    })),
    ...(task.findings ?? []).map((f) => ({
      // Findings carry no time: place each just after the review run that found it.
      at: (Date.parse(runs.filter((r) => r.stage === "review" && (r.loop ?? 1) === (f.loop ?? 1)).slice(-1)[0]?.end ?? "") || 0) + 1,
      el: comment({ who: "reviewer", color: t.ansi5, where: f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : `loop ${f.loop}`, text: f.text, state: f.state }),
    })),
  ].sort((a, b) => a.at - b.at).map((c) => c.el);

  function chatComment(c, id, now) {
    const text = String(c.text ?? "");
    if (c.from !== "you") return comment({ who: "shepherd", color: t.accent, where: ago(c.at, now), text, fg: t.muted });
    const asked = text.match(new RegExp(`^re ${escRe(id)}:\\s*([\\s\\S]*)$`));
    if (asked) {
      return comment({ who: "you", color: t.foreground, text: asked[1],
        where: c.failed ? `not kept in the History: ${c.failed}` : c.queued ? "waits for Shepherd…" : c.pending ? "sending…" : ago(c.at, now),
        whereColor: c.failed ? t.ansi1 : c.queued ? t.blocked : t.dim });
    }
    // Lines the board sent about this task: one short line each, like the History's ⎿ events.
    return h_flex().gap(8).px(2).items_start().font_family(MONO).text_size(11).text_color(t.muted)
      .child(div().text_color(t.dim).child("⎿"))
      .child(div().flex_1().min_w(0).child(boardEvent(text, id)))
      .child(div().flex_none().text_color(t.dim).child(ago(c.at, now)));
  }

  // 120px under the Ask field: the floating bar covers the pane's bottom, and the field is last.
  return v_flex().id("ov-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(14).pb(120).gap(16)
    // What the task waits on you for, answerable here as in Needs you (a merge question is the PR card's).
    .children(m.questions().filter((q) => q.task === task.id && q.kind !== "merge").map((q) => questionCard(m, q, t, { id: "ov-q" })))
    .when(task.stage === "merge", (el) => el.child(renderPrCard(m, task, t)))
    .child(div().text_size(14).line_height(1.45).text_color(task.summary ? t.foreground : t.dim)
      .child(task.summary || "Shepherd hasn't written a summary yet."))
    .when(runs.length > 0, (el) => el.child(v_flex().gap(6)
      .child(div().text_size(10.5).font_semibold().text_color(t.dim).child("TIMELINE"))
      .child(h_flex().gap(6).items_end().children(loops.map(loopGroup)))
      .child(h_flex().gap(12).font_family(MONO).text_size(10.5).text_color(t.muted)
        .child(dur(total)).when(tokens > 0, (el) => el.child(`${kTokens(tokens)} tokens`)))))
    .child(v_flex().gap(8)
      .child(div().text_size(10.5).font_semibold().text_color(t.dim).child("COMMENTS"))
      .when(comments.length === 0, (el) => el.child(div().text_color(t.dim).child("No comments yet.")))
      .children(comments))
    .child(askField(m, task, t));
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
  const loops = Array.from({ length: Math.max(cur, ...findings.flatMap((f) => (f.history ?? []).map((x) => x.loop))) }, (_, i) => i + 1);
  const cellColor = (s) => (s === "fixed" ? t.done : s === "fixing" ? t.working : s === "found" || s === "still open" ? t.blocked : t.dim);

  const COLW = 92;
  const headerRow = h_flex().h(26).items_center().border_b(1).border_color(t.border)
    .child(div().flex_1().min_w(0).text_size(10.5).font_semibold().text_color(t.dim).child("FINDING"))
    .children(loops.map((l) => div().w(COLW).h_full().flex().items_center().justify_center()
      .when(l === cur, (el) => el.bg(t.raised))
      .text_size(10.5).font_semibold().text_color(t.dim).child(`LOOP ${l}`)));
  const row = (f) => h_flex().min_h(34).items_center().border_b(1).border_color(t.border)
    .child(v_flex().flex_1().min_w(0).py(5).pr(8)
      .child(div().truncate().text_size(12).child(f.text))
      .when(Boolean(f.file), (el) => el.child(div().truncate().font_family(MONO).text_size(10.5).text_color(t.dim)
        .child(`${f.file}${f.line ? `:${f.line}` : ""}`))))
    .children(loops.map((l) => {
      const s = cellState(f, l);
      return div().w(COLW).self_stretch().flex().items_center().justify_center()
        .when(l === cur, (el) => el.bg(t.raised))
        .text_size(11).text_color(cellColor(s)).child(s === "fixed" ? "✓ fixed" : s);
    }));

  const perLoop = loops.map((l) => {
    const impl = runs.filter((r) => r.loop === l && r.stage === "implement").slice(-1)[0];
    const rev = runs.filter((r) => r.loop === l && r.stage === "review").slice(-1)[0];
    const fresh = findings.filter((f) => cellState(f, l) === "found").length;
    const fixed = findings.filter((f) => cellState(f, l) === "fixed").length;
    const carried = findings.filter((f) => ["still open", "fixing"].includes(cellState(f, l))).length;
    return v_flex().gap(5).p(10).rounded(6).bg(t.raised)
      .child(h_flex().gap(8).items_center()
        .child(div().font_semibold().child(`Loop ${l}`))
        .child(div().flex_1())
        .child(div().font_family(MONO).text_size(10.5).text_color(t.muted).child(`${fresh} new · ${fixed} fixed · ${carried} carried`)))
      .child(div().text_size(12).text_color(t.muted).child(`Implementer: ${impl?.note || "—"}`))
      .child(div().text_size(12).text_color(t.muted).child(`Review: ${rev ? `${rev.result}${rev.note ? ` · ${rev.note}` : ""}` : "—"}`));
  });

  return v_flex().id("rv-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(14).gap(16)
    .child(findings.length === 0
      ? div().text_color(t.dim).child("No findings. Review hasn't flagged anything on this task.")
      : v_flex().child(headerRow).children(findings.map(row)))
    .child(v_flex().gap(8).children(perLoop));
}

export { age };
