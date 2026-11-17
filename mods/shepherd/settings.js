// Workflow settings (⚙ Workflow; dialog, panel "workflow") and Space settings (⚙ on a space row;
// dialog, panel "spacesettings"). Workflow writes the person's shepherd/workflow.json (made from
// workflow.example.json the first time); Space settings writes the space's .herdr/orchestra.json,
// whose keys win over the workflow's. Both show the machine load limits with each machine's load.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { spaces, terminals, readTextFile, writeTextFile, exec, run, closeOverlay, props } from "herdr";
import { MONO, LIMITS, MAX_LOOPS, palette, machineOf } from "./common.js";
import { machineList, machineByName, bar, machineIcon } from "./machines.js";
import { folders, folderOf, setFolder } from "./sidebar.js";

const BUILD = ["implement", "review", "ci", "proof"];
const MODELS = ["opus", "sonnet", "haiku"];
const CPU_OPTS = [60, 70, 80, 90];
const MEM_OPTS = [70, 80, 85, 95];

/** The person's workflow file for Shepherd's label: workflow.json beside workflow.example.json. */
export const personalWorkflow = (label) => (label ? label.replace(/workflow\.example\.json$/, "workflow.json") : null);

/** Reads JSON on a machine, edits it with `change`, and writes it back whole: atomically here,
 *  with node there. `base` fills a file that doesn't exist yet. */
async function editJson(path, machine, change, base = null) {
  const before = await readTextFile(path, { on: machine }).catch(() => null);
  const start = before ?? (base ? await readTextFile(base, { on: machine }).catch(() => null) : null);
  const obj = start ? JSON.parse(start) : {};
  change(obj);
  const text = `${JSON.stringify(obj, null, 2)}\n`;
  if (!machine) {
    if (before == null) await exec("mkdir", ["-p", path.replace(/\/[^/]*$/, "")]).catch(() => null);
    await writeTextFile(path, text, before);
    return;
  }
  const code = 'const fs=require("fs"),p=process.argv[1];fs.mkdirSync(require("path").dirname(p),{recursive:true});fs.writeFileSync(p+".tmp",process.argv[2]);fs.renameSync(p+".tmp",p)';
  const r = await exec("node", ["-e", code, path, text], { on: machine, timeout: 15000 });
  if (r.code !== 0) throw new Error(r.stderr || "node failed");
}

/** Build-stage agents running per machine: terminals labelled with a build stage. */
const runningOn = (name) => terminals().filter((x) => x.state === "live" && BUILD.includes(x.labels?.["shepherd.stage"])
  && machineOf(x) === name).length;

const seg = (t, id, label, on, onClick) => div().id(id).h(24).px(9).flex().items_center().rounded(5).border(1)
  .cursor_pointer().text_size(12).font_family(MONO)
  .border_color(on ? t.foreground : t.input).bg(on ? t.foreground : t.background).text_color(on ? t.background : t.muted)
  .hover((s) => (on ? s : s.text_color(t.foreground)))
  .on_click(onClick).child(label);

const check = (t, id, label, on, onClick) => h_flex().id(id).gap(6).items_center().cursor_pointer().text_size(12)
  .on_click(onClick)
  .child(div().size(14).rounded(3).border(1).flex().items_center().justify_center().text_size(10)
    .border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background).text_color(t.accent_foreground).child(on ? "✓" : ""))
  .child(label);

/** Options with the current value added when it isn't one of them. */
const withValue = (opts, v) => (v != null && !opts.includes(v) ? [...opts, v].sort((a, b) => (typeof a === "number" ? a - b : 0)) : opts);

/** One machine's load against the limits: name, cpu and mem bars with the limit tick, state. */
export function loadRow(t, mc, limits) {
  const full = mc.cpu != null && (mc.cpu >= limits.maxCpu || mc.mem >= limits.maxMem);
  const near = !full && mc.cpu != null && (mc.cpu >= limits.maxCpu - 10 || mc.mem >= limits.maxMem - 10);
  const n = runningOn(mc.name);
  const state = !mc.online ? "unreachable" : mc.cpu == null ? "…" : full ? "at limit" : near ? `${n} running · near` : `${n} running`;
  return h_flex().gap(12).items_center()
    .child(h_flex().w(110).gap(6).items_center().flex_none()
      .child(machineIcon(t, mc, { dotRing: t.surface }))
      .child(div().truncate().text_size(12).child(mc.label)))
    .child(bar(t, "cpu", mc.cpu, limits.maxCpu))
    .child(bar(t, "mem", mc.mem, limits.maxMem))
    .child(div().w(104).flex_none().font_family(MONO).text_size(10.5).text_color(full ? t.ansi1 : near ? t.blocked : t.dim).child(state));
}

const row = (t, mark, title, sub, right) => h_flex().gap(12).px(16).py(11).items_center().border_b(1).border_color(t.border)
  .child(div().w(18).flex_none().font_family(MONO).text_size(11).text_color(t.dim).child(mark))
  .child(v_flex().flex_1().min_w(0).gap(2)
    .child(title)
    .child(div().text_size(11.5).text_color(t.dim).child(sub)))
  .child(right ?? div());

const title = (t, text, skill) => h_flex().gap(6).items_center().text_size(13)
  .child(text).when(Boolean(skill), (el) => el.child(div().font_family(MONO).text_size(10.5).text_color(t.dim).child(skill)));

// ---- Workflow settings -----------------------------------------------------------------------

export function initWorkflow(m, cx) {
  m.wf = { saving: false, error: null };
  cx.spawn(async (cx) => { const repo = m.repo(); if (repo) await m.load(repo); cx.notify(); });
}

/** Sets one key path in the person's workflow file and reloads. */
function setWorkflow(m, cx, path, value) {
  const repo = m.repo();
  const label = repo?.workflow;
  if (!label) { m.wf.error = "No Shepherd in this space: its workflow file is unknown."; cx.notify(); return; }
  const file = personalWorkflow(label);
  cx.spawn(async (cx) => {
    try {
      await editJson(file, repo.machine, (o) => {
        let at = o;
        for (const k of path.slice(0, -1)) at = (at[k] = { ...(at[k] ?? {}) });
        at[path[path.length - 1]] = value;
      }, label);
      m.wf.error = null;
      await m.load(repo);
    } catch (e) { m.wf.error = `workflow.json: ${e.message ?? e}`; }
    cx.notify();
  });
}

export function renderWorkflow(m) {
  const t = palette();
  const repo = m.repo();
  const d = repo ? m.data[repo.key] : null;
  const wf = d?.wf ?? {};
  const s = m.settings();
  const st = wf.stages ?? {};
  const set = (path, v) => (_e, cx) => setWorkflow(m, cx, path, v);
  const models = (stage, cur) => h_flex().gap(4).children(withValue(MODELS, cur).map((mo) =>
    seg(t, `wf-${stage}-${mo}`, mo, mo === cur, stage === "shepherd" ? set(["shepherd", "model"], mo) : set(["stages", stage, "model"], mo))));
  const lim = { ...LIMITS, ...wf.limits };
  const alerts = { toast: true, sound: true, phone: false, ...wf.alerts };
  const proof = st.proof ?? {};
  const file = personalWorkflow(repo?.workflow);

  return v_flex().id("workflow-settings").size_full().bg(t.surface).text_color(t.foreground)
    .child(v_flex().px(18).pt(16).pb(12).gap(4).border_b(1).border_color(t.border)
      .child(div().text_size(15).font_semibold().child("Workflow"))
      .child(div().text_size(12).text_color(t.dim).child(`Matt Pocock's flow · ${wf.skills ?? "mattpocock/skills"}`)))
    .child(v_flex().id("wf-rows").flex_1().min_h(0).overflow_y_scrollbar()
      .child(h_flex().mx(16).my(10).px(10).py(8).gap(8).rounded(6).bg(t.background).border(1).border_color(t.border)
        .font_family(MONO).text_size(11.5)
        .child(div().text_color(t.dim).child("$"))
        .child(div().flex_1().child(`npx skills add ${wf.skills ?? "mattpocock/skills"}`))
        .child(div().text_color(t.dim).child(`tracker: ${trackerName(wf.tracker)}`)))
      .child(row(t, "✳", title(t, "Shepherd"), "The agent you talk to. It plans the flow, hands out work and asks you questions.", models("shepherd", wf.shepherd?.model)))
      .child(row(t, "01", title(t, "Triage", "/triage"), "Only for issues from other people. Your own work skips it.", models("triage", st.triage?.model)))
      .child(row(t, "02", title(t, "Spec / wayfinder", "/to-spec · /wayfinder"), "Grills you in rounds, then writes one spec.",
        h_flex().gap(4).children(withValue([1, 3, 5], st.spec?.grillQuestionsPerRound).map((n) =>
          seg(t, `wf-grill-${n}`, `${n} q`, n === (st.spec?.grillQuestionsPerRound ?? 3), set(["stages", "spec", "grillQuestionsPerRound"], n))))))
      .child(row(t, "03", title(t, "To tickets", "/to-tickets"), "Vertical slices with blocking edges. You approve the breakdown.",
        div().text_size(12).text_color(t.muted).child("Asks you to approve")))
      .child(row(t, "04", title(t, "Implement", "/implement"), "Builds one ticket and fixes review notes.", models("implement", st.implement?.model)))
      .child(row(t, "05", title(t, "Code review", "/code-review"), "Findings send the ticket back to Implement.", models("review", st.review?.model)))
      .child(row(t, "06", title(t, "CI checks"), "Runs on the ticket's PR. A failing check counts as a loop.",
        h_flex().gap(6).items_center().text_size(12).text_color(t.muted).child("Set per space:")
          .child(svg("mods/shepherd/icons/gear.svg").size(12).text_color(t.dim)).child("on each space")))
      .child(row(t, "07", title(t, "Proof"), "Tests the app in a headless browser and records what it saw.",
        h_flex().gap(12)
          .child(check(t, "wf-shots", "Screenshots", proof.screenshots !== false, set(["stages", "proof", "screenshots"], proof.screenshots === false)))
          .child(check(t, "wf-video", "Screen recording", proof.recording !== false, set(["stages", "proof", "recording"], proof.recording === false)))))
      .child(row(t, "↻", title(t, "Max build loops"), "Implement → review → CI → proof. After this, Shepherd asks you.",
        h_flex().gap(4).children([1, 2, 3, 4, 5].map((n) => seg(t, `wf-loops-${n}`, String(n), n === (wf.maxLoops ?? MAX_LOOPS), set(["maxLoops"], n))))))
      .child(row(t, "!", title(t, "When an agent needs you"), alerts.phone && !alerts.ntfy ? "Phone push needs alerts.ntfy (an ntfy.sh topic) in workflow.json."
        : "A toast, a sound and a push to your phone (ntfy.sh).",
        h_flex().gap(12)
          .child(check(t, "wf-toast", "Toast", alerts.toast !== false, set(["alerts", "toast"], alerts.toast === false)))
          .child(check(t, "wf-sound", "Sound", alerts.sound !== false, set(["alerts", "sound"], alerts.sound === false)))
          .child(check(t, "wf-phone", "Phone", Boolean(alerts.phone), set(["alerts", "phone"], !alerts.phone)))))
      .child(limitsBlock(t, "wf", lim, (k, v) => set(["limits", k], v), machineList(),
        "Shepherd starts another ticket only while the space's machine is under both limits. The rest wait in Tickets.",
        s.limits.maxCpu !== lim.maxCpu || s.limits.maxMem !== lim.maxMem ? "This space overrides them in its settings." : null)))
    .child(h_flex().px(16).py(10).gap(8).items_center().border_t(1).border_color(t.border)
      .child(div().flex_1().truncate().font_family(MONO).text_size(10.5).text_color(m.wf.error ? t.ansi1 : t.dim)
        .child(m.wf.error ?? (file ? file.replace(/^.*\/(shepherd\/workflow\.json)$/, "$1") : "no Shepherd in this space")))
      .child(div().id("wf-done").px(14).h(28).flex().items_center().rounded(5).cursor_pointer().text_size(12).font_semibold()
        .bg(t.solid).text_color(t.solid_foreground).on_click(() => closeOverlay(props()?.overlay)).child("Done")));
}

const trackerName = (x) => ({ github: "GitHub issues", linear: "Linear", gitlab: "GitLab issues" }[x] ?? x ?? "GitHub issues");

/** Max CPU and Max memory as chips, then each machine's load against them. */
function limitsBlock(t, id, lim, pick, ms, sub, note, extra = null) {
  return v_flex().px(16).py(12).gap(12)
    .child(h_flex().gap(12)
      .child(div().w(18).flex_none().font_family(MONO).text_size(11).text_color(t.dim).child("∥"))
      .child(v_flex().flex_1().gap(2)
        .child(div().text_size(13).child("Machine load limits"))
        .child(div().text_size(11.5).text_color(t.dim).child(sub))
        .when(Boolean(note), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(note)))))
    .child(h_flex().pl(30).gap(8).items_center().flex_wrap()
      .child(div().w(64).text_size(12).text_color(t.muted).child("Max CPU"))
      .child(h_flex().gap(4).children(withValue(CPU_OPTS, lim.maxCpu).map((n) => seg(t, `${id}-cpu-${n}`, `${n}%`, n === lim.maxCpu, pick("maxCpu", n)))))
      .child(div().w(12))
      .child(div().w(78).text_size(12).text_color(t.muted).child("Max memory"))
      .child(h_flex().gap(4).children(withValue(MEM_OPTS, lim.maxMem).map((n) => seg(t, `${id}-mem-${n}`, `${n}%`, n === lim.maxMem, pick("maxMem", n)))))
      .when(Boolean(extra), (el) => el.child(extra)))
    .child(v_flex().ml(30).p(10).gap(10).rounded(6).bg(t.background).border(1).border_color(t.border)
      .children(ms.map((mc) => loadRow(t, mc, lim))));
}

// ---- Space settings --------------------------------------------------------------------------

export function initSpaceSettings(m, cx, InputState) {
  const s = spaces().find((x) => x.id === props()?.space);
  m.ss = { error: null };
  m.ssName = InputState.new({ placeholder: s?.name ?? "" });
  m.ssName.set_value(s?.named ? s.name : "");
  m.ssCi = InputState.new({ placeholder: "pnpm lint && pnpm test" });
  const rename = () => { const sp = ssSpace(); if (sp && m.ssName.value().trim() !== (sp.named ? sp.name : "")) run("space.rename", { id: sp.id, name: m.ssName.value().trim() }); };
  m.ssName.on("submit", rename);
  m.ssName.on("blur", rename);
  const saveCi = (_e, cx) => {
    const v = m.ssCi.value().trim();
    if (v === (m.ss.ci ?? "")) return;
    setOrchestra(m, cx, (o) => { o.stages = { ...(o.stages ?? {}), ci: { ...(o.stages?.ci ?? {}), command: v || undefined } }; });
  };
  m.ssCi.on("submit", saveCi);
  m.ssCi.on("blur", saveCi);
  cx.spawn(async (cx) => {
    const repo = s ? m.repo(s) : null;
    if (repo) await m.load(repo);
    const st = repo ? m.data[repo.key] : null;
    m.ss.ci = st?.orch?.stages?.ci?.command ?? "";
    m.ssCi.set_value(m.ss.ci);
    // The repo's remote and branch, for the header.
    if (repo) {
      const r = await exec("sh", ["-c", 'git -C "$1" remote get-url origin 2>/dev/null; echo "--"; git -C "$1" branch --show-current 2>/dev/null', "x", repo.dir],
        { on: repo.machine, timeout: 10000 }).catch(() => null);
      const [url = "", branch = ""] = (r?.stdout ?? "").split("--\n");
      m.ss.remote = url.trim().replace(/^(git@|https:\/\/)/, "").replace(/:/, "/").replace(/\.git$/, "") || null;
      m.ss.branch = branch.trim() || s.branch;
    }
    cx.notify();
  });
}

const ssSpace = () => spaces().find((x) => x.id === props()?.space) ?? null;

function setOrchestra(m, cx, change) {
  const s = ssSpace();
  const repo = s ? m.repo(s) : null;
  if (!repo) return;
  cx.spawn(async (cx) => {
    try {
      await editJson(`${repo.dir}/.herdr/orchestra.json`, repo.machine, change);
      m.ss.error = null;
      await m.load(repo);
      m.ss.ci = m.data[repo.key]?.orch?.stages?.ci?.command ?? "";
    } catch (e) { m.ss.error = `orchestra.json: ${e.message ?? e}`; }
    cx.notify();
  });
}

export function renderSpaceSettings(m) {
  const t = palette();
  const s = ssSpace();
  if (!s) return v_flex().size_full().p(18).bg(t.surface).text_color(t.dim).child("This space is gone.");
  const repo = m.repo(s);
  const d = repo ? m.data[repo.key] : null;
  const orch = d?.orch ?? {};
  const wfLim = { ...LIMITS, ...d?.wf?.limits };
  const lim = { ...wfLim, ...orch.limits };
  const own = Boolean(orch.limits?.maxCpu || orch.limits?.maxMem);
  const sh = m.shepherd(s);
  const mc = machineByName(s.machine);
  const fid = folderOf(s.id);
  const field = (label, sub, right) => h_flex().gap(16).px(18).py(12).items_center().border_b(1).border_color(t.border)
    .child(v_flex().w(210).flex_none().gap(2)
      .child(div().text_size(13).child(label))
      .child(div().text_size(11.5).text_color(t.dim).child(sub)))
    .child(h_flex().flex_1().min_w(0).justify_end().child(right));
  const chip = (id, label, on, onClick) => seg(t, id, label, on, onClick);
  const where = `${mc?.label ?? s.machine ?? "this mac"}:${(repo?.dir ?? s.folder ?? "").replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, "~")}`;
  const setLim = (k, v) => (_e, cx) => setOrchestra(m, cx, (o) => { o.limits = { ...(o.limits ?? {}), [k]: v }; });
  const clearLim = (_e, cx) => setOrchestra(m, cx, (o) => { o.limits = undefined; });

  return v_flex().id("space-settings").size_full().bg(t.surface).text_color(t.foreground)
    .child(h_flex().px(18).pt(16).pb(12).gap(12).items_center().border_b(1).border_color(t.border)
      .child(v_flex().flex_1().min_w(0).gap(4)
        .child(Input.new(m.ssName).h(30).px(6).text_size(15).font_semibold().rounded(5).border(1).border_color(t.border).bg(t.surface))
        .child(h_flex().gap(6).items_center().font_family(MONO).text_size(11).text_color(t.muted)
          .when(Boolean(mc), (el) => el.child(machineIcon(t, mc, { size: 0.78, dotRing: t.surface })))
          .child(div().truncate().child(where)))
        .child(div().font_family(MONO).text_size(11).text_color(t.dim).truncate()
          .child(`${m.ss.remote ?? "no remote"} · ${m.ss.branch ?? s.branch ?? "—"}`))))
    .child(v_flex().id("ss-rows").flex_1().min_h(0).overflow_y_scrollbar()
      .child(field("CI checks", "Runs on each ticket's PR in this repo. A failing check counts as a loop.",
        Input.new(m.ssCi).w_full().h(30).px(8).font_family(MONO).text_size(12).rounded(5).border(1).border_color(t.input).bg(t.background)))
      .child(field("Folder", "Where it sits in the sidebar. You can also drag it.",
        h_flex().gap(4).flex_wrap().justify_end()
          .child(chip("ss-nofolder", "No folder", !fid, () => setFolder(s.id, null)))
          .children(folders().map((f) => chip(`ss-f-${f.id}`, f.name, fid === f.id, () => setFolder(s.id, f.id))))))
      .child(field("Machine", "Where this space's agents run. A space lives on one machine: make a new space to run on another.",
        h_flex().gap(4).flex_wrap().justify_end().children(machineList().map((x) =>
          div().h(24).px(9).flex().items_center().gap(6).rounded(5).border(1).text_size(12)
            .border_color(x.name === s.machine ? t.foreground : t.input).bg(x.name === s.machine ? t.foreground : t.background)
            .text_color(x.name === s.machine ? t.background : t.dim)
            .child(x.label).child(div().font_family(MONO).text_size(10.5).child(x.cpu != null ? `cpu ${x.cpu}%` : ""))))))
      .child(field("Shepherd", "One per space. It talks to you for this repo only.",
        sh ? div().font_family(MONO).text_size(12).text_color(t.muted).child(`claude · ${d?.wf?.shepherd?.model ?? "opus"} · ${sh.address}`)
          : s.machine ? div().text_size(12).text_color(t.dim).child("Run shepherd/start.sh in a terminal there")
            : div().id("ss-start").px(10).h(26).flex().items_center().rounded(5).cursor_pointer().text_size(12).font_semibold()
              .bg(t.solid).text_color(t.solid_foreground).on_click(() => m.startShepherd(s)).child("Start Shepherd")))
      .child(field("Issue tracker", "Where triage reads and to-tickets writes.",
        div().text_size(12).text_color(t.muted).child(trackerName(d?.wf?.tracker))))
      .child(limitsBlock(t, "ss", lim, setLim, mc ? [mc] : [],
        "Only for this space, over the workflow's. Shepherd starts a ticket while this machine is under both.",
        null, chip("ss-lim-wf", "workflow's", !own, clearLim))))
    .child(h_flex().px(16).py(10).gap(8).items_center().border_t(1).border_color(t.border)
      .child(div().flex_1().truncate().font_family(MONO).text_size(10.5).text_color(m.ss.error ? t.ansi1 : t.dim)
        .child(m.ss.error ?? ".herdr/orchestra.json"))
      .child(div().id("ss-done").px(14).h(28).flex().items_center().rounded(5).cursor_pointer().text_size(12).font_semibold()
        .bg(t.solid).text_color(t.solid_foreground).on_click(() => closeOverlay(props()?.overlay)).child("Done")));
}
