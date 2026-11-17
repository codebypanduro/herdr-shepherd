// Changes and Files tabs: git in the task's worktree, against where its branch left main.
// m.git(task) returns what's loaded so far; main.js starts loads (they need a cx).

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, readTextFile, home } from "herdr";
import { MONO } from "./common.js";

const MAX_LINES = 3000;

export const worktreeOf = (task) => (task.worktree ? task.worktree.replace(/^~(?=\/|$)/, home()) : null);

const git = (args, dir, on) => exec("git", args, { cwd: dir, on, timeout: 20000 })
  .then((r) => (r.code === 0 ? r.stdout : null)).catch(() => null);

/** The commit the branch left main (or master) at; null when neither exists. */
async function baseOf(dir, on) {
  for (const b of ["main", "master", "origin/main", "origin/master"]) {
    const mb = await git(["merge-base", "HEAD", b], dir, on);
    if (mb) return mb.trim();
  }
  return null;
}

/** Files changed since base, committed or not, plus untracked ones; and every file in the worktree. */
export async function loadGit(dir, on) {
  const base = await baseOf(dir, on);
  if (!base) return { error: "No main or master branch to compare with.", files: [], tree: [] };
  const [numstat, names, untracked, all] = await Promise.all([
    git(["diff", "--numstat", base], dir, on),
    git(["diff", "--name-status", base], dir, on),
    git(["ls-files", "--others", "--exclude-standard"], dir, on),
    git(["ls-files", "--cached", "--others", "--exclude-standard"], dir, on),
  ]);
  if (numstat == null || names == null) return { error: `git failed in ${dir}`, files: [], tree: [] };
  const counts = new Map(numstat.trim().split("\n").filter(Boolean).map((l) => {
    const [a, d, ...p] = l.split("\t");
    return [p.join("\t"), { add: a === "-" ? 0 : +a, del: d === "-" ? 0 : +d }];
  }));
  const files = names.trim().split("\n").filter(Boolean).map((l) => {
    const [s, ...p] = l.split("\t");
    const path = p[p.length - 1];
    return { path, status: s[0] === "R" ? "M" : s[0], ...(counts.get(path) ?? { add: 0, del: 0 }) };
  });
  for (const path of (untracked ?? "").trim().split("\n").filter(Boolean)) {
    if (!files.some((f) => f.path === path)) files.push({ path, status: "A", add: 0, del: 0, untracked: true });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const tree = [...new Set((all ?? "").trim().split("\n").filter(Boolean))].sort();
  return { base, files, tree, at: Date.now() };
}

/** One file's unified diff against base (an untracked file: all of it, added). */
export async function loadDiff(dir, on, base, file) {
  if (file.untracked) {
    const text = await readTextFile(`${dir}/${file.path}`, { on }).catch(() => "");
    return text.split("\n").slice(0, MAX_LINES).map((l) => `+${l}`).join("\n");
  }
  return (await git(["diff", base, "--", file.path], dir, on)) ?? "";
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

const STATUS_COLOR = (t, s) => (s === "A" ? t.done : s === "D" ? t.ansi1 : t.working);
const EXT_COLOR = (t, path) => {
  const ext = path.split(".").pop().toLowerCase();
  if (["js", "mjs", "cjs", "jsx"].includes(ext)) return t.ansi3;
  if (["ts", "tsx"].includes(ext)) return t.ansi4;
  if (["json", "toml", "yml", "yaml"].includes(ext)) return t.ansi5;
  if (["md", "txt"].includes(ext)) return t.muted;
  if (["css", "scss", "html"].includes(ext)) return t.ansi6;
  if (["rs", "go", "py", "php", "rb"].includes(ext)) return t.ansi1;
  return t.dim;
};

function stateLine(t, text) {
  return v_flex().flex_1().items_center().justify_center().child(div().text_color(t.dim).child(text));
}

function codeLines(t, lines, colorOf, bgOf, numbers) {
  return v_flex().id("code").flex_1().min_w(0).min_h(0).overflow_y_scrollbar().py(6)
    .font_family(MONO).text_size(11.5).line_height("18px")
    .children(lines.slice(0, MAX_LINES).map((l, i) => h_flex().w_full().px(10).bg(bgOf(l, i))
      .when(numbers, (el) => el.child(div().w(36).flex_none().text_color(t.dim).child(String(i + 1))))
      .child(div().flex_1().min_w(0).text_color(colorOf(l, i)).child(l === "" ? " " : l))));
}

export function renderChanges(m, task, t) {
  const g = m.git(task);
  if (!worktreeOf(task)) return stateLine(t, "This task has no worktree yet.");
  if (!g) return stateLine(t, "Reading the worktree…");
  if (g.error) return stateLine(t, g.error);
  if (!g.files.length) return stateLine(t, "No changes against main yet.");
  const ui = m.ui(task);
  const sel = g.files.find((f) => f.path === ui.changesFile) ?? g.files[0];
  const diff = m.diff(task, sel);

  const list = v_flex().id("chg-list").w(220).flex_none().min_h(0).overflow_y_scrollbar().py(6)
    .border_r(1).border_color(t.border)
    .children(g.files.map((f) => h_flex().id(`chg-${f.path}`).h(26).px(10).gap(6).items_center()
      .bg(f === sel ? t.selected : t.surface).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { ui.changesFile = f.path; cx.notify(); })
      .child(div().w(12).font_family(MONO).text_size(10.5).text_color(STATUS_COLOR(t, f.status)).child(f.status))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).child(f.path.split("/").pop()))
      .child(div().font_family(MONO).text_size(10).text_color(t.done).child(f.add ? `+${f.add}` : ""))
      .child(div().font_family(MONO).text_size(10).text_color(t.ansi1).child(f.del ? `−${f.del}` : ""))));

  const lines = diff == null ? ["Loading diff…"] : diff.replace(/\n$/, "").split("\n");
  const color = (l) => (l.startsWith("+++") || l.startsWith("---") ? t.dim
    : l.startsWith("+") ? t.done : l.startsWith("-") ? t.ansi1 : l.startsWith("@@") ? t.ansi4 : t.muted);
  const bg = (l) => (l.startsWith("+") && !l.startsWith("+++") ? m.tint(t.done, 0.1)
    : l.startsWith("-") && !l.startsWith("---") ? m.tint(t.ansi1, 0.1) : t.surface);

  return h_flex().flex_1().min_h(0).items_stretch()
    .child(list)
    .child(v_flex().flex_1().min_w(0)
      .child(div().h(26).flex_none().px(10).flex().items_center().border_b(1).border_color(t.border)
        .font_family(MONO).text_size(10.5).text_color(t.muted).child(sel.path))
      .child(codeLines(t, lines, color, bg, false)));
}

export function renderFiles(m, task, t) {
  const g = m.git(task);
  if (!worktreeOf(task)) return stateLine(t, "This task has no worktree yet.");
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

  const tree = v_flex().id("files-tree").w(240).flex_none().min_h(0).overflow_y_scrollbar().py(6)
    .border_r(1).border_color(t.border)
    .children(rows.map((r) => h_flex().id(`file-${r.path}`).h(24).pr(8).gap(6).items_center()
      .pl(10 + r.depth * 14)
      .bg(ui.file === r.path ? t.selected : t.surface).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        if (r.isDir) { if (ui.open.has(r.path)) ui.open.delete(r.path); else ui.open.add(r.path); }
        else ui.file = r.path;
        cx.notify();
      })
      .child(div().w(12).text_size(10).text_color(t.dim).child(r.isDir ? (ui.open.has(r.path) ? "▾" : "▸") : ""))
      .child(div().size(8).flex_none().rounded(r.isDir ? 2 : 4).bg(r.isDir ? t.muted : EXT_COLOR(t, r.name)))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5)
        .text_color(r.isDir && dirsWithChanges.has(r.path) ? t.foreground : t.muted).child(r.name))
      .when(changed.has(r.path), (el) => el.child(div().font_family(MONO).text_size(10)
        .text_color(STATUS_COLOR(t, changed.get(r.path))).child(changed.get(r.path))))));

  const file = ui.file ? m.file(task, ui.file) : null;
  const view = !ui.file ? stateLine(t, "Pick a file.")
    : !file ? stateLine(t, "Loading…")
    : file.text == null ? stateLine(t, "Can't read this file.")
    : codeLines(t, file.text.replace(/\n$/, "").split("\n"), () => t.foreground,
      (_l, i) => (file.added.has(i + 1) ? m.tint(t.done, 0.12) : t.surface), true);

  return h_flex().flex_1().min_h(0).items_stretch()
    .child(tree)
    .child(v_flex().flex_1().min_w(0)
      .when(Boolean(ui.file), (el) => el.child(div().h(26).flex_none().px(10).flex().items_center()
        .border_b(1).border_color(t.border).font_family(MONO).text_size(10.5).text_color(t.muted).child(ui.file)))
      .child(view));
}
