# Mods

Empty until slice 1. Planned:

- `shepherd/`: board, pipeline, dependencies, needs you, task detail, digest, status bar (one mod; `props.view` / `props.panel` pick what it draws)
- `shepherd-bar/`: the floating bar, history window, steer menu, toasts
- `shepherd-spaces/`: the sidebar (spaces, folders, machines, usage), space settings, new space, add machine

Each needs `main.js` and `mod.json` (`{"place":"none"}`), and a passing `herdr-app check`.
