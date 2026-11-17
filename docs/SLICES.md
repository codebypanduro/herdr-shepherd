# Build slices

Each slice is usable on its own. Check every mod with `herdr-app check` before moving on.

## 1. Board from labels ✅
A layout and a `shepherd` mod that groups `terminals()` with a `shepherd.stage` label into the nine columns, with no Shepherd yet.
**Done when:** `hc run --label shepherd.task=T1 --label shepherd.stage=review -- sleep 600` shows a card in Code review, and it moves when you relabel it.
**Built:** `mods/shepherd` (board + a minimal status bar; `panel:"detail"` draws an empty surface). Until slices 3 and 8, the layout uses the shipped `spaces` sidebar and has no floating bar.

## 2. Shepherd agent, one stage ✅
`shepherd/PROMPT.md` + `tasks.json`. Shepherd takes a request, writes a task, and runs Implement → Code review with up to 3 loops.
**Done when:** a task with a review finding goes back to Implement as loop 2, and the card shows it.
**Built:** `shepherd/PROMPT.md`, `shepherd/start.sh`, `shepherd/bin/shep.mjs`; the board reads tasks.json. Checked with a live Shepherd on a scratch repo: a review finding sent T-2 back to Implement as loop 2, and the finding went found → fixing → fixed. The card on screen is not checked yet.

## 3. Needs you + floating bar
Questions in tasks.json show in Needs you and the bar, and are answered with `hc send`. Add toast, sound and phone push.
**Done when:** a sub-agent question reaches you as a toast and is answered from the bar.

## 4. Task detail
Overview (summary, timeline, comments), Review grid, Changes (git diff in the worktree), Files, Proof.
**Done when:** the Review tab shows a finding as found in loop 1 and fixed in loop 2.

## 5. Plan stages
`/triage`, `/to-spec` or `/wayfinder` with grilling rounds, and `/to-tickets` with approval and blocking edges.
**Done when:** a request becomes approved tickets that wait on each other.

## 6. CI, proof, merge
The CI command per space, a headless browser with screenshots and a recording, a PR via `gh`, and Ready to merge.
**Done when:** Merge squashes the PR and removes the worktree.

## 7. Factory controls
Machine load limits, time in stage and stuck, steering, the terminal overlay, the digest, the dependencies view, keys.

## 8. Spaces sidebar
Folders, org avatars, machines and usage, Space settings, New space, Add machine.

## 9. Share
`preview.png`, RECIPE.md checked against the real build, the `herdr-layout` topic.
