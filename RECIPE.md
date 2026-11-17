# Shepherd

A board for a software factory. Each space has one Shepherd agent that you talk to through a floating bar at the bottom. Shepherd takes every task through Plan (triage, spec, tickets), a Build loop (implement, code review, CI, proof; at most 3 times) and Ship (ready to merge, done). Sub-agents never talk to you; their questions come to you through Shepherd, in a Needs you list, as toasts and on your phone.

![Shepherd](preview.png)

## What you see

The window, left to right and top to bottom. All sizes at zoom 1. Colors are theme names, with the graphite hex the prototype uses in brackets.

**Title bar** (38px, `chrome` #131417, bottom border `border` #25272d). Window buttons, then centered "Herdr / layout **shepherd**", and on the right the `ctrl-shift-l` hint.

**Sidebar** (240px, `chrome`, right border `border`).
- A two-way toggle at the top: **This space** | **All spaces**. All spaces has an amber count badge of every open question.
- **SPACES** header (11px, letter-spacing .04em, `dim` #6c6f77) with a **+** button. The + opens a menu: *New space from folder…* (N) and *New folder* (F).
- Folders: ▶ chevron, folder icon, name, space count. A collapsed folder shows the amber question count of the spaces inside it.
- Space rows (6px 8px padding, radius 6px; selected row `hover` #1e2025): a 24px org avatar (the GitHub org image, radius 6px). An amber badge with the open question count sits on the avatar's top-right corner. Next to it the name (13px), and under it the machine icon + machine name · branch · ⑂ worktree count (10.5px mono, `dim`). On the right a status dot with the open task count, and a ⚙ that opens Space settings.
- Footer row: one icon per machine (MacBook, Mac mini, server, tower; a status dot in the corner) and a **+** to add a machine. On the right, the weekly Claude % and Codex %, each with its agent's icon. Clicking a machine or the usage opens a popover with the details.

**Tab bar** (36px, `chrome`). A pill "shepherd · <space>" with a status dot, a "shell" pill, any terminals kept as tabs, and +. On the right:
- view switch: **Board · Pipeline · Dependencies · Needs you** (Needs you has an amber count)
- **Digest** (D)
- **⌘K**
- **⚙ Workflow**

**Main area** (6px padding; 108px bottom padding so the floating bar never covers cards). The board pane takes the free width. When a task is open, a detail pane sits on its right (min(620px, 54%), min 380px). Both panes have radius 6px and a 1px `border`.

**Board pane header** (32px): "pipeline", "<space> · N tasks", then three status filters: ● N working, ● N need you, ● N done. Click one to show only that status; several can be on at once; ✕ clear resets.

**Board.** Nine columns, min 172px each, scrolling sideways:
- PLAN (purple oklch(0.74 0.11 290)): Triage, Spec, Tickets.
- BUILD LOOP · MAX 3 (blue oklch(0.74 0.11 245)): Implement, Code review, CI, Proof.
- SHIP (green oklch(0.75 0.12 155)): Ready to merge, Done.

Each group's label sits above its first column, and the column header has a 2px underline in the group color. **Card** (10px padding, radius 6px, `surface` #17181c, 1px `border`):
- Top row: id (11px mono, `muted` #9b9ea6), the current skill (`/implement`, `/code-review`… 10.5px mono `dim`), loop dots (one 6px square per allowed loop: done loops grey, current loop in the status color, unused loops dark), then ⋯ (steer).
- The title (13px, line-height 1.35).
- A status dot plus the last note, and on the right the time in this stage (10.5px mono).
- Optional lines: "stuck · over 50m in Implement" (red), "blocks HRD-148" / "after HRD-143" (mono, `dim`), and "↳ asked you via shepherd" (amber).
- Card background and border by state: blocked has an amber tint and border, stuck a red border, selected an accent border, keyboard focus a 1px accent ring.

**Pipeline view**: one row per task, with a cell per stage: ✓ for passed stages, the agent's terminal id (or "needs you") in the current stage, blank ahead. Loop dots sit on the right.

**Dependencies view**: chains of tickets left → right with arrows. Chains held up by one of your answers come first, under the heading "HELD UP BY YOU".

**Needs you view**: one card per open question (max-width 760px):
- A kind chip in its group color with an icon: triage (funnel), grilling (?), approve tickets (list), question (?), loops used up (↻), ready to merge (merge icon).
- The task id and title, then where it is ("Code review · loop 3/3").
- The question (14px), and who asked it with the last finding.
- Answer buttons, with the recommended one marked "recommended".
- A free-text reply field.
- Grilling rounds list each question with its options: the recommended answer is preselected, with a one-line reason under it. A "Send round N answers" button sends them.
- Approve-tickets cards list the proposed tickets and what each one waits on.

**Task detail pane.**
- Header: id, title, a stage chip in its group color (merge icon for Ready to merge, ✓ for Done), "loop 2/3", cost, a terminal chip (▭ t6) and ✕.
- Worktree line: ⑂ branch · machine:~/.herdr/worktrees/<repo>/<branch>.
- Tabs (switch with 1–5): **Overview · Review · Changes · Files · Proof**.
  - **Overview**:
    - Ready-to-merge tasks start with a PR card: PR number, branch → main, diff size, every CI check with time, then **Squash and merge** and **Send back**.
    - Shepherd's summary (14px).
    - A timeline bar: one segment per stage per loop, width ∝ time, colored by result (pass green, fail red, running blue and pulsing, asking amber). Loop labels sit above it, and totals (time, tokens, $) below. Hovering a segment shows its time, tokens, cost and model.
    - Comments from Shepherd, the reviewer, the planner and the implementer. Each has its agent's icon (Claude or Codex, picked from the model), a role color mark, the file:line it refers to, and a state chip (open, fixing, resolved, approved).
    - An "Ask Shepherd about <id>…" field.
  - **Review**:
    - A grid with one row per finding and one column per loop. Cells read found / still open / fixing / ✓ fixed, and the current loop's column is shaded.
    - Then a loop-by-loop list: what the implementer did, what review said, and counts of new, fixed and carried findings.
  - **Changes**: the list of changed files (+/−) on the left, a unified diff on the right.
  - **Files**: the worktree's file tree, with folder and file icons colored by extension. Changed files are marked A/M. Clicking a file shows it with its added lines highlighted.
  - **Proof**: the headless-browser checks, a grid of screenshots, and the recording.

**Floating Shepherd bar.** Centered 36px above the bottom edge, width min(780px, 100% − 40px), radius 14px, a large shadow.
- When something is open, its top strip shows the newest question with up to 3 answer buttons and "N waiting".
- The main row (56px): the Shepherd avatar (a Claude or Codex tile with a pulsing status dot), a 15px input "Tell Shepherd what to build, or ask about any task…", and under it "shepherd · <space> · <last event>". A **History ⌘J** button sits on the right.
- The border is amber while questions wait and turns the accent color with a 4px glow while you type.

**Status bar** (24px, mono 11px `dim`): herdr-core · local, implement model, review model, max loops, CPU/memory limits.

**Overlays.**
- **History window** (⌘J, 760px): the full chat. Your messages are in a tinted box with ❯. Shepherd's start with ⏺, and events with ⎿ and the task id in its tone color. Questions appear inline with answer buttons.
- **Terminal** (T, 900×640, terminal background): the agent's real terminal, read-only, with **Keep as tab** and **Steer**.
- **Steer menu** (⋯, S or right-click; 290px): Pause/Resume (P), Redirect… (R), Add context… (C), Ask for status (S), Open terminal (T), Open task (↵). Redirect and context open a text field: "Send to t6".
- **Peek**: hover a card for 380 ms to see its terminal's last lines.
- **Digest** (D, 720px): shipped, in flight, waiting on you, total spend; then Shipped, Stuck, Most expensive and "Needed more than one loop".
- **Command palette** (⌘K).
- **Workflow settings**: rows 00–07, Max build loops, Alerts, Machine load limits.
- **Space settings**: editable name, path and remote, CI command, Folder, Machine, Shepherd, Issue tracker.
- **New space** (folder picker), **Add machine** (SSH host, name, kind, temporary; shows the `hc machine add` command and its connection steps).
- **Toasts**: top right, max 3, 9 s.

## How it behaves

**Statuses.** Agents report over OSC 7501. working (blue, pulsing dot), blocked (amber: it needs you), done (green), idle (grey). A task's status is its current agent's. Paused (grey) is Shepherd's own.

**The flow.**
- **Triage.** Issues from other people start in Triage (`/triage`). Shepherd asks you for a label (needs-info / ready-for-agent / ready-for-human / wontfix) and recommends one.
- **Spec.** Work you ask for skips triage and starts in Spec (`/to-spec`; `/wayfinder` when it's too big for one session). Grilling rounds come to you as one card per round.
- **Tickets.** `/to-tickets` proposes vertical slices with blocking edges, the first one a prefactor. You approve or ask to merge them. The tickets appear in Tickets as ready-for-agent, or "blocked by X".
- **Build loop.** A ticket starts when its blockers are done **and** its space's machine is under the CPU and memory limits; otherwise its note says "waiting for room on vps". Then Implement (`/implement`) → Code review (`/code-review`) → CI (the space's command) → Proof (headless browser: screenshots and a recording).
  - A review finding or a failing check sends the ticket back to Implement and uses a loop.
  - After the last loop Shepherd asks you: One more loop / Park it / I'll take it.
- **Ship.** On a pass Shepherd opens a PR and asks to merge. Merge squashes it and removes the branch and worktree. Send back returns the ticket to Implement.

**Questions** from any sub-agent go to Shepherd, which shows them:
- in Needs you
- in the bar
- in the history
- as a toast with a sound and a phone push, each of which can be turned off in Workflow → When an agent needs you

**Spaces.**
- One Shepherd per space. Choosing a space filters the board, Needs you, the chat and the digest to it. All spaces shows everything, with a space tag on each chat line.
- Spaces live on one machine. Changing a space's machine starts a new space there.
- Folders are only for the sidebar. Drag a space onto a folder to put it in. While you drag a foldered space, a "Drop here to take it out of the folder" area appears. The folder can also be set in Space settings.

**Keys** (only in this layout, never global):
- ⌘K palette
- ⌘J history
- G then B / P / D / N for the views
- J / K to move between cards, ↵ to open one
- A to accept the recommended answer (or Merge / Approve)
- S steer, P pause, T terminal
- C new task
- D digest
- N new space, F new folder
- 1–5 task tabs
- Esc closes the top overlay

**Stuck.** A working task goes stuck past its stage's limit: triage 40m, spec 2h, tickets 1h, implement 50m, review 25m, CI 20m, proof 20m.

## Built from

- **Layout** `layouts/shepherd.json`, a root row:
  - `sidebar` (px 240): `shepherd-spaces`
  - `work` (column), containing:
    - `tabs` (px 36, shipped `tabs` mod)
    - `main` row of `board` (mod `shepherd`, props `{view}`) and `detail` (mod `shepherd`, props `{panel:"detail"}`, hidden until a task is open)
  - a floating block `bar` (mod `shepherd-bar`, edge bottom, align center)
  - the status bar (px 24)
- **Shepherd agent**: one per space, started with `hc run --keep --label herdr.space=<id> --label herdr.role=shepherd -- claude ...` and the prompt in `shepherd/PROMPT.md`. It starts sub-agents with `hc run --bg` and labels them (see CONVENTIONS), reads their reports from its input (`<hc from=…>`), and writes task state to `.herdr/shepherd/tasks.json` in the repo.
- **Mods** read `agents()`, `terminals()` (parent, labels), `spaces()`, `machines()` and `watchFolder()` on the tasks file. They answer questions with `hc send <shepherd> …`. Commands used: `terminal.peek`, `terminal.keep`, `space.new {machine, folder}`, `layout.show/hide`, `notify`, `playSound("blocked")`, `openOverlay`.
- **Programs run**: `git worktree`, `gh pr` (PR, checks, merge), `hc exec --on <machine>` for CPU, memory and disk (`top`, `vm_stat` / `free`, `df`), the space's CI command, and Claude or Codex for usage.

## Watch out

- The prototype is HTML. Mods can't use CSS or timers to animate: use `.loop("opacity", …)` for pulsing dots and `.frames()` for spinners.
- Hover peek needs `.on_hover` plus a short `cx.timer` delay; cancel it on leave.
- Dragging spaces between folders has no built-in drop target in mods; use press, move and release on the rows, or offer the Folder picker only at first.
- Keys must go in `keys.json` under `"layout:shepherd"`, never global, and must not take plain letters while a terminal has focus.
- Weekly Claude and Codex usage isn't in Herdr; read it from each CLI's usage command, and hide the row when a tool isn't installed on any machine.
- Don't run `/triage` on tickets made by `/to-tickets`; they are agent-ready.
- The timeline and digest need real start and end times per stage: Shepherd must record them in tasks.json.
- Plan purple is `theme().ansi5`: there is no purple theme color, and deriving one from `accent` needs color math the mods don't have.
- Until Shepherd writes tasks.json (slice 2), the board reads only labels: `shepherd.task` (id), `shepherd.stage`, `shepherd.loop`, optional `shepherd.title`. Time in stage is counted by the mod from when it first sees a terminal in a stage (its `created_ms` on first sight), so it resets when the mod reloads.
- Herdr writes `jsconfig.json` and `gpui-kit.d.ts` into each mod folder; they are git-ignored.

## Done when

- Asking Shepherd "add a timer to each tab" creates a task in Spec, sends you a grilling round in Needs you and the bar, and after you answer shows tickets to approve.
- An approved ticket gets its own worktree and goes Implement → Code review. A review finding sends it back with loop 2/3 on the card, and the Review tab shows the finding as found then fixed.
- A ticket that fails review three times asks you One more loop / Park it / I'll take it.
- A passing ticket shows Ready to merge with its PR checks, and Merge squashes it and removes the worktree.
- When a sub-agent asks something, you get a toast, a sound and a phone push, plus an amber badge on its space.
- With the machine over the CPU limit, ready tickets wait with "waiting for room on <machine>" and start once it drops.
- T opens a working agent's real terminal, and S → Redirect sends it new instructions through Shepherd.
- Switching to a light Herdr theme keeps every color readable (no hard-coded hex).
