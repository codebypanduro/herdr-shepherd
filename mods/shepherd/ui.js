// Pieces the sidebar, its popovers and the settings dialogs share: shared-state keys, the chip and
// the check box, git facts about a repo, the person's one workflow file, safe JSON writes, and the
// openers for every overlay (the tab bar, the board's keys and the sidebar all open them).

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, readTextFile, writeTextFile, appHome, openOverlay, closeOverlay, terminals, hc, shared, setShared, spaces } from "herdr";
import { MONO, machineOf, localId } from "./common.js";

export const MACHINE_INFO = "shepherd.machineInfo"; // { "<machine name, '' here>": {cpu, mem, disk, kind, model, tools, at, error} }
export const MACHINE_KINDS = "shepherd.machineKinds"; // the person's pick in Add machine: { name: kind }
export const USAGE = "shepherd.usage"; // { at, by: { "<machine, '' here>": { claude|codex: {pct, detail, resets, parts, at, error} } }, failed? }
export const FOLDERS = "shepherd.folders"; // sidebar folders: [{ id, name, open }]
export const SPACE_FOLDERS = "shepherd.spaceFolders"; // { space id: folder id }
export const NEW_SPACE = "shepherd.newSpace"; // New space's pending { folder, real, before, group, start, at }
export const STARTABLE = "shepherd.startable"; // { "<machine, '' here>": { ...shepherdOn's answer, at } }: whether start.sh can run there
export const STARTING = "shepherd.starting"; // { space id: ms }: a start asked for that space, until its Shepherd shows (any copy)
export const RESTARTING = "shepherd.restarting"; // { space id: ms }: a Restart Shepherd running for that space (any copy), until start.sh --restart is done
export const QUEUED = "shepherd.queued"; // [{ id, space, line, task, at, sending? }]: lines waiting for a Shepherd, sent once one is up
/** One wording for Restart Shepherd's tooltips (Space settings, the ✻ area's header). */
export const RESTART_TIP = "A fresh Shepherd with the current instructions and workflow; running tasks keep going";
export const QUEUE_MAX_MS = 3600000; // a queued line older than this is dropped (with a toast), never sent days later

/** Where "Set up Shepherd on <machine>" clones the public repo on another machine (setup.sh), and
 *  where shepherdOn looks last. */
export const SETUP_DIR = "~/.herdr-shepherd";
export const SETUP_REPO = "https://github.com/codebypanduro/herdr-shepherd";

/** A dialog button: `primary` solid, `danger` red, else outlined. */
export const button = (t, id, label, onClick, { primary = false, danger = false } = {}) => div().id(id).px(12).h(28).flex().items_center()
  .rounded(5).cursor_pointer().text_size(12).font_semibold()
  .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground))
  .when(danger, (el) => el.bg(t.ansi1).text_color(t.background))
  .when(!primary && !danger, (el) => el.border(1).border_color(t.input).text_color(t.foreground).hover((x) => x.bg(t.hover)))
  .on_click(onClick).child(label);

/** "key=value" lines (a script's answer) as an object. */
export const parseKv = (text) => Object.fromEntries(String(text ?? "").split("\n").map((l) => l.match(/^(\w+)=(.*)$/)).filter(Boolean).map((x) => [x[1], x[2]]));

/** A space by its app id or its id on its machine (a command's argument), else null. */
export const spaceByArg = (arg) => spaces().find((x) => x.id === arg || localId(x) === arg) ?? null;

/** "Your message waits" / "3 messages wait". */
export const waitsText = (n) => (n > 1 ? `${n} messages wait` : n === 1 ? "1 message waits" : "");

/** A choice chip: the selected one is foreground on background, the others muted on an input border. */
export const chip = (t, id, label, on, onClick, { mono = true, dim = false } = {}) => div().id(id).h(24).px(9).flex().items_center()
  .rounded(5).border(1).cursor_pointer().text_size(12).when(mono, (el) => el.font_family(MONO))
  .border_color(on ? t.foreground : t.input).bg(on ? t.foreground : t.background).text_color(on ? t.background : dim ? t.dim : t.muted)
  .hover((s) => (on ? s : s.text_color(t.foreground)))
  .on_click(onClick).child(label);

/** A check box with its label; `disabled` greys it and drops the click. */
export const check = (t, id, label, on, onClick, { disabled = false } = {}) => h_flex().id(id).gap(6).items_center().text_size(12)
  .when(!disabled, (el) => el.cursor_pointer().on_click(onClick))
  .when(disabled, (el) => el.text_color(t.dim))
  .child(div().size(14).flex_none().rounded(3).border(1).flex().items_center().justify_center().text_size(10)
    .border_color(disabled ? t.border : on ? t.accent : t.input).bg(disabled ? t.surface : on ? t.accent : t.background)
    .text_color(t.accent_foreground).child(on && !disabled ? "✓" : ""))
  .child(label);

/** exec that never rejects: a rejection (unreachable machine, timeout) becomes { code: -1, stderr }. */
export const execSafe = (cmd, args, opts) => exec(cmd, args, opts).catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));

/** Why a command failed, in one line: stderr's last line, else "exit N". */
export const failLine = (r) => (r.stderr || "").trim().split("\n").pop() || `exit ${r.code}`;

/** Whether a space (or anything with `machine`) is on that machine (null: this computer). */
export const onMachine = (s, machine) => (s.machine ?? null) === (machine ?? null);

/** "git@github.com:org/repo.git" → "github.com/org/repo". */
export const normRemote = (url) => (url ? url.trim().replace(/^(ssh:\/\/)?(git@|https?:\/\/)/, "").replace(/^([^/:]+):/, "$1/").replace(/\.git$/, "") : null);

/** A repo's origin, branch and worktree count, from git on its machine (null when git can't). */
export async function gitFacts(dir, machine) {
  const r = await exec("sh", ["-c", 'git -C "$1" remote get-url origin 2>/dev/null; echo "--"; git -C "$1" branch --show-current 2>/dev/null; echo "--"; git -C "$1" worktree list --porcelain 2>/dev/null | grep -c "^worktree "', "git", dir],
    { on: machine, timeout: 10000 }).catch(() => null);
  if (!r) return null;
  const [url = "", branch = "", count = ""] = r.stdout.split("--\n");
  const remote = normRemote(url);
  return { remote, org: remote?.match(/^github\.com\/([^/]+)\//)?.[1] ?? null, branch: branch.trim() || null,
    worktrees: Math.max(0, (parseInt(count, 10) || 1) - 1) };
}

/** Where this mod's repo keeps Shepherd: the mods/shepherd link's real folder, then ../../shepherd.
 *  { dir, workflow (the person's one workflow.json), example, start } or null when the mod isn't
 *  inside a checkout with shepherd/. Asked once per copy. */
export async function shepherdHome(m) {
  if (m.home !== undefined) return m.home;
  const r = await exec("sh", ["-c", 'cd -P "$1" 2>/dev/null && cd ../../shepherd 2>/dev/null && [ -f start.sh ] && pwd -P', "home", `${appHome()}/mods/shepherd`],
    { timeout: 10000 }).catch(() => null);
  const dir = r?.code === 0 ? r.stdout.trim() : "";
  m.home = dir ? { dir, workflow: `${dir}/workflow.json`, example: `${dir}/workflow.example.json`, start: `${dir}/start.sh` } : null;
  return m.home;
}

// On another machine: the login shell's PATH (node, hc and claude often live in ~/.nvm or
// ~/.local/bin, which a plain `sh -c` lacks; `-lc` first, `-lic` only when that PATH misses one of
// them, since an interactive shell can stop on a prompt; read after a __P= sentinel so anything a
// logout prints is ignored), then a shepherd/ folder with start.sh and
// bin/shep.mjs, found like shepherdHome (through that machine's mods/shepherd link) or at this
// checkout's path ($1), else in ~/.herdr-shepherd (Set up Shepherd's clone), then the programs start.sh needs. Prints dir= and path=, or no=<reason>.
const SHEP_CHECK = `lp() { "\${SHELL:-sh}" "$1" 'printf "__P=%s\\n" "$PATH"' 2>/dev/null </dev/null | sed -n 's/^__P=//p' | tail -n 1; }
has() { ( PATH="$1:$PATH"; for t in node hc claude git; do command -v "$t" >/dev/null 2>&1 || exit 1; done ); }
P=$(lp -lc); has "$P" || { Q=$(lp -lic); [ -n "$Q" ] && P=$Q; }
[ -n "$P" ] && PATH="$P:$PATH"
d=""
for c in "$HOME/.config/herdr-app/mods/shepherd" "$1/../mods/shepherd" "$HOME/.herdr-shepherd/mods/shepherd"; do
  x=$(cd -P "$c" 2>/dev/null && cd ../../shepherd 2>/dev/null && [ -f start.sh ] && [ -f bin/shep.mjs ] && pwd -P) && { d=$x; break; }
done
[ -n "$d" ] || { echo "missing=1"; echo "no=no herdr-shepherd checkout with shepherd/start.sh there"; exit 0; }
for t in node hc claude git; do command -v "$t" >/dev/null 2>&1 || { echo "no=$t isn't installed there"; exit 0; }; done
echo "dir=$d"
echo "path=$PATH"`;

/** Whether start.sh can run on a machine (null: this computer): { dir, path } (path: the PATH to
 *  run it with there) or { reason, unreachable }, one line; `unreachable` when the check itself
 *  couldn't run there (worth asking again). */
export async function shepherdOn(m, machine) {
  const h = await shepherdHome(m);
  if (!machine) return h ? { dir: h.dir, path: null } : { reason: "mods/shepherd isn't inside a checkout with shepherd/start.sh" };
  const r = await execSafe("sh", ["-c", SHEP_CHECK, "check", h?.dir ?? "/nonexistent"], { on: machine, timeout: 15000 });
  const kv = parseKv(r.stdout);
  if (kv.dir && kv.path) return { dir: kv.dir, path: kv.path };
  if (kv.no) return { reason: kv.no, missing: kv.missing === "1" };
  return { reason: `couldn't check ${machine}: ${failLine(r)}`, unreachable: true };
}

/** shepherdOn's last answer for a machine (null: this computer), shared by every copy: { dir, path }
 *  or { reason, unreachable, missing }, with `at`; null while never asked. */
export const startable = (machine) => (shared(STARTABLE) ?? {})[machine ?? ""] ?? null;

/** How long an answer holds: a yes 10 minutes, a machine that didn't answer 1, any other no 5. */
export const startTtl = (s) => (s?.dir ? 600000 : s?.unreachable ? 60000 : 300000);

/** Whether the answer for a machine should be asked again (none, or past startTtl). */
export const startStale = (machine) => { const s = startable(machine); return !s || Date.now() - s.at >= startTtl(s); };

/** Whether Shepherd can start on a machine, as every panel shows it (a pure read; checkStartable
 *  asks): { state: "checking" | "ok" | "missing" (no checkout there: Set up) | "unreachable" (Retry)
 *  | "no", reason, known (the answer, for startShepherd) }. "checking" while this copy is asking. */
export function machineStartState(m, machine) {
  const s = startable(machine);
  if (!s || m.checkingStart?.[machine ?? ""]) return { state: "checking" };
  if (s.dir) return { state: "ok", known: s };
  return { state: s.missing && machine ? "missing" : s.unreachable ? "unreachable" : "no", reason: s.reason };
}

/** Asks shepherdOn again when the answer is stale (startStale), or with `force` (Retry, a dialog
 *  opening, after setup). One check per machine at a time per copy. Resolves with the answer.
 *  Called from timers and handlers, never from render. */
export async function checkStartable(m, machine, force = false) {
  const key = machine ?? "";
  if (!force && !startStale(machine)) return startable(machine);
  const busy = (m.checkingStart ??= {});
  if (busy[key]) return busy[key];
  busy[key] = shepherdOn(m, machine).catch((e) => ({ reason: String(e?.message ?? e), unreachable: true }))
    .then((r) => { setShared(STARTABLE, { ...(shared(STARTABLE) ?? {}), [key]: { ...r, at: Date.now() } }); return r; })
    .finally(() => { delete busy[key]; });
  return busy[key];
}

/** "Set up Shepherd on <machine>": mods/shepherd/setup.sh run there (clones SETUP_REPO into
 *  SETUP_DIR with that machine's login PATH). { ok: <dir> } or { error }. */
export async function setupShepherd(machine) {
  const script = await readTextFile(`${appHome()}/mods/shepherd/setup.sh`).catch(() => null);
  if (!script) return { error: "mods/shepherd/setup.sh is missing here" };
  const r = await execSafe("sh", ["-c", script, "setup.sh", SETUP_REPO], { on: machine, timeout: 300000 });
  const kv = parseKv(r.stdout);
  if (kv.ok) return { ok: kv.ok };
  return { error: kv.no ?? `couldn't reach ${machine}: ${failLine(r)}` };
}

/** The person's workflow: workflow.json, else the example it starts from ({} when neither reads). */
export async function readWorkflow(m) {
  const h = await shepherdHome(m);
  if (!h) return { file: null, wf: {} };
  for (const f of [h.workflow, h.example]) {
    const text = await readTextFile(f).catch(() => null);
    if (text != null) { try { return { file: h.workflow, wf: JSON.parse(text) }; } catch { return { file: h.workflow, wf: {}, error: `${f}: not JSON` }; } }
  }
  return { file: h.workflow, wf: {} };
}

/** Writes JSON one at a time per file (rapid clicks queue up instead of losing updates): reads it,
 *  applies `change`, and writes it back only if it hasn't changed since the read. Here with
 *  writeTextFile; on another machine with node there (same check, a temp name of its own). */
export function editJson(m, path, machine, change, base = null) {
  const key = `${machine ?? ""}:${path}`;
  const queue = (m.writes ??= {});
  const run = async () => {
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
    const code = `const fs=require("fs"),p=process.argv[1],want=process.argv[3];
let now=null;try{now=fs.readFileSync(p,"utf8")}catch{}
if(process.argv[4]==="new"?now!==null:now!==want){console.error("changed since read");process.exit(4)}
fs.mkdirSync(require("path").dirname(p),{recursive:true});const tmp=p+"."+process.pid+"."+Date.now()+".tmp";
fs.writeFileSync(tmp,process.argv[2]);fs.renameSync(tmp,p)`;
    const r = await exec("node", ["-e", code, path, text, before ?? "", before == null ? "new" : "old"], { on: machine, timeout: 15000 });
    if (r.code !== 0) throw new Error((r.stderr || "node failed").trim());
  };
  const next = (queue[key] ?? Promise.resolve()).catch(() => null).then(run);
  queue[key] = next;
  return next;
}

/** Keeps Shepherd's files out of git in a repo (as start.sh does), for a write into .herdr/. */
export const excludeHerdr = (dir, machine) => exec("sh", ["-c", `e=$(git -C "$1" rev-parse --git-path info/exclude 2>/dev/null) || exit 0
case "$e" in /*) ;; *) e="$1/$e" ;; esac; mkdir -p "$(dirname "$e")"; grep -qx '.herdr/' "$e" 2>/dev/null || echo '.herdr/' >> "$e"`, "exclude", dir],
{ on: machine, timeout: 10000 }).catch(() => null);

/** Tells every Shepherd on this computer that the workflow file changed (PROMPT.md "workflow changed"). */
export function tellWorkflowChanged(file) {
  for (const x of terminals()) {
    // Not to one whose Claude is down (bin/run.sh throws lines away then): a restarted one reads the file anyway.
    if (x.state === "live" && x.labels?.["herdr.role"] === "shepherd" && x.labels?.["shepherd.up"] !== "0" && machineOf(x) === null) {
      hc(["send", x.address, `workflow changed: read ${file}`]).catch(() => null);
    }
  }
}

// ---- openers --------------------------------------------------------------------------------

/** Popovers open at the pointer when clicked; from a key or command, near the sidebar's foot. */
const popAt = (atPointer) => (atPointer ? {} : { at: { x: 248, y: 520 } });
/** New space, on this computer or (machine) on another one. */
export const openNewSpace = (machine = null) => openOverlay({ mod: "shepherd", kind: "dialog", width: 560, height: 580, props: { panel: "newspace", machine } });
export const openAddMachine = () => openOverlay({ mod: "shepherd", kind: "dialog", width: 540, height: 600, props: { panel: "addmachine" } });
export const openSpaceSettings = (id) => openOverlay({ mod: "shepherd", kind: "dialog", width: 600, height: 0.85, props: { panel: "spacesettings", space: id } });
export const openWorkflow = () => openOverlay({ mod: "shepherd", kind: "dialog", width: 680, height: 0.85, props: { panel: "workflow" } });
/** The confirm-then-run dialog that clones herdr-shepherd onto a machine (`space`: offer to start its Shepherd after). */
export const openSetup = (machine, space = null) => openOverlay({ mod: "shepherd", kind: "dialog", width: 540, height: 420, props: { panel: "setup", machine, space } });
export const openPlus = () => openOverlay({ mod: "shepherd", kind: "popup", width: 210, height: 76, props: { panel: "plus" } });
export const openMachine = (name, atPointer = false) => openOverlay({ mod: "shepherd", kind: "popup", width: 260, height: 236,
  props: { panel: "machine", machine: name ?? null }, ...popAt(atPointer) });
export const openUsage = (atPointer = false) => openOverlay({ mod: "shepherd", kind: "popup", width: 260, height: 150,
  props: { panel: "usage" }, ...popAt(atPointer) });
