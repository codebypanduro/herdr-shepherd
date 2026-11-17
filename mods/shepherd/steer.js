// The steer menu (a popup, props {panel:"steer", task}) and the terminal window's title bar and
// footer (props {panel:"term" | "termfoot", terminal, task}). Steering goes through Shepherd:
// `steer <id> redirect: …`, `steer <id> context: …`, `pause <id>`, `resume <id>`, `status <id>?`.

import { div } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { props, terminals, closeOverlay, run } from "herdr";
import { STAGES, ROLE, MONO, age, palette } from "./common.js";

const money = (n) => `$${(n ?? 0).toFixed(2)}`;
const kTokens = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n ?? 0));

export function renderSteer(m) {
  const t = palette();
  const p = props() ?? {};
  const task = (m.state().tasks ?? []).find((x) => x.id === p.task);
  const root = v_flex().id("shepherd-steer").size_full().p(4).text_color(t.foreground).text_size(12.5);
  if (!task) return root.child(div().p(10).text_color(t.dim).child(m.error() ?? "Reading the task…"));
  const close = () => closeOverlay(p.overlay);
  const who = [task.terminal, ROLE[task.stage] ?? STAGES[task.stage]?.title].filter(Boolean).join(" · ");

  const head = h_flex().gap(6).px(8).pt(6).pb(7).mb(3).border_b(1).border_color(t.border).text_size(11).text_color(t.muted)
    .child(div().font_family(MONO).text_color(t.foreground).child(task.id))
    .child(div().flex_1().min_w(0).truncate().child(who));

  if (m.steerMode) {
    const redirect = m.steerMode === "redirect";
    return root.child(head).child(v_flex().gap(6).px(6).pt(4).pb(6)
      .child(div().text_size(11.5).text_color(t.muted).child(redirect ? "What should it do instead?" : "What should it know?"))
      .child(Input.new(m.steerInput).w_full().h(30).px(8).rounded(5).border(1).border_color(t.input).bg(t.background)
        .font_family(MONO).text_size(12).text_color(t.foreground))
      .child(h_flex().gap(6).justify_end()
        .child(div().id("steer-cancel").px(10).py(4).rounded(4).text_size(11.5).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click(close).child("Cancel"))
        .child(div().id("steer-send").px(10).py(4).rounded(4).text_size(11.5).font_semibold().cursor_pointer()
          .bg(t.solid).text_color(t.solid_foreground)
          .on_click(() => m.sendSteer())
          .child(`Send to ${task.terminal ?? "shepherd"}`))));
  }

  const canPause = ["working", "paused"].includes(task.status);
  const paused = task.status === "paused";
  const item = (id, icon, label, key, enabled, act) => h_flex().id(`steer-${id}`).h(30).px(8).gap(9).items_center().rounded(5)
    .text_color(enabled ? t.foreground : t.dim)
    .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => act(cx)))
    .child(div().w(14).flex().justify_center().font_family(MONO).text_size(11).text_color(t.muted).child(icon))
    .child(div().flex_1().child(label))
    .child(div().font_family(MONO).text_size(10).text_color(t.dim).child(key));
  const input = (mode) => (cx) => { m.steerMode = mode; m.steerInput.set_value(""); m.steerInput.focus(); cx.notify(); };

  return root.child(head)
    .child(item("pause", paused ? "▶" : "⏸", paused ? "Resume" : "Pause", "P", canPause, () => { m.togglePause(task); close(); }))
    .child(item("redirect", "↪", "Redirect…", "R", true, input("redirect")))
    .child(item("context", "+", "Add context…", "C", true, input("context")))
    .child(item("status", "?", "Ask for status", "S", true, () => { close(); m.askStatus(task); }))
    .child(item("terminal", "▭", "Open terminal", "T", Boolean(task.terminal), () => { close(); m.openTerminal(task.terminal, task.id); }))
    .child(item("open", "↗", "Open task", "↵", true, () => { close(); m.openTask(task.id); }));
}

/** What the window shows: the terminal, its task (if any) and how long it has been at it. */
function termInfo(m) {
  const p = props() ?? {};
  const term = terminals().find((x) => x.address === p.terminal) ?? null;
  const task = p.task ? (m.state().tasks ?? []).find((x) => x.id === p.task) ?? null : null;
  return { p, term, task };
}

export function renderTermBar(m) {
  const t = palette();
  const { p, term, task } = termInfo(m);
  const status = term?.status ?? null;
  const runs = task?.history ?? [];
  const cur = [...runs].reverse().find((r) => r.stage === task?.stage);
  const role = term?.labels?.["herdr.role"] ?? (task ? ROLE[task.stage] : null);
  const who = [role, cur?.model, task?.id].filter(Boolean).join(" · ");
  const stop = (_e, cx) => cx.stop_propagation();
  const button = (id, children, act) => h_flex().id(id).h(26).px(10).gap(6).items_center().rounded(5)
    .border(1).border_color(t.input).text_size(11.5).text_color(t.foreground).cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .on_mouse_down("left", stop)
    .on_click(act)
    .children(children);
  const pane = Boolean(term?.labels?.["herdr.tab"]);

  // Presses not stopped here drag the window: this bar is its handle.
  return h_flex().id("shepherd-termbar").size_full().pl(14).pr(8).gap(10).items_center()
    .bg(t.chrome).border_b(1).border_color(t.border).text_size(12).text_color(t.foreground)
    .child(div().size(7).rounded(4).flex_none().bg(t[status] ?? t.idle)
      .when(status === "working", (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1200 })))
    .child(div().font_family(MONO).child(p.terminal ?? "—"))
    .when(Boolean(who), (el) => el.child(div().flex_none().text_color(t.muted).child(who)))
    .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(11).text_color(t.dim)
      .child(`${m.space()?.machine ?? "this mac"}:${term?.cwd ?? task?.worktree ?? ""}`))
    .when(!pane && Boolean(term), (el) => el.child(button("term-keep", [div().child("Keep as tab")],
      () => { run("terminal.keep", { terminal: p.terminal }); closeOverlay(p.overlay); })))
    .when(Boolean(task), (el) => el.child(button("term-steer",
      [div().child("Steer"), div().font_family(MONO).text_size(10).text_color(t.dim).child("S")],
      () => m.openSteer(task.id, false))))
    .child(div().id("term-close").size(24).flex().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop)
      .on_click(() => closeOverlay(p.overlay))
      .child("✕"));
}

export function renderTermFoot(m) {
  const t = palette();
  const { task } = termInfo(m);
  const runs = task?.history ?? [];
  const cur = [...runs].reverse().find((r) => r.stage === task?.stage);
  const since = Date.parse(cur?.start ?? "");
  const tokens = runs.reduce((n, r) => n + (r.tokens ?? 0), 0);
  const cost = runs.reduce((n, r) => n + (r.cost ?? 0), 0);
  const right = task
    ? `${since ? `${age(Date.now() - since)} in ${STAGES[task.stage]?.title ?? task.stage} · ` : ""}${kTokens(tokens)} tokens · ${money(cost)}`
    : "";
  return h_flex().id("shepherd-termfoot").size_full().px(14).gap(10).items_center()
    .bg(t.chrome).border_t(1).border_color(t.border).font_family(MONO).text_size(11).text_color(t.dim)
    .child(div().child(task ? "You talk to the agent through Shepherd: Steer redirects it or adds context." : "Shepherd's own terminal."))
    .child(div().flex_1())
    .child(div().child(right));
}
