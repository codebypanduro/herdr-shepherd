# Mods

- `shepherd/`: the whole layout in one mod. `props.view` picks the main view (board, pipeline, deps, needs) and `props.panel` a side role (spaces, tabs, detail, status, noshep) or an overlay (steer, digest, palette, plus, machine, usage, newspace, addmachine, workflow, spacesettings, setup, newtab, closetab, and the toast). What the work area shows, ✻ Shepherd or a tab, is `mode.js`. See `main.js` and RECIPE.md *Built from*.

`herdr-app check mods/shepherd` checks the board only (no props); RECIPE.md *Watch out* says how to check the other panels.
