// Toasts: the layout's "toast" mod is shepherd, so every notification in the Shepherd layout is drawn
// here. Herdr gives each one a fixed box (about 340×70 at zoom 1), stacks them at the bottom right and
// closes them after their timeout. A question's toast (posted by alert() in main.js) carries the
// question in its action's args, `{shepherd: {space, q, task, rec, meta}}`, and gets the design's
// look: "? T-4 needs you · <space>", ✕, two lines of question, the recommended answer as a button and
// Open (Needs you in that space). Every other notification looks like Herdr's own toast.

import { div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, run, closeOverlay, shared, setShared, spaces, theme } from "herdr";
import { MONO, palette } from "./common.js";

export const TOAST_MS = 9000;
export const TOAST_MAX = 3;
export const TOASTS = "shepherd.toasts"; // [{id, at}]: question toasts still up, oldest first

/** Shepherd's question toasts, at most TOAST_MAX: the oldest beyond that are closed. */
export function trackToast(id) {
  const now = Date.now();
  const live = (shared(TOASTS) ?? []).filter((x) => now - x.at < TOAST_MS);
  const all = [...live, { id, at: now }];
  for (const x of all.slice(0, Math.max(0, all.length - TOAST_MAX))) closeOverlay(x.id);
  setShared(TOASTS, all.slice(-TOAST_MAX));
}

/** True when this copy's props are a notification's (Herdr gives a toast no panel or view). */
export const isToast = (p) => !p.panel && !p.view && typeof p.title === "string" && Boolean(p.overlay);

const DOT = { error: "blocked", warning: "working", success: "done", info: "accent" };

/** A notification that isn't a question, drawn as Herdr's shipped toast draws it. */
function herdrToast(m, p) {
  const t = theme();
  const login = /^([a-z0-9][a-z0-9_.-]{0,31}) needs login; run hc machine login \1$/.exec(p.body ?? "");
  const command = login ? `hc machine login ${login[1]}` : null;
  return h_flex().id("toast").size_full().px(18).gap(12).items_center().bg(t.popover).cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .on_click(() => {
      if (p.action?.name) run(p.action.name, p.action.args ?? {});
      closeOverlay(p.overlay);
    })
    .child(p.icon ? image(p.icon).w(18).h(18).flex_none() : div().size(8).rounded(4).flex_none().bg(t[DOT[p.level] ?? "accent"]))
    .child(v_flex().flex_1().overflow_hidden()
      .child(div().truncate().font_semibold().text_size(13).text_color(t.foreground).child(login ? `${login[1]} needs a login: run` : p.title ?? ""))
      .when(!login && Boolean(p.body), (el) => el.child(div().truncate().text_size(12).text_color(t.muted).child(p.body ?? "")))
      .when(Boolean(login), (el) => el.child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().tooltip(command).text_size(12).text_color(t.muted).child(command))
        .child(div().id("toast-login-copy").flex_none().px(6).py(3).rounded(4).bg(t.raised)
          .text_size(12).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(command); m.copied = true; cx.notify(); })
          .child(m.copied ? "Copied" : "Copy")))));
}

/** Opens Needs you in the question's space (the board copy takes shepherd.needs). */
const openNeeds = (s) => run(`shepherd.needs:${s.space}`);

function questionToast(m, p, s) {
  const t = palette();
  const close = () => closeOverlay(p.overlay);
  const space = spaces().find((x) => x.id === s.space);
  const button = (id, label, solid, onClick) => div().id(id).flex_none().max_w(120).h(22).px(9).flex().items_center()
    .rounded(5).text_size(11.5).cursor_pointer().truncate().tooltip(label)
    .when(solid, (el) => el.bg(t.solid).text_color(t.solid_foreground).font_medium().hover((x) => x.opacity(0.9)))
    .when(!solid, (el) => el.border(1).border_color(t.input).text_color(t.muted).hover((x) => x.bg(t.hover).text_color(t.foreground)))
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(); })
    .child(label);
  return v_flex().id("toast").size_full().px(12).py(6).gap(4).bg(t.popover)
    .border(1).border_color(m.tint(t.blocked, 0.45)).cursor_pointer()
    .on_click(() => { close(); openNeeds(s); })
    .child(h_flex().h(18).gap(8).items_center()
      .child(div().size(16).flex_none().rounded(8).bg(t.blocked).flex().items_center().justify_center()
        .text_size(10.5).font_bold().text_color(t.background).child("?"))
      .child(div().flex_none().text_size(12.5).font_medium().text_color(t.foreground).child(p.title))
      .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(10.5).text_color(t.dim).child(space?.name ?? ""))
      .when(Boolean(s.meta), (el) => el.child(div().flex_none().font_family(MONO).text_size(10).text_color(t.dim).child(s.meta)))
      .child(div().id("toast-x").size(18).flex_none().flex().items_center().justify_center().rounded(4)
        .text_size(10).text_color(t.dim).cursor_pointer().hover((x) => x.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); close(); })
        .child("✕")))
    .child(h_flex().flex_1().min_h(0).gap(10).items_center()
      // Two lines of the question at most; the rest is cut.
      .child(div().flex_1().min_w(0).max_h(32).overflow_hidden().text_size(12).line_height("16px").text_color(t.muted)
        .child(p.body ?? ""))
      .when(Boolean(s.rec), (el) => el.child(button("toast-answer", s.rec, true, () => { m.answer({ id: s.q, task: s.task }, s.rec, space); close(); })))
      .child(button("toast-open", "Open", false, () => { close(); openNeeds(s); })));
}

export function renderToast(m) {
  const p = props() ?? {};
  const s = p.action?.args?.shepherd;
  if (!s?.q || !s?.space) return herdrToast(m, p);
  return questionToast(m, p, s);
}

/** Drops a closed toast from the count, so a new one doesn't close a live one early. */
export function untrackToast(id) {
  const list = shared(TOASTS) ?? [];
  if (list.some((x) => x.id === id)) setShared(TOASTS, list.filter((x) => x.id !== id));
}
