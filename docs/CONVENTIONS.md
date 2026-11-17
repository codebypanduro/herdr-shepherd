# Conventions

How Shepherd, its sub-agents and the mods find each other. Everything here is plain labels and files, so any piece can be replaced.

## Roles and labels

Every terminal Shepherd starts carries `herdr.space` and these. Shepherd's own terminal also has `herdr.tab=shepherd-<space>`, so it gets a tab; sub-agents have no `herdr.tab` and get one only when you **Keep as tab** in the terminal window.

| label | values | on |
|---|---|---|
| `herdr.role` | `shepherd`, `triager`, `planner`, `implementer`, `reviewer`, `ci`, `qa` | every agent |
| `shepherd.task` | task id, e.g. `HRD-144` | build-loop agents (implementer, reviewer, ci, qa) |
| `shepherd.stage` | `triage` `spec` `tickets` `implement` `review` `ci` `proof` `merge` | every sub-agent |
| `shepherd.loop` | `1`…`n` | build-loop agents |
| `shepherd.title` | the task's title | implementer and reviewer (cards without a task use it) |
| `shepherd.dir` | the repo's root | the Shepherd terminal (where the mods read tasks.json) |
| `shepherd.workflow` | the workflow file start.sh gave Shepherd (`workflow.json`, else `workflow.example.json`) | the Shepherd terminal (the status bar finds `bin/load.sh` and the board `bin/shep.mjs` beside it; on another machine, the mods read the settings from it) |

```
hc run --bg --keep --name hrd-144-impl-2 \
  --label herdr.space=<id> --label herdr.role=implementer \
  --label shepherd.task=HRD-144 --label shepherd.stage=implement --label shepherd.loop=2 \
  --label shepherd.title="Timer on each tab" \
  --cwd ~/.herdr/worktrees/herdr-app/hrd-144-timer-on-each-tab \
  -- claude --model sonnet "/implement HRD-144. Fix these findings: … Done: hc send <shepherd> 'done HRD-144'"
```

## Task state: `.herdr/shepherd/tasks.json`

Shepherd owns this file and is the only writer, always through `shepherd/bin/shep.mjs` (atomic writes; the top of shep.mjs lists its commands, and `shep` with none names them). The schema below is what the board reads; shep also writes `answered` (time) on an answered question, and an open stage run's history `result` is `"running"`. Mods read it with `watchFolder`. A task in `merge` is `blocked`: it waits on the person.

```json
{
  "space": "herdr-app",
  "tasks": [{
    "id": "HRD-144",
    "title": "Timer on each tab",
    "source": "you | issue#31",
    "stage": "implement",
    "status": "working | blocked | queued | paused | parked | done",
    "loop": 2,
    "maxLoops": 3,
    "blockedBy": ["HRD-143"],
    "parent": "HRD-140",
    "brief": "what the implementer is told on loop 1",
    "terminal": "t6",
    "worktree": "~/.herdr/worktrees/herdr-app/hrd-144-timer-on-each-tab",
    "branch": "hrd-144-timer-on-each-tab",
    "pr": 204,
    "prUrl": "https://github.com/…/pull/204",
    "proof": "optional: the proof folder (default .herdr/shepherd/proof/<id>)",
    "wait": "waiting for room on vps   (optional: why a queued ticket hasn't started; shep start clears it)",
    "history": [
      { "loop": 1, "stage": "implement", "result": "pass", "note": "timer in tabs mod",
        "start": "2026-11-17T09:02:11Z", "end": "2026-11-17T09:31:40Z",
        "model": "Sonnet 4.5", "tokens": 142000, "cost": 0.85 }
    ],
    "findings": [
      { "id": "f1", "loop": 1, "file": "mods/tabs/main.js", "line": 42,
        "text": "Uses setInterval…", "state": "open | fixing | resolved",
        "history": [{ "loop": 1, "state": "found" }, { "loop": 2, "state": "fixing" }, { "loop": 2, "state": "fixed" }] }
    ],
    "summary": "One paragraph Shepherd keeps current."
  }],
  "questions": [{
    "id": "q7", "task": "HRD-140", "kind": "triage | grill | approve | ask | escalate | merge",
    "from": "t5 implementer", "text": "…", "options": ["…"], "recommended": "…",
    "round": 2, "questions": [{ "q": "…", "options": ["…"], "recommended": "…", "why": "…" }],
    "tickets": [{ "key": "A", "title": "…", "brief": "…", "blockedBy": ["…keys"] }],
    "asked": "2026-11-17T10:12:00Z", "answer": null
  }]
}
```

## The chat: `.herdr/shepherd/chat.jsonl`

The History window's lines, one JSON object per line: `{"at": "<ISO time>", "from": "you" | "shepherd", "text": "…", "task": "T-3"?}`. Written only by appending, with `shep say [--from you] [--task <id>] "<text>"`: the board for every line it sends Shepherd except grilling rounds, Shepherd for everything it tells the person.

## Talking to Shepherd

The mods send plain lines to Shepherd's terminal with `hc send <shepherd> "<line>"`:

| line | meaning |
|---|---|
| `answer q7: One more loop` | answer a question (free text works too) |
| `round q2: 1. One loop 2. Only after both pass 3. Herdr and my phone` | answer a grilling round |
| `steer HRD-144 redirect: fix the failing test first` | redirect the agent on a task |
| `steer HRD-144 context: use the core's start time` | add context |
| `pause HRD-144` / `resume HRD-144` | pause or resume |
| `status HRD-144?` | Shepherd replies with `shep say --task HRD-144`, so the reply shows in the History |
| anything else | a normal message to Shepherd |

Every line the board sends, except `round …`, is also kept in chat.jsonl with `shep say --from you` (answers, steer, pause and status with their task).

Sub-agents report with `hc send <shepherd> "done HRD-144: …"` or `"ask HRD-144: …"` (triagers `triage HRD-144: …`, reviewers `review HRD-144: pass|findings`, qa `proof HRD-144: pass|fail …`; CI is a plain program whose exit reaches Shepherd as a note). Planners report with `grill <id> round <n>: <path>`, `spec <id>: <path>` and `tickets <id>: <path>`; plan files live in `.herdr/shepherd/plans/<id>/`. They never talk to the person.

## Workflow: `shepherd/workflow.json` (per person) and `.herdr/orchestra.json` (per space)

See `shepherd/workflow.example.json`. Per-space keys override per-person ones. Workflow settings writes the person's `shepherd/workflow.json` (git-ignored; made from the example the first time) in the checkout `~/.config/herdr-app/mods/shepherd` links to, then sends every Shepherd on this computer `workflow changed: read <file>`. Space settings writes `.herdr/orchestra.json`; `stages.ci.command: ""` there means no CI for that space.

## Colors

Mods use `theme()` names only (`palette()` in common.js). Herdr's own status colors differ by theme (graphite: working yellow, blocked red), so the board keeps the design's hues with ANSI colors, which every theme defines:

- working (and the build loop group): `ansi4`, blue
- needs you / blocked: `ansi3`, amber
- done (and the ship group): `ansi2`, green
- plan group: `ansi5`, purple (there is no purple theme color)
- stuck and failures: `ansi1`, red
