# Mods

- `shepherd/`: the whole layout in one mod. `props.view` picks the main view (board, pipeline, deps, needs) and `props.panel` a side role (spaces, tabs, detail, status, bar) or an overlay (steer, term, termfoot, digest, history, plus, machine, usage, newspace, addmachine, workflow, spacesettings). See `main.js` and RECIPE.md *Built from*.

`herdr-app check mods/shepherd` checks the board only (no props); RECIPE.md *Watch out* says how to check the other panels.
