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

## 3. Needs you + floating bar ✅
Questions in tasks.json show in Needs you and the bar, and are answered with `hc send`. Add toast, sound and phone push.
**Done when:** a sub-agent question reaches you as a toast and is answered from the bar.
**Built:** `shep ask` / `shep answer`; Needs you view (Board · Needs you switch in the pane header); the bar is `shepherd` with `panel:"bar"`. Checked live: an implementer's question reached tasks.json, and `answer q1: 1.0.0` (what the bar sends) reached the implementer. A planted question opened a toast. The bar on screen is not checked yet. History (⌘J) is not built.

## 4. Task detail ✅
Overview (summary, timeline, comments), Review grid, Changes (git diff in the worktree), Files, Proof.
**Done when:** the Review tab shows a finding as found in loop 1 and fixed in loop 2.
**Built:** `detail.js` (header, Overview, Review, Proof placeholder) and `git.js` (Changes, Files). Checked: T-2's finding f1 reads found (loop 1) → ✓ fixed (loop 2); all five tabs render with T-2's real data; the git commands return T-2's change. Not built yet: timeline hover, the Ask Shepherd field, the PR card (slice 6), keys 1–5 (slice 7). Not seen on screen yet.

## 5. Plan stages ✅
`/triage`, `/to-spec` or `/wayfinder` with grilling rounds, and `/to-tickets` with approval and blocking edges.
**Done when:** a request becomes approved tickets that wait on each other.
**Built:** `shep add --blocked-by/--parent/--brief`, `shep ask --kind grill --questions` and `--kind approve --tickets`, `shep ready`; the Plan section of PROMPT.md; grilling-round and ticket cards in Needs you. Checked live: a request went Spec → two grilling rounds → 3 tickets approved (C after A and B), and Shepherd also made them wait on the unmerged T-1 and T-4 as answered in round 1. Triage is written but not run live.

## 6. CI, proof, merge ✅
The CI command per space, a headless browser with screenshots and a recording, a PR via `gh`, and Ready to merge.
**Done when:** Merge squashes the PR and removes the worktree.
**Built:** CI, Proof and Ship in PROMPT.md; `ship.js` (PR card with Squash and merge / Send back, Proof tab); `start.sh` keeps `.herdr/` out of git via `.git/info/exclude`. Checked live: T-4 went CI → Proof (4/4) → local squash merge with worktree and branch removed; T-6 went through to PR #1 on a private test repo, and Merge squashed it and removed the worktree. The remote branch was left behind on that run (fixed in the prompt since: remove the worktree before `gh pr merge --delete-branch`). No screenshots or recording yet: the demo has no UI.

## 7. Factory controls ✅
Machine load limits, time in stage and stuck, steering, the terminal overlay, the digest, the dependencies view, keys.
**Built:** the design's tab bar (`tabbar.js`: tab pills, view switch Board · Pipeline · Dependencies · Needs you, Digest, ⌘K, ⚙ Workflow), Pipeline and Dependencies views (`views.js`), the steer menu and terminal window (`steer.js`), the digest (`digest.js`), stuck cards from `stuckMinutes`, the status bar's machine load against `limits`, `shepherd/bin/load.sh` + `shep room [--wait]` + `shep set wait=…` and the room rule in PROMPT.md, board keys (J/K, G B/P/D/N, ↵, Esc, S, P, T, A, C, D, 1–5) and `keys.json` (`layout:shepherd`). Checked live on the demo: every view, the digest, the steer menu, the terminal window and the load gauge on screen; a stuck card and a "waiting for room on this mac" card from test tasks; Pause → Resume and a `steer … redirect:` line went through the live Shepherd and reached a stand-in terminal. After review: the History window (⌘J, `history.js`, `shep say` → chat.jsonl) was added and seen live with the demo's events, questions and two test chat lines; C → bar ("add ") and the D/⌘J toggles checked as commands. Known gap: the terminal window can't be read-only (Herdr has no read-only terminal block); its title bar takes the keyboard on open so S and Esc work until you click into the terminal. Not built: R, W, U keys. Not checked: plain-letter keys and ⌘ keys pressed by a person (no way to press keys from here; the same actions were run as `shepherd.<command>`), typing in the steer field, Shepherd actually holding a ticket for room (only `shep room` exit codes), the paper theme.

## 8. Spaces sidebar
Folders, org avatars, machines and usage, Space settings, New space, Add machine.
Also the machine load limits UI (from slice 7's review): Max CPU and Max memory in Workflow settings / Space settings, with each machine's current load as a bar (design ~1231-1258). Until then they're `limits` in workflow.json or `.herdr/orchestra.json`.

## 9. Share
`preview.png`, RECIPE.md checked against the real build, the `herdr-layout` topic.
