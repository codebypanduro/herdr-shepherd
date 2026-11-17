// Ship: the PR card on a Ready-to-merge task's Overview, and the Proof tab.
// Loads (they need a cx) are started from main.js ensureDetail; these read what's cached.

import { div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, readTextFile, appHome } from "herdr";
import { MONO } from "./common.js";
import { answerButton } from "./needs.js";

/** Where a task's proof lives: what Shepherd recorded, else the conventional folder. */
export const proofDir = (repo, task) => task.proof ?? (repo ? `${repo.dir}/.herdr/shepherd/proof/${task.id}` : null);

/** `gh pr view` for the task's PR, run in the repo. */
export async function loadPr(repo, task) {
  const r = await exec("gh", ["pr", "view", String(task.pr), "--json",
    "number,url,state,additions,deletions,changedFiles,headRefName,baseRefName,statusCheckRollup,mergeable"],
  { cwd: repo.dir, on: repo.machine, timeout: 20000 }).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
  if (r.code !== 0) return { error: (r.stderr || "gh pr view failed").trim().split("\n")[0], at: Date.now() };
  try { return { ...JSON.parse(r.stdout), at: Date.now() }; } catch { return { error: "gh gave no JSON", at: Date.now() }; }
}

/** proof.json, with its screenshots copied under the app's home so image() can show them. */
export async function loadProof(repo, task) {
  const dir = proofDir(repo, task);
  if (!dir) return { none: true, at: Date.now() };
  const text = await readTextFile(`${dir}/proof.json`, { on: repo.machine }).catch(() => null);
  if (text == null) return { none: true, at: Date.now() };
  let p;
  try { p = JSON.parse(text); } catch (e) { return { error: `proof.json: ${e.message ?? e}`, at: Date.now() }; }
  const rel = `data/shepherd-proof/${encodeURIComponent(repo.key)}/${task.id}`;
  const shots = [];
  if (!repo.machine) {
    await exec("mkdir", ["-p", `${appHome()}/${rel}`]).catch(() => null);
    for (const f of p.screenshots ?? []) {
      const name = String(f).split("/").pop();
      const r = await exec("cp", [`${dir}/${f}`, `${appHome()}/${rel}/${name}`]).catch(() => ({ code: 1 }));
      if (r.code === 0) shots.push({ name, rel: `${rel}/${name}` });
    }
  }
  return {
    checks: Array.isArray(p.checks) ? p.checks : [],
    shots,
    shotCount: (p.screenshots ?? []).length,
    recording: p.recording ? `${dir}/${p.recording}` : null,
    remote: Boolean(repo.machine),
    at: Date.now(),
  };
}

const checkColor = (t, c) => {
  const s = String(c.conclusion ?? c.state ?? c.status ?? "").toUpperCase();
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(s)) return t.done;
  if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(s)) return t.ansi1;
  return t.working;
};
const checkTime = (c) => {
  const a = Date.parse(c.startedAt ?? ""), b = Date.parse(c.completedAt ?? "");
  if (!a || !b) return "";
  const s = Math.round((b - a) / 1000);
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
};

export function renderPrCard(m, task, t) {
  const q = m.questions().find((x) => x.task === task.id && x.kind === "merge");
  const pr = task.pr ? m.pr(task) : null;
  const g = !task.pr ? m.git(task) : null;
  const ci = (task.history ?? []).filter((r) => r.stage === "ci").slice(-1)[0];
  const proof = (task.history ?? []).filter((r) => r.stage === "proof").slice(-1)[0];

  const line = (color, name, right) => h_flex().h(24).gap(8).items_center()
    .child(div().size(7).rounded(4).bg(color))
    .child(div().flex_1().min_w(0).truncate().text_size(12).child(name))
    .child(div().font_family(MONO).text_size(10.5).text_color(t.dim).child(right ?? ""));

  const head = task.pr
    ? `PR #${task.pr}${pr?.state && pr.state !== "OPEN" ? ` · ${pr.state.toLowerCase()}` : ""}`
    : "Local merge · no remote";
  const size = pr && !pr.error ? `${pr.changedFiles} files · +${pr.additions} −${pr.deletions}`
    : g && !g.error ? `${g.files.length} files · +${g.files.reduce((n, f) => n + f.add, 0)} −${g.files.reduce((n, f) => n + f.del, 0)}`
    : "";
  const checks = pr && !pr.error ? (pr.statusCheckRollup ?? []) : [];

  return v_flex().gap(8).p(12).rounded(8).border(1).border_color(t.done).bg(m.tint(t.done, 0.05))
    .child(h_flex().gap(8).items_center()
      .child(div().text_color(t.done).child("⑃"))
      .child(div().font_semibold().text_size(13).child(head))
      .child(div().font_family(MONO).text_size(10.5).text_color(t.muted)
        .child(`${task.branch ?? "—"} → ${pr?.baseRefName ?? "main"}`))
      .child(div().flex_1())
      .child(div().font_family(MONO).text_size(10.5).text_color(t.muted).child(size)))
    .when(Boolean(pr?.error), (el) => el.child(div().text_size(11.5).text_color(t.ansi1).child(pr.error)))
    .child(v_flex()
      .children(checks.map((c) => line(checkColor(t, c), c.name ?? c.context ?? "check", checkTime(c))))
      .when(Boolean(ci), (el) => el.child(line(ci.result === "pass" ? t.done : ci.result === "fail" ? t.ansi1 : t.working,
        `CI · ${ci.note || ci.result}`, "")))
      .when(Boolean(proof), (el) => el.child(line(proof.result === "pass" ? t.done : proof.result === "fail" ? t.ansi1 : t.working,
        `Proof · ${proof.note || proof.result}`, ""))))
    .child(h_flex().gap(8).items_center()
      .when(Boolean(q), (el) => el
        .child(answerButton(t, `pr-merge-${task.id}`, "Squash and merge", true, () => m.answer(q, "Merge")))
        .child(answerButton(t, `pr-back-${task.id}`, "Send back", false, () => m.answer(q, "Send back"))))
      .when(!q, (el) => el.child(div().text_size(11.5).text_color(t.dim).child("Waiting for Shepherd to ask for the merge.")))
      .when(Boolean(task.prUrl), (el) => el.child(div().flex_1()).child(
        div().id(`pr-open-${task.id}`).text_size(11.5).text_color(t.accent).cursor_pointer()
          .on_click(() => exec("open", [task.prUrl]).catch(() => null)).child("Open on GitHub ↗"))));
}

export function renderProof(m, task, t) {
  const p = m.proof(task);
  const empty = (a, b) => v_flex().flex_1().items_center().justify_center().gap(6)
    .child(div().text_color(t.dim).child(a))
    .when(Boolean(b), (el) => el.child(div().text_size(11).text_color(t.dim).child(b)));
  if (!p) return empty("Reading proof…");
  if (p.error) return empty(p.error);
  if (p.none) return empty("No proof yet.", "Screenshots and a recording appear here once the Proof stage runs.");

  return v_flex().id("proof-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(14).gap(16)
    .child(v_flex().gap(6)
      .child(div().text_size(10.5).font_semibold().text_color(t.dim).child("CHECKS"))
      .when(p.checks.length === 0, (el) => el.child(div().text_color(t.dim).child("No checks recorded.")))
      .children(p.checks.map((c, i) => h_flex().id(`pc-${i}`).gap(8).items_start().py(4)
        .child(div().w(14).text_color(c.pass ? t.done : t.ansi1).child(c.pass ? "✓" : "✕"))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(12.5).child(c.name ?? "check"))
          .when(Boolean(c.note), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(c.note)))))))
    .when(p.shotCount > 0, (el) => el.child(v_flex().gap(8)
      .child(div().text_size(10.5).font_semibold().text_color(t.dim).child("SCREENSHOTS"))
      .when(p.remote, (e2) => e2.child(div().text_size(11.5).text_color(t.dim)
        .child("Screenshots are on another machine; they show only for this computer's spaces.")))
      .child(h_flex().flex_wrap().gap(10).children(p.shots.map((s) => v_flex().id(`shot-${s.name}`).w(260).gap(4)
        .child(div().w(260).h(162).rounded(6).overflow_hidden().border(1).border_color(t.border).bg(t.background)
          .child(image(s.rel).size_full()))
        .child(div().truncate().font_family(MONO).text_size(10.5).text_color(t.dim).child(s.name)))))))
    .when(Boolean(p.recording), (el) => el.child(h_flex().gap(8).items_center()
      .child(div().text_size(10.5).font_semibold().text_color(t.dim).child("RECORDING"))
      .child(answerButton(t, "proof-rec", `Open ${p.recording.split("/").pop()}`, false,
        () => exec("open", [p.recording]).catch(() => null)))));
}
