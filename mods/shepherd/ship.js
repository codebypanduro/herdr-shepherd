// Ship: the PR card on a Ready-to-merge task's Overview, and the Proof tab.
// Loads (they need a cx) are started from main.js ensureDetail; these read what's cached.

import { div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, readTextFile, writeTextFile, appHome } from "herdr";
import { MONO, tint, plural, clock, spanClock, sectionHeading, stateColor, proofBrowser } from "./common.js";
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

/** Copies a file from another machine to `dest` here: base64 over exec (binary-safe), decoded locally. */
async function fetchRemote(machine, src, dest, timeout = 60000) {
  const r = await exec("sh", ["-c", 'base64 < "$1"', "fetch", src], { on: machine, timeout }).catch(() => null);
  if (!r || r.code !== 0) return false;
  const b64 = `${dest}.b64`;
  await writeTextFile(b64, r.stdout.replace(/\s+/g, "")).catch(() => null);
  const d = await exec("sh", ["-c", 'base64 -d < "$1" > "$2"; c=$?; rm -f "$1"; exit $c', "decode", b64, dest]).catch(() => ({ code: 1 }));
  return d.code === 0;
}

/** proof.json, with its screenshots copied under the app's home so image() can show them. A space on
 *  another machine has them copied over once per proof.json (a changed proof.json starts a fresh copy). */
export async function loadProof(repo, task) {
  const dir = proofDir(repo, task);
  if (!dir) return { none: true, at: Date.now() };
  const text = await readTextFile(`${dir}/proof.json`, { on: repo.machine }).catch(() => null);
  if (text == null) return { none: true, at: Date.now() };
  let p;
  try { p = JSON.parse(text); } catch (e) { return { error: `proof.json: ${e.message ?? e}`, at: Date.now() }; }
  const rel = `data/shepherd-proof/${encodeURIComponent(repo.key)}/${task.id}`;
  const local = `${appHome()}/${rel}`;
  const shots = [];
  if (repo.machine) {
    const seen = await readTextFile(`${local}/proof.json`).catch(() => null);
    if (seen !== text) {
      await exec("sh", ["-c", 'rm -rf "$1" && mkdir -p "$1"', "fresh", local]).catch(() => null);
      await writeTextFile(`${local}/proof.json`, text).catch(() => null);
    }
  } else await exec("mkdir", ["-p", local]).catch(() => null);
  for (const f of p.screenshots ?? []) {
    const name = String(f).split("/").pop();
    const dest = `${local}/${name}`;
    const ok = repo.machine
      ? (await exec("test", ["-s", dest]).catch(() => ({ code: 1 }))).code === 0 || await fetchRemote(repo.machine, `${dir}/${f}`, dest)
      : (await exec("cp", [`${dir}/${f}`, dest]).catch(() => ({ code: 1 }))).code === 0;
    if (ok) shots.push({ name, rel: `${rel}/${name}` });
  }
  return {
    checks: Array.isArray(p.checks) ? p.checks : [],
    recordingLength: clock(p.recordingLength ?? p.recordingSeconds),
    shots,
    shotCount: (p.screenshots ?? []).length,
    recording: p.recording ? `${dir}/${p.recording}` : null,
    // Another machine's recording is copied here on ▶ (it can be large), then opened.
    recordingLocal: p.recording && repo.machine ? `${local}/${String(p.recording).split("/").pop()}` : null,
    machine: repo.machine ?? null,
    remote: Boolean(repo.machine),
    at: Date.now(),
  };
}

/** Opens a video in its default app; with none for the type (.webm on a stock Mac), in Chrome, then Safari. */
async function openVideo(path) {
  for (const args of [[path], ["-a", "Google Chrome", path], ["-a", "Safari", path]]) {
    const r = await exec("open", args).catch(() => ({ code: 1 }));
    if (r.code === 0) return true;
  }
  return false;
}

/** ▶ on the recording: open it here; another machine's is copied over first (once). */
async function openRecording(m, p, notify) {
  if (!p.recordingLocal) return openVideo(p.recording);
  const have = (await exec("test", ["-s", p.recordingLocal]).catch(() => ({ code: 1 }))).code === 0;
  if (!have) {
    m.recFetch = { path: p.recording, state: "copying" };
    notify();
    const ok = await fetchRemote(p.machine, p.recording, p.recordingLocal, 300000);
    m.recFetch = ok ? null : { path: p.recording, state: "failed" };
    notify();
    if (!ok) return null;
  }
  return openVideo(p.recordingLocal);
}

/** A GitHub check's state: "pass", "fail" or "run". */
const checkState = (c) => {
  const s = String(c.conclusion || c.state || c.status || "").toUpperCase();
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(s)) return "pass";
  if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(s)) return "fail";
  return "run";
};
const runTime = (r) => spanClock(r?.start, r?.end);
const resultState = (r) => (r.result === "pass" ? "pass" : r.result === "fail" ? "fail" : "run");

export function renderPrCard(m, task, t) {
  const q = m.questionsOf(task).find((x) => x.kind === "merge");
  const pr = task.pr ? m.pr(task) : null;
  const g = m.git(task);
  const runs = task.history ?? [];
  const last = (stage) => runs.filter((r) => r.stage === stage).slice(-1)[0];
  const ci = last("ci"), proof = last("proof");
  const approved = runs.filter((r) => r.stage === "review" && r.result === "pass").slice(-1)[0];
  const stageSetting = (stage, key) => m.settings().stages?.[stage]?.[key] ?? "";

  // Every check: GitHub's, then Shepherd's CI (its command, its note: "212/212") and Proof.
  const checks = [
    ...(pr && !pr.error ? pr.statusCheckRollup ?? [] : []).map((c) => ({
      state: checkState(c), name: c.name ?? c.context ?? "check", cmd: c.workflowName ?? "",
      meta: String(c.conclusion || c.state || c.status || "").toLowerCase(),
      time: spanClock(c.startedAt, c.completedAt),
    })),
    ...(ci ? [{ state: resultState(ci), name: "CI", cmd: stageSetting("ci", "command"), meta: ci.note || ci.result, time: runTime(ci) }] : []),
    ...(proof ? [{ state: resultState(proof), name: "Proof", cmd: proofBrowser(m.settings().stages?.proof), meta: proof.note || proof.result, time: runTime(proof) }] : []),
  ];
  const failing = checks.filter((c) => c.state === "fail").length;
  const running = checks.filter((c) => c.state === "run").length;
  const summary = !checks.length ? { mark: "○", color: t.dim, text: "No checks recorded" }
    : failing ? { mark: "✕", color: stateColor(t, "fail"), text: `${failing} of ${plural(checks.length, "check")} failing` }
    : running ? { mark: "●", color: stateColor(t, "running"), text: `${checks.length - running} of ${checks.length} checks passed · ${running} running` }
    : { mark: "✓", color: stateColor(t, "pass"), text: `All ${plural(checks.length, "check")} passed` };
  const reviewText = approved ? ` · review approved on loop ${approved.loop ?? 1}` : "";

  const size = pr && !pr.error ? `${plural(pr.changedFiles, "file")} · +${pr.additions} −${pr.deletions}`
    : g && !g.error ? `${plural(g.files.length, "file")} · +${g.files.reduce((n, f) => n + f.add, 0)} −${g.files.reduce((n, f) => n + f.del, 0)}`
    : "";
  const head = task.pr
    ? `PR #${task.pr}${pr?.state && pr.state !== "OPEN" ? ` (${pr.state.toLowerCase()})` : ""} · ${task.title ?? task.id}`
    : `Local merge · ${task.title ?? task.id}`;
  const sub = [`${task.branch ?? "—"} → ${pr?.baseRefName ?? "main"}`, size, task.pr ? "" : "no remote"].filter(Boolean).join(" · ");
  const markOf = (s) => [s === "pass" ? "✓" : s === "fail" ? "✕" : "●", stateColor(t, s === "run" ? "running" : s)];
  const mono = (text, c = t.dim) => div().flex_none().font_family(MONO).text_size(11).text_color(c).child(text);

  return v_flex().rounded(7).border(1).border_color(tint(t.done, 0.45)).overflow_hidden()
    .child(h_flex().gap(10).px(14).py(12).items_center().bg(tint(t.done, 0.08))
      .child(div().size(26).flex_none().rounded(13).bg(t.done).text_color(t.background)
        .flex().items_center().justify_center().text_size(13).child("⑃"))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_size(13.5).font_semibold().child(head))
        .child(div().truncate().font_family(MONO).text_size(11).text_color(t.muted).child(sub))))
    .child(v_flex().px(14).pt(6).pb(8)
      .child(h_flex().gap(8).py(6).items_center().text_size(12).text_color(t.muted)
        .child(div().text_color(summary.color).child(summary.mark))
        .child(div().min_w(0).truncate().child(`${summary.text}${reviewText}`)))
      .when(Boolean(pr?.error), (el) => el.child(div().py(4).text_size(11.5).text_color(t.ansi1).child(pr.error)))
      .children(checks.map((c) => {
        const [mark, color] = markOf(c.state);
        return h_flex().gap(10).py(6).items_center().border_t(1).border_color(t.border).text_size(12.5)
          .child(div().w(16).flex_none().font_family(MONO).text_color(color).child(mark))
          .child(h_flex().flex_1().min_w(0).gap(6).items_center()
            .child(div().flex_none().child(c.name))
            .when(Boolean(c.cmd), (el) => el.child(div().min_w(0).truncate().font_family(MONO).text_size(11).text_color(t.dim).child(c.cmd))))
          .when(Boolean(c.meta), (el) => el.child(div().max_w(200).truncate().font_family(MONO).text_size(11).text_color(t.dim).child(c.meta)))
          .when(Boolean(c.time), (el) => el.child(mono(c.time)));
      })))
    .child(h_flex().flex_wrap().gap(8).px(14).py(10).items_center().border_t(1).border_color(t.border)
      .when(Boolean(q), (el) => el
        .child(answerButton(t, `pr-merge-${task.id}`, "Squash and merge", false, () => m.answer(q, "Merge"), { solid: t.done, icon: "⑃" }))
        .child(answerButton(t, `pr-back-${task.id}`, "Send back", false, () => m.answer(q, "Send back"))))
      .when(!q, (el) => el.child(div().text_size(11.5).text_color(t.dim).child("Waiting for Shepherd to ask for the merge.")))
      .when(Boolean(task.prUrl), (el) => el.child(div().id(`pr-open-${task.id}`).text_size(11.5).text_color(t.accent).cursor_pointer()
        .on_click(() => exec("open", [task.prUrl]).catch(() => null)).child("Open on GitHub ↗")))
      .child(div().flex_1())
      .when(Boolean(q), (el) => el.child(div().text_size(11.5).text_color(t.dim).child("Deletes the branch and worktree after merge"))));
}

export function renderProof(m, task, t) {
  const p = m.proof(task);
  const empty = (a) => v_flex().flex_1().px(24).items_center().justify_center()
    .child(div().text_size(13).text_color(t.dim).child(a));
  if (!p) return empty("Reading proof…");
  if (p.error) return empty(p.error);
  if (p.none) return empty("Screenshots, checks and a recording show up here when the task reaches Proof.");
  const heading = (text) => sectionHeading(t, text);

  return v_flex().id("proof-scroll").flex_1().min_h(0).overflow_y_scrollbar().px(18).py(16).gap(16)
    .child(v_flex()
      .child(div().pb(6).child(heading(`CHECKS · ${proofBrowser(m.settings().stages?.proof).toUpperCase()}`)))
      .when(p.checks.length === 0, (el) => el.child(div().py(6).border_t(1).border_color(t.border).text_color(t.dim).child("No checks recorded.")))
      .children(p.checks.map((c, i) => h_flex().id(`pc-${i}`).gap(10).py(6).items_start().border_t(1).border_color(t.border)
        .child(div().w(16).flex_none().font_family(MONO).text_color(stateColor(t, c.pass ? "pass" : "fail")).child(c.pass ? "✓" : "✕"))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(13).child(c.name ?? "check"))
          .when(Boolean(c.note), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(c.note))))
        .when(Boolean(clock(c.time)), (el) => el.child(div().flex_none().font_family(MONO).text_size(11).text_color(t.dim).child(clock(c.time)))))))
    .when(p.shotCount > 0, (el) => el.child(v_flex().gap(8)
      .child(heading("SCREENSHOTS"))
      .when(p.remote, (e2) => e2.child(div().text_size(11.5).text_color(t.dim)
        .when(p.shots.length < p.shotCount, (e3) => e3.child("Copying screenshots from the other machine…"))))
      .child(h_flex().flex_wrap().gap(10).children(p.shots.map((s) => v_flex().id(`shot-${s.name}`).w(260).gap(4)
        .child(div().w(260).h(162).rounded(6).overflow_hidden().border(1).border_color(t.border).bg(t.background)
          .child(image(s.rel).size_full()))
        .child(div().truncate().font_family(MONO).text_size(10.5).text_color(t.dim).child(s.name)))))))
    // The recording as a row: ▶, "Screen recording", its file and length; a click opens it.
    .when(Boolean(p.recording), (el) => el.child(h_flex().id("proof-rec").gap(10).px(12).py(10).items_center()
      .rounded(6).border(1).border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => cx.spawn(async (cx) => { await openRecording(m, p, () => cx.notify()); }))
      .child(div().size(28).flex_none().rounded(14).bg(t.raised).flex().items_center().justify_center()
        .text_size(10).text_color(t.foreground).child("▶"))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().text_size(13).child("Screen recording"))
        .child(div().truncate().font_family(MONO).text_size(11).text_color(t.dim)
          .child([p.recording.split("/").pop(), p.recordingLength,
            m.recFetch?.path === p.recording ? (m.recFetch.state === "copying" ? "copying from the other machine…" : "couldn't copy it from the other machine") : null]
            .filter(Boolean).join(" · "))))));
}
