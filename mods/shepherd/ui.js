// Pieces the sidebar, its popovers and the settings dialogs share: shared-state keys, the chip and
// the check box, git facts about a repo, the person's one workflow file, safe JSON writes, and the
// openers for every overlay (the tab bar, the board's keys and the sidebar all open them).

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, readTextFile, writeTextFile, appHome, openOverlay, closeOverlay, terminals, hc } from "herdr";
import { MONO, machineOf } from "./common.js";

export const MACHINE_INFO = "shepherd.machineInfo"; // { "<machine name, '' here>": {cpu, mem, disk, kind, model, tools, at, error} }
export const MACHINE_KINDS = "shepherd.machineKinds"; // the person's pick in Add machine: { name: kind }
export const USAGE = "shepherd.usage"; // { at, by: { "<machine, '' here>": { claude|codex: {pct, detail, resets, parts, at, error} } }, failed? }
export const FOLDERS = "shepherd.folders"; // sidebar folders: [{ id, name, open }]
export const SPACE_FOLDERS = "shepherd.spaceFolders"; // { space id: folder id }
export const NEW_SPACE = "shepherd.newSpace"; // New space's pending { folder, real, before, group, start, at }

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
// checkout's path ($1), then the programs start.sh needs. Prints dir= and path=, or no=<reason>.
const SHEP_CHECK = `lp() { "\${SHELL:-sh}" "$1" 'printf "__P=%s\\n" "$PATH"' 2>/dev/null </dev/null | sed -n 's/^__P=//p' | tail -n 1; }
has() { ( PATH="$1:$PATH"; for t in node hc claude git; do command -v "$t" >/dev/null 2>&1 || exit 1; done ); }
P=$(lp -lc); has "$P" || { Q=$(lp -lic); [ -n "$Q" ] && P=$Q; }
[ -n "$P" ] && PATH="$P:$PATH"
d=""
for c in "$HOME/.config/herdr-app/mods/shepherd" "$1/../mods/shepherd"; do
  x=$(cd -P "$c" 2>/dev/null && cd ../../shepherd 2>/dev/null && [ -f start.sh ] && [ -f bin/shep.mjs ] && pwd -P) && { d=$x; break; }
done
[ -n "$d" ] || { echo "no=no herdr-shepherd checkout with shepherd/start.sh there"; exit 0; }
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
  const kv = Object.fromEntries((r.stdout ?? "").split("\n").map((l) => l.match(/^(\w+)=(.*)$/)).filter(Boolean).map((x) => [x[1], x[2]]));
  if (kv.dir && kv.path) return { dir: kv.dir, path: kv.path };
  return kv.no ? { reason: kv.no } : { reason: `couldn't check ${machine}: ${failLine(r)}`, unreachable: true };
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
    if (x.state === "live" && x.labels?.["herdr.role"] === "shepherd" && machineOf(x) === null) {
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
export const openPlus = () => openOverlay({ mod: "shepherd", kind: "popup", width: 210, height: 76, props: { panel: "plus" } });
export const openMachine = (name, atPointer = false) => openOverlay({ mod: "shepherd", kind: "popup", width: 260, height: 236,
  props: { panel: "machine", machine: name ?? null }, ...popAt(atPointer) });
/** The terminal window's key. A window isn't the top dialog or popup, so `overlay.close` without an
 *  id leaves it open; closing it by this key always works. */
export const TERM_WINDOW = "shepherd-terminal";
export const closeTermWindow = (id) => {
  closeOverlay(TERM_WINDOW);
  if (id && id !== TERM_WINDOW) closeOverlay(id);
};
export const openUsage = (atPointer = false) => openOverlay({ mod: "shepherd", kind: "popup", width: 260, height: 150,
  props: { panel: "usage" }, ...popAt(atPointer) });
