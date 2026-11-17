# Mods

Empty until slice 1. Planned:

- `shepherd/`: board, pipeline, dependencies, needs you, task detail, digest, status bar, the floating bar and its history window (one mod; `props.view` / `props.panel` pick what it draws)
- `shepherd-spaces/`: the sidebar (spaces, folders, machines, usage), space settings, new space, add machine

Each needs `main.js` and `mod.json` (`{"place":"none"}`), and a passing `herdr-app check`.
