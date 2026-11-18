// Changes and Files tabs: git in the task's worktree, against where its branch left main.
// m.git(task) returns what's loaded so far; main.js starts loads (they need a cx).

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, readTextFile, home } from "herdr";
import { MONO, tint, plural } from "./common.js";

const MAX_LINES = 3000;

/** The task's worktree folder, or null when it has none: not made yet, or removed once Done. */
export const worktreeOf = (task) => (task.worktree && task.stage !== "done" ? task.worktree.replace(/^~(?=\/|$)/, home()) : null);

const git = (args, dir, on) => exec("git", args, { cwd: dir, on, timeout: 20000 })
  .then((r) => (r.code === 0 ? r.stdout : null)).catch(() => null);

const MAX_UNTRACKED_COUNTS = 200; // untracked files whose lines are counted (one git call each)

/** The commit the branch left main (or master) at; null when neither exists. */
async function baseOf(dir, on) {
  for (const b of ["main", "master", "origin/main", "origin/master"]) {
    const mb = await git(["merge-base", "HEAD", b], dir, on);
    if (mb) return mb.trim();
  }
  return null;
}

/** `--numstat -z` output as Map(new path → {add, del}). A rename is "a\td\t" then old and new. */
export function parseNumstat(out) {
  const counts = new Map();
  const tok = String(out ?? "").split("\0");
  for (let i = 0; i < tok.length; i++) {
    const m = tok[i].match(/^(\S+)\t(\S+)\t([\s\S]*)$/);
    if (!m) continue;
    let path = m[3];
    if (path === "") { path = tok[i + 2] ?? ""; i += 2; }
    counts.set(path, { add: m[1] === "-" ? 0 : +m[1], del: m[2] === "-" ? 0 : +m[2] });
  }
  return counts;
}

/** `--name-status -z` output as [{path, status}]: renames and copies by their new path, as M / A. */
export function parseNameStatus(out) {
  const files = [];
  const tok = String(out ?? "").split("\0");
  for (let i = 0; i < tok.length; i++) {
    const s = tok[i];
    if (!s) continue;
    if (s[0] === "R" || s[0] === "C") { files.push({ path: tok[i + 2], status: s[0] === "R" ? "M" : "A" }); i += 2; }
    else { files.push({ path: tok[i + 1], status: s[0] }); i += 1; }
  }
  return files.filter((f) => f.path);
}

/** Files changed since base, committed or not, plus untracked ones (their lines counted as added);
 *  and every file in the worktree. Failures carry `at` too, so they're retried on the stale clock. */
export async function loadGit(dir, on) {
  const at = Date.now();
  const base = await baseOf(dir, on);
  if (!base) return { error: "No main or master branch to compare with.", files: [], tree: [], at };
  const [numstat, names, untracked, all] = await Promise.all([
    git(["diff", "-M", "--numstat", "-z", base], dir, on),
    git(["diff", "-M", "--name-status", "-z", base], dir, on),
    git(["ls-files", "--others", "--exclude-standard"], dir, on),
    git(["ls-files", "--cached", "--others", "--exclude-standard"], dir, on),
  ]);
  if (numstat == null || names == null) return { error: `git failed in ${dir}`, files: [], tree: [], at };
  const counts = parseNumstat(numstat);
  const files = parseNameStatus(names).map((f) => ({ ...f, ...(counts.get(f.path) ?? { add: 0, del: 0 }) }));
  const fresh = (untracked ?? "").trim().split("\n").filter((p) => p && !files.some((f) => f.path === p));
  // git diff --numstat leaves untracked files out: count each against /dev/null (exit 1 = differs).
  const newCounts = fresh.length ? parseNumstat(await exec("sh", ["-c", 'for f; do git diff --no-index --numstat -z /dev/null "$f"; done', "sh",
    ...fresh.slice(0, MAX_UNTRACKED_COUNTS)], { cwd: dir, on, timeout: 20000 }).then((r) => r.stdout).catch(() => "")) : new Map();
  for (const path of fresh) files.push({ path, status: "A", ...(newCounts.get(path) ?? { add: 0, del: 0 }), untracked: true });
  files.sort((a, b) => a.path.localeCompare(b.path));
  const tree = [...new Set((all ?? "").trim().split("\n").filter(Boolean))].sort();
  return { base, files, tree, at };
}

/** An untracked file's text as a diff: one hunk, every line added. */
export function untrackedDiff(text) {
  const lines = String(text ?? "").replace(/\n$/, "").split("\n").slice(0, MAX_LINES);
  return text ? [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n") : "";
}

/** One file's unified diff against base (an untracked file: all of it, added). */
export async function loadDiff(dir, on, base, file) {
  if (file.untracked) return untrackedDiff(await readTextFile(`${dir}/${file.path}`, { on }).catch(() => ""));
  return (await git(["diff", "-M", base, "--", file.path], dir, on)) ?? "";
}

/** A file's text and the line numbers added since base. */
export async function loadFile(dir, on, base, path) {
  const [text, d] = await Promise.all([
    readTextFile(`${dir}/${path}`, { on }).catch(() => null),
    base ? git(["diff", "-U0", base, "--", path], dir, on) : Promise.resolve(""),
  ]);
  const added = new Set();
  for (const m of (d ?? "").matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = +m[1], n = m[2] === undefined ? 1 : +m[2];
    for (let i = 0; i < n; i++) added.add(start + i);
  }
  return { text, added };
}

// ---- views ---------------------------------------------------------------------------------

/** A changed file's status color, everywhere it shows: added green, deleted red, changed amber. */
const fileStatusColor = (t, s) => (s === "A" ? t.done : s === "D" ? t.ansi1 : t.blocked);
const EXT_COLOR = (t, path) => {
  const ext = String(path).split(".").pop().toLowerCase();
  if (["js", "mjs", "cjs", "jsx"].includes(ext)) return t.ansi3;
  if (["ts", "tsx"].includes(ext)) return t.ansi4;
  if (["json", "toml", "yml", "yaml"].includes(ext)) return t.ansi5;
  if (["md", "txt"].includes(ext)) return t.muted;
  if (["css", "scss", "html"].includes(ext)) return t.ansi6;
  if (["rs", "go", "py", "php", "rb"].includes(ext)) return t.ansi1;
  return t.dim;
};

/** A 10×12 file mark in its extension's color: a soft page, a folded corner and a line. */
export const fileIcon = (t, path) => {
  const c = EXT_COLOR(t, path);
  return div().relative().w(10).h(12).flex_none().rounded(2).bg(tint(c, 0.28))
    .child(div().absolute().top(0).right(0).size(4).rounded(1).bg(c))
    .child(div().absolute().left(2).right(2).bottom(3).h(1.5).rounded(1).bg(c));
};

function stateLine(t, text) {
  return v_flex().flex_1().items_center().justify_center().child(div().text_size(13).text_color(t.dim).child(text));
}

/** Code rows: a 44px right-aligned line number (blank for none), an optional ± mark, the text. */
function codeLines(t, rows) {
  return v_flex().id("code").flex_1().min_w(0).min_h(0).overflow_y_scrollbar().py(6)
    .font_family(MONO).text_size(12).line_height("19px")
    .children(rows.slice(0, MAX_LINES).map((r) => h_flex().w_full().items_start().bg(r.bg ?? t.surface)
      .border_l(2).border_color(r.edge ?? r.bg ?? t.surface)
      .child(div().w(44).flex_none().pr(8).flex().justify_end().text_color(t.dim).child(r.n == null ? "" : String(r.n)))
      .when(r.mark !== undefined, (el) => el.child(div().w(18).flex_none().text_color(r.markColor ?? t.dim).child(r.mark)))
      .child(div().flex_1().min_w(0).pr(12).text_color(r.fg ?? t.foreground).child(r.text === "" ? " " : r.text))));
}

/** A unified diff as rows with new-side line numbers: hunks only (the file header is dropped);
 *  an untracked file's text (all "+", no hunk) counts from 1. */
export function diffRows(diff) {
  const rows = [];
  let n = 1, inHunk = false;
  for (const l of String(diff ?? "").replace(/\n$/, "").split("\n")) {
    const h = l.match(/^@@ -\S+ \+(\d+)(?:,\d+)? @@/);
    if (h) { n = +h[1]; inHunk = true; rows.push({ kind: "@", text: l }); continue; }
    if (!inHunk && /^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|Binary)/.test(l)) continue;
    if (l.startsWith("\\")) continue; // "\ No newline at end of file"
    if (l.startsWith("+")) rows.push({ kind: "+", n: n++, text: l.slice(1) });
    else if (l.startsWith("-")) rows.push({ kind: "-", n: null, text: l.slice(1) });
    else rows.push({ kind: " ", n: n++, text: l.slice(1) });
  }
  return rows;
}

const splitPath = (p) => {
  const i = p.lastIndexOf("/");
  return i < 0 ? { name: p, dir: "/" } : { name: p.slice(i + 1), dir: p.slice(0, i) };
};

export function renderChanges(m, task, t) {
  const g = m.git(task);
  if (!worktreeOf(task)) return stateLine(t, task.stage === "done" ? "Merged · the worktree was removed." : "No code changes yet.");
  if (!g) return stateLine(t, "Reading the worktree…");
  if (g.error) return stateLine(t, g.error);
  if (!g.files.length) return stateLine(t, "No code changes yet.");
  const ui = m.ui(task);
  const sel = g.files.find((f) => f.path === ui.changesFile) ?? g.files[0];
  const diff = m.diff(task, sel);
  const add = g.files.reduce((n, f) => n + f.add, 0), del = g.files.reduce((n, f) => n + f.del, 0);

  const list = v_flex().id("chg-list").w(240).flex_none().min_h(0).overflow_y_scrollbar().px(6).py(8).gap(1)
    .border_r(1).border_color(t.border)
    .child(div().px(8).pt(2).pb(8).font_family(MONO).text_size(11).text_color(t.dim)
      .child(`${plural(g.files.length, "file")} · +${add} −${del}`))
    .children(g.files.map((f) => {
      const { name, dir } = splitPath(f.path);
      return h_flex().id(`chg-${f.path}`).px(8).py(6).gap(8).items_center().rounded(5).cursor_pointer()
        .bg(f === sel ? t.hover : t.surface).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { ui.changesFile = f.path; cx.notify(); })
        .child(fileIcon(t, f.path))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(12.5).child(name))
          .child(div().truncate().font_family(MONO).text_size(11).text_color(t.dim).child(dir)))
        .child(v_flex().flex_none().items_end().font_family(MONO).text_size(10.5)
          .child(div().text_color(t.done).child(`+${f.add}`))
          .child(div().text_color(t.ansi1).child(`−${f.del}`)));
    }));

  const rows = diff == null ? [{ n: null, mark: "", text: "Loading diff…", fg: t.dim }]
    : diffRows(diff).map((r) => r.kind === "+" ? { n: r.n, mark: "+", markColor: t.done, text: r.text, fg: t.foreground, bg: tint(t.done, 0.09) }
      : r.kind === "-" ? { n: null, mark: "-", markColor: t.ansi1, text: r.text, fg: t.muted, bg: tint(t.ansi1, 0.09) }
      : r.kind === "@" ? { n: null, mark: "", text: r.text, fg: t.dim, bg: t.raised }
      : { n: r.n, mark: "", text: r.text, fg: t.muted });

  return h_flex().flex_1().min_h(0).items_stretch()
    .child(list)
    .child(v_flex().flex_1().min_w(0)
      .child(h_flex().flex_none().gap(8).px(12).py(8).items_center().border_b(1).border_color(t.border)
        .font_family(MONO).text_size(11.5).text_color(t.foreground)
        .child(div().flex_none().px(5).rounded(3).bg(fileStatusColor(t, sel.status)).text_size(10).text_color(t.background).child(sel.status))
        .child(div().min_w(0).truncate().child(sel.path)))
      .child(codeLines(t, rows)));
}

export function renderFiles(m, task, t) {
  const g = m.git(task);
  if (!worktreeOf(task)) return stateLine(t, task.stage === "done" ? "Merged · the worktree was removed." : "This task has no worktree yet.");
  if (!g) return stateLine(t, "Reading the worktree…");
  if (g.error) return stateLine(t, g.error);
  const ui = m.ui(task);
  const changed = new Map(g.files.map((f) => [f.path, f.status]));
  const dirsWithChanges = new Set(g.files.flatMap((f) => f.path.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))));

  // Rows: folders first at each level, open folders show their children.
  const rows = [];
  const walk = (prefix, depth) => {
    const kids = new Map();
    for (const p of g.tree) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const i = rest.indexOf("/");
      const name = i < 0 ? rest : rest.slice(0, i);
      if (!kids.has(name)) kids.set(name, i >= 0);
      else if (i >= 0) kids.set(name, true);
    }
    const sorted = [...kids.entries()].sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] ? -1 : 1));
    for (const [name, isDir] of sorted) {
      const path = prefix + name;
      rows.push({ path, name, isDir, depth });
      if (isDir && ui.open.has(path)) walk(`${path}/`, depth + 1);
    }
  };
  walk("", 0);

  const repoName = String(m.repo()?.dir ?? "").split("/").filter(Boolean).pop() ?? "repo";
  const tree = v_flex().id("files-tree").w(240).flex_none().min_h(0).overflow_y_scrollbar().px(6).py(8)
    .border_r(1).border_color(t.border)
    .child(h_flex().gap(6).px(8).pt(2).pb(8).items_center().font_family(MONO).text_size(11).text_color(t.dim)
      .child(div().flex_none().child(repoName)).child(div().flex_none().text_color(t.border).child("·"))
      .child(div().min_w(0).truncate().child(task.branch ?? "—")))
    .children(rows.map((r) => {
      const open = r.isDir && ui.open.has(r.path);
      const badge = r.isDir ? (dirsWithChanges.has(r.path) ? "●" : "") : changed.get(r.path) ?? "";
      return h_flex().id(`file-${r.path}`).h(26).pr(8).gap(6).items_center().rounded(4).cursor_pointer()
        .pl((r.isDir ? 6 : 22) + r.depth * 14)
        .bg(ui.file === r.path ? t.hover : t.surface).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (r.isDir) { if (ui.open.has(r.path)) ui.open.delete(r.path); else ui.open.add(r.path); }
          else ui.file = r.path;
          cx.notify();
        })
        .when(r.isDir, (el) => el
          .child(div().w(10).flex_none().text_size(9).text_color(t.dim).child(open ? "▼" : "▶"))
          .child(svg("mods/shepherd/icons/folder.svg").w(14).h(12).flex_none().text_color(open ? t.accent : t.muted)))
        .when(!r.isDir, (el) => el.child(fileIcon(t, r.name)))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5)
          .text_color(r.isDir || changed.has(r.path) ? t.foreground : t.muted).child(r.name))
        .when(Boolean(badge), (el) => el.child(div().flex_none().font_family(MONO).text_size(10)
          .text_color(fileStatusColor(t, r.isDir ? "M" : badge)).child(badge)));
    }));

  const file = ui.file ? m.file(task, ui.file) : null;
  const status = ui.file ? changed.get(ui.file) : null;
  // Added lines: a soft green row with a green left edge.
  const view = !ui.file ? stateLine(t, "Pick a file.")
    : !file ? stateLine(t, "Loading…")
    : file.text == null ? stateLine(t, "Can't read this file.")
    : codeLines(t, file.text.replace(/\n$/, "").split("\n").map((l, i) => file.added.has(i + 1)
      ? { n: i + 1, text: l, bg: tint(t.done, 0.07), edge: t.done }
      : { n: i + 1, text: l, fg: t.foreground }));
  const parts = ui.file ? ui.file.split("/") : [];
  const crumbs = [repoName, ...parts];

  return h_flex().flex_1().min_h(0).items_stretch()
    .child(tree)
    .child(v_flex().flex_1().min_w(0)
      .when(Boolean(ui.file), (el) => el.child(h_flex().flex_none().flex_wrap().gap(6).px(12).py(8).items_center()
        .border_b(1).border_color(t.border).font_family(MONO).text_size(11.5)
        .children(crumbs.flatMap((c, i) => [
          div().text_color(i === 0 ? t.dim : i === crumbs.length - 1 ? t.foreground : t.muted).child(c),
          ...(i < crumbs.length - 1 ? [div().text_color(t.border).child("/")] : []),
        ]))
        .child(div().flex_1())
        // Deleted files aren't in the tree, so a shown file is added or changed.
        .when(Boolean(status), (e2) => e2.child(div().text_size(11).text_color(fileStatusColor(t, status))
          .child(status === "A" ? "added in this task" : "changed in this task")))))
      .child(view));
}
