# For agents working on this repo

- This repo is a Herdr layout. Before anything else, read `~/.config/herdr-app/AGENTS.md` and `hc --skill`; they match the installed version and win over anything here.
- Read README.md, RECIPE.md, docs/CONVENTIONS.md, then build the next unchecked slice in docs/SLICES.md.
- `docs/design/*.dc.html` are HTML prototypes for look and behavior. Don't copy their code; mods are gpui-kit.
- Use `theme()` colors, never hex. No `setTimeout` / `setInterval`; use `cx.timer`, and `.loop` / `.frames` for animation.
- Run `herdr-app check mods/<name>` after every change, and `herdr-app shot` to look at the result.
- Keep RECIPE.md true to the code.
