# Shepherd for Herdr

A Herdr layout that turns your agents into a software factory. You talk to one agent per space, **Shepherd**. Shepherd runs every task through a fixed workflow built on [mattpocock/skills](https://github.com/mattpocock/skills), starts the sub-agents, and only brings you the questions that need you. A board shows where every task is at all times.

```
Plan         Triage → Spec / wayfinder → Tickets
Build loop   Implement → Code review → CI → Proof      (max 3 loops, then Shepherd asks you)
Ship         Ready to merge → Done
```

## Status

Design is done. Implementation starts at **Slice 1** in [docs/SLICES.md](docs/SLICES.md).

## Start here (for the agent building it)

1. Read `~/.config/herdr-app/AGENTS.md` (`herdr-app --skill`) and `hc --skill`. They are the truth for this Herdr version.
2. Read [RECIPE.md](RECIPE.md): what the person sees and how it behaves.
3. Read [docs/CONVENTIONS.md](docs/CONVENTIONS.md): labels, stages, files and messages that tie the pieces together.
4. Open `docs/design/Shepherd.dc.html` in a browser to see the target. It is an HTML prototype with simulated data.
5. Build one slice from [docs/SLICES.md](docs/SLICES.md) at a time. Run `herdr-app check mods/<name>` after every change.

## Screenshots

From the prototype at 1440px wide, in `docs/design/screenshots/`: board, task overview, review grid, needs you, dependencies, history (⌘J), digest, steer menu, terminal, and the light (paper) theme. GitHub org avatars show blank in the captures.

![Board](docs/design/screenshots/01-board.png)

## About the design files

The files in `docs/design/` are **design references made in HTML**, not code to ship. Herdr mods are written in gpui-kit (JavaScript describing native GPUI elements): no HTML, no CSS, no DOM. Recreate the layout, colors, type and behavior with gpui-kit and the `herdr` module, and use `theme()` colors instead of the hex values so the layout follows light and dark themes. The prototype's numbers (times, tokens, costs, CPU) are simulated.

**Fidelity: high.** Spacing, type sizes, colors and copy are final. Where the prototype does something Herdr can't (hover peek with a timer, drag and drop of spaces), see *Watch out* in RECIPE.md.

## Install (once built)

```
❯ Read ~/.config/herdr-app/AGENTS.md, then add this layout: <this repo URL>
```

Switch to it with `ctrl-shift-l`.

## Sharing

Add the GitHub topic `herdr-layout`, keep `RECIPE.md` and `preview.png` current, and it shows up at herdr.dev/layouts.

## Repo

```
layouts/shepherd.json          the window: sidebar · board + detail · floating bar
mods/shepherd/                 board, needs you, floating bar, task detail, digest, deps (one mod, several views)
mods/shepherd-spaces/          sidebar: spaces with folders, machines, usage
shepherd/                      the Shepherd agent: prompt, workflow.json, helper scripts
docs/                          recipe support: conventions, slices, design prototypes
```
