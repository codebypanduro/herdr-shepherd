// Starting Shepherd from anywhere: the inline Start Shepherd action (the ✻ Shepherd area with no
// Shepherd, panel "noshep"; the sidebar), the
// "Set up Shepherd on <machine>" dialog (panel "setup": confirm, clone, check) and the tab bar's +
// menu (panel "newtab": Shepherd, Terminal and each agent installed on the space's machine).
// Every start goes through m.startShepherd().

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, run, props, closeOverlay } from "herdr";
import { MONO, palette } from "./common.js";
import { SETUP_DIR, SETUP_REPO, checkStartable, setupShepherd, openSetup, button } from "./ui.js";

/** The ✻ Shepherd mark on an `accent` tile (the bar's avatar, small). */
export const shepherdMark = (t, size = 16) => div().size(size).flex_none().rounded(Math.round(size / 4)).bg(t.accent)
  .text_color(t.accent_foreground).flex().items_center().justify_center().text_size(Math.round(size * 0.62)).child("✻");

/** A program's icon (Program from terminals() / knownAgents()): a one-color glyph in `muted`, or
 *  the shipped colored image; a terminal glyph when it has none. */
export function programIcon(t, program, size = 13) {
  const icon = program?.icon ?? "icons/shell.svg";
  const tinted = program?.icon ? program.tint : true;
  return tinted ? svg(icon).size(size).flex_none().text_color(t.muted) : image(icon).size(size).flex_none();
}

/** Start Shepherd for a space, inline (one short line): "Start Shepherd", "Starting…", "Checking…",
 *  "Set up Shepherd on <machine>" when that machine has no herdr-shepherd checkout, or the reason it
 *  can't, greyed (whole on hover), with Retry when the machine didn't answer. Nothing when it runs. */
export function startAction(m, t, space, idp, { size = 12 } = {}) {
  const st = m.startState(space);
  const stop = (_e, cx) => cx.stop_propagation();
  const link = (id, label, onClick) => div().id(id).flex_none().text_size(size).text_color(t.accent).cursor_pointer()
    .hover((s) => s.text_color(t.foreground))
    .on_mouse_down("left", stop)
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); cx.notify(); })
    .child(label);
  const dim = (text) => div().flex_none().text_size(size).text_color(t.dim).child(text);
  if (st.state === "running") return div();
  if (st.state === "starting") return dim("Starting…");
  if (st.state === "checking") return dim("Checking…");
  if (st.state === "ok") return link(`${idp}-start`, "Start Shepherd", () => m.startShepherd(space, st.known));
  if (st.state === "missing") {
    return h_flex().id(`${idp}-why`).min_w(0).gap(6).items_center().tooltip(`Can't start here: ${st.reason}`)
      .child(link(`${idp}-setup`, `Set up Shepherd on ${space.machine}`, () => openSetup(space.machine, space.id)));
  }
  return h_flex().min_w(0).gap(6).items_center()
    .child(div().id(`${idp}-why`).min_w(0).max_w(320).truncate().text_size(size).text_color(t.dim)
      .tooltip(`Can't start here: ${st.reason}`).child(`Can't start here: ${st.reason}`))
    .when(st.state === "unreachable", (el) => el.child(link(`${idp}-retry`, "Retry", (cx) => {
      const asked = checkStartable(m, space.machine ?? null, true);
      cx.spawn(async (cx) => { await asked; cx.notify(); });
    })));
}

/** Panel "noshep": where Shepherd's terminal goes under the views, while the shown space has none. */
export function renderNoShepherd(m) {
  const t = palette();
  const space = m.shownSpace();
  return v_flex().id("shepherd-noshep").size_full().items_center().justify_center().gap(10)
    .rounded(6).border(1).border_color(t.border).bg(t.background).text_color(t.foreground)
    .child(h_flex().gap(8).items_center()
      .child(div().opacity(0.6).child(shepherdMark(t, 18)))
      .child(div().text_size(13).text_color(t.muted).child("No Shepherd in this space")))
    .when(Boolean(space), (el) => el.child(startAction(m, t, space, "noshep", { size: 12.5 })));
}

// ---- Set up Shepherd on <machine> ---------------------------------------------------------------

/** Setup's state, made in init: confirm → cloning → checking → done | error. */
export const initSetup = (m) => { m.setup = { phase: "confirm", error: null, reason: null }; };

/** Clones, then asks shepherdOn again (shared, so every Start Shepherd sees the answer). */
export function runSetup(m, cx, machine) {
  const st = m.setup;
  if (st.phase === "cloning" || st.phase === "checking") return;
  Object.assign(st, { phase: "cloning", error: null, reason: null });
  cx.notify();
  cx.spawn(async (cx) => {
    const r = await setupShepherd(machine);
    if (r.error) { Object.assign(st, { phase: "error", error: r.error }); cx.notify(); return; }
    st.phase = "checking";
    cx.notify();
    const s = await checkStartable(m, machine, true);
    Object.assign(st, s.dir ? { phase: "done", known: s } : { phase: "error", error: `Cloned, but Shepherd can't start there yet: ${s.reason}` });
    cx.notify();
  });
}

export function renderSetup(m) {
  const t = palette();
  const p = props() ?? {};
  const machine = p.machine;
  const space = spaces().find((x) => x.id === p.space) ?? null;
  const st = m.setup;
  const close = () => closeOverlay(p.overlay);

  const go = (cx) => runSetup(m, cx, machine);

  const step = (mark, color, text, sub) => h_flex().gap(10).items_start()
    .child(div().w(14).flex_none().font_family(MONO).text_size(12).text_color(color).child(mark))
    .child(v_flex().flex_1().min_w(0).gap(2)
      .child(div().text_size(12.5).text_color(t.foreground).child(text))
      .when(Boolean(sub), (el) => el.child(div().text_size(11.5).text_color(color === t.ansi1 ? t.ansi1 : t.dim).child(sub))));
  const spin = (el) => el.loop("opacity", { from: 0.3, to: 1, period: 900 });

  const ph = st.phase;
  const cloneMark = ph === "cloning" ? "●" : ph === "confirm" ? "○" : ph === "error" && !st.error?.startsWith("Cloned") ? "✕" : "✓";
  const cloneColor = cloneMark === "✕" ? t.ansi1 : cloneMark === "✓" ? t.done : cloneMark === "●" ? t.working : t.dim;
  const checkMark = ph === "checking" ? "●" : ph === "done" ? "✓" : ph === "error" && st.error?.startsWith("Cloned") ? "✕" : "○";
  const checkColor = checkMark === "✕" ? t.ansi1 : checkMark === "✓" ? t.done : checkMark === "●" ? t.working : t.dim;

  return v_flex().id("shepherd-setup").size_full().bg(t.background).text_color(t.foreground).text_size(12.5)
    .child(v_flex().flex_none().px(18).pt(16).pb(12).gap(4).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center().child(shepherdMark(t, 18)).child(div().text_size(15).font_semibold().child(`Set up Shepherd on ${machine}`)))
      .child(div().text_size(12).text_color(t.dim).child(`${machine} has no herdr-shepherd checkout, so Shepherd can't start there.`)))
    .child(v_flex().flex_1().min_h(0).px(18).py(14).gap(12)
      .child(div().text_size(12.5).text_color(t.muted).child(`This runs one command on ${machine}, with its login shell's PATH:`))
      .child(div().px(10).py(8).rounded(5).border(1).border_color(t.border).bg(t.surface).font_family(MONO).text_size(11.5)
        .text_color(t.foreground).child(`git clone ${SETUP_REPO} ${SETUP_DIR}`))
      .child(div().text_size(11.5).text_color(t.dim).line_height(1.45)
        .child(`Nothing else changes on ${machine}: no links in ~/.config/herdr-app, no settings. Start Shepherd then finds it in ${SETUP_DIR}. Shepherd also needs node, hc and claude there. If ${SETUP_DIR} already holds a herdr-shepherd checkout, that's used and nothing is cloned; anything else there stops the setup.`))
      .when(ph !== "confirm", (el) => el.child(v_flex().gap(8).pt(4)
        .child(step(cloneMark, cloneColor, `Cloning into ${SETUP_DIR} on ${machine}`,
          ph === "error" && cloneMark === "✕" ? st.error : null))
        .child(step(checkMark, checkColor, "Checking that Shepherd can start there",
          ph === "error" && checkMark === "✕" ? st.error : ph === "done" ? `Ready: ${st.known?.dir ?? SETUP_DIR}` : null)))
        .when(ph === "cloning" || ph === "checking", (el) => el.child(spin(div().text_size(11).text_color(t.dim).child(ph === "cloning" ? "Cloning… (up to a few minutes)" : "Checking…"))))))
    .child(h_flex().flex_none().px(18).py(12).gap(8).items_center().border_t(1).border_color(t.border)
      .child(div().flex_1().font_family(MONO).text_size(10.5).text_color(t.dim).child(`${machine}:${SETUP_DIR}`))
      .when(ph === "confirm", (el) => el.child(button(t, "setup-cancel", "Cancel", close))
        .child(button(t, "setup-go", `Set up on ${machine}`, (_e, cx) => go(cx), { primary: true })))
      .when(ph === "cloning" || ph === "checking", (el) => el.child(button(t, "setup-close", "Close", close)))
      .when(ph === "error", (el) => el.child(button(t, "setup-close", "Close", close))
        .child(button(t, "setup-retry", "Retry", (_e, cx) => go(cx), { primary: true })))
      .when(ph === "done", (el) => el.child(button(t, "setup-done", "Done", close, { primary: !space || Boolean(m.shepherd(space)) }))
        .when(Boolean(space) && !m.shepherd(space), (el) => el.child(button(t, "setup-start", `Start Shepherd in ${space.name}`, () => {
          m.startShepherd(space, st.known);
          close();
        }, { primary: true })))));
}

// ---- the tab bar's + menu --------------------------------------------------------------------

/** props {space, agents: [{key, name, icon, tint, run}], error}: the tab bar asks knownAgents first. */
export function renderNewTab(m) {
  const t = palette();
  const p = props() ?? {};
  const space = spaces().find((x) => x.id === p.space) ?? null;
  if (!space) return div();
  const close = () => closeOverlay(p.overlay);
  const folder = m.repo(space)?.dir ?? space.folder ?? undefined;
  const newTab = (argv) => { run("tab.new", { space: space.id, ...(folder ? { folder } : {}), ...(argv ? { argv } : {}) }); close(); };
  const item = (id, icon, label, onClick, right = null) => h_flex().id(id).h(30).px(8).gap(9).items_center().rounded(5).cursor_pointer()
    .text_size(12.5).hover((s) => s.bg(t.hover)).on_click(onClick)
    .child(div().w(16).flex_none().flex().items_center().justify_center().child(icon))
    .child(div().flex_1().min_w(0).truncate().child(label))
    .when(Boolean(right), (el) => el.child(right));
  const st = m.startState(space);
  const shepItem = () => {
    if (st.state === "ok") return item("nt-shepherd", shepherdMark(t, 14), "Shepherd", () => { m.startShepherd(space, st.known); close(); });
    if (st.state === "missing") return item("nt-shepherd", shepherdMark(t, 14), `Set up Shepherd on ${space.machine}…`, () => { close(); openSetup(space.machine, space.id); });
    // Checking, starting, or can't: greyed, with the reason whole on hover.
    const why = st.state === "starting" ? "Starting…" : st.state === "checking" ? "Checking…" : `Can't start here: ${st.reason}`;
    return h_flex().id("nt-shepherd").h(30).px(8).gap(9).items_center().text_size(12.5).text_color(t.dim).tooltip(why)
      .child(div().w(16).flex_none().flex().items_center().justify_center().child(shepherdMark(t, 14)))
      .child(div().flex_none().child("Shepherd"))
      .child(div().flex_1().min_w(0).truncate().text_size(11).child(why));
  };
  return v_flex().id("shepherd-newtab").w_full().p(4).bg(t.popover).text_color(t.foreground)
    .when(st.state !== "running", (el) => el.child(shepItem()))
    .child(item("nt-terminal", programIcon(t, null, 14), "Terminal", () => newTab(null)))
    .children((p.agents ?? []).map((a, i) => item(`nt-a${i}`, programIcon(t, a, 14), a.name, () => newTab(a.run))))
    .when(Boolean(p.error), (el) => el.child(div().px(8).py(5).text_size(11).text_color(t.dim).child(p.error)));
}
