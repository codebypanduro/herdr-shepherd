// The steer menu (a popup, props {panel:"steer", task}). Steering goes through Shepherd:
// `steer <id> redirect: …`, `steer <id> context: …`, `pause <id>`, `resume <id>`, `status <id>?`.

import { div } from "gpui-kit";
import { v_flex, h_flex, Textarea } from "gpui-base";
import { props, closeOverlay } from "herdr";
import { STAGES, ROLE, MONO, palette } from "./common.js";
import { openTaskTerminal } from "./mode.js";

export function renderSteer(m) {
  const t = palette();
  const p = props() ?? {};
  const task = m.taskById(p.task);
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
      .child(Textarea.new(m.steerInputs[m.steerMode]).w_full().px(8).py(7).rounded(5).border(1).border_color(t.input).bg(t.background)
        .font_family(MONO).text_size(12).text_color(t.foreground))
      .child(h_flex().gap(6).justify_end()
        .child(div().id("steer-cancel").px(10).py(4).rounded(4).text_size(11.5).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click(close).child("Cancel"))
        .child(h_flex().id("steer-send").px(10).py(4).gap(6).items_center().rounded(4).text_size(11.5).font_semibold().cursor_pointer()
          .bg(t.solid).text_color(t.solid_foreground)
          .on_click(() => m.sendSteer())
          .child(`Send to ${task.terminal ?? "shepherd"}`)
          .child(div().font_family(MONO).text_size(10).opacity(0.7).child("⌘↵")))));
  }

  const canPause = ["working", "paused"].includes(task.status);
  const paused = task.status === "paused";
  const item = (id, icon, label, key, enabled, act) => h_flex().id(`steer-${id}`).h(30).px(8).gap(9).items_center().rounded(5)
    .text_color(enabled ? t.foreground : t.dim)
    .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => act(cx)))
    .child(div().w(14).flex().justify_center().font_family(MONO).text_size(11).text_color(t.muted).child(icon))
    .child(div().flex_1().child(label))
    .child(div().font_family(MONO).text_size(10).text_color(t.dim).child(key));
  const input = (mode) => (cx) => m.steerField(mode, cx);

  return root.child(head)
    .child(item("pause", paused ? "▶" : "⏸", paused ? "Resume" : "Pause", "P", canPause, () => m.togglePause(task)))
    .child(item("redirect", "↪", "Redirect…", "R", true, input("redirect")))
    .child(item("context", "+", "Add context…", "C", true, input("context")))
    .child(item("status", "?", "Ask for status", "S", true, () => { close(); m.askStatus(task); }))
    .child(item("terminal", "▭", "Open terminal", "T", Boolean(task.terminal), () => { close(); openTaskTerminal(m, task._ref); }))
    .child(item("open", "↗", "Open task", "↵", true, () => { close(); m.openTask(task._ref); }));
}
