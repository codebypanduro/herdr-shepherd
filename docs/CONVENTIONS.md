# Conventions

How Shepherd, its sub-agents and the mods find each other. Everything here is plain labels and files, so any piece can be replaced.

## Roles and labels

Every terminal Shepherd starts carries the Herdr labels (`herdr.space`, `herdr.tab`) and these:

| label | values | on |
|---|---|---|
| `herdr.role` | `shepherd`, `triager`, `planner`, `implementer`, `reviewer`, `ci`, `qa` | every agent |
| `shepherd.task` | task id, e.g. `HRD-144` | sub-agents |
| `shepherd.stage` | `triage` `spec` `tickets` `implement` `review` `ci` `proof` `merge` | sub-agents |
| `shepherd.loop` | `1`…`n` | build-loop agents |
| `shepherd.title` | the task's title | sub-agents (cards without a task use it) |
| `shepherd.dir` | the repo's root | the Shepherd terminal (where the mods read tasks.json) |

```
hc run --bg --keep \
  --label herdr.space=<id> --label herdr.role=implementer \
  --label shepherd.task=HRD-144 --label shepherd.stage=implement --label shepherd.loop=2 \
  --cwd ~/.herdr/worktrees/herdr-app/hrd-144-timer-on-each-tab \
  -- claude --model sonnet-4.5 "/implement HRD-144. Fix these findings: … Done: hc send <shepherd> 'done HRD-144'"
```

## Task state: `.herdr/shepherd/tasks.json`

Shepherd owns this file and is the only writer, always through `shepherd/bin/shep.mjs` (atomic writes; `shep --help` lists its commands). Mods read it with `watchFolder`. A task in `merge` is `blocked`: it waits on the person.

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
    "terminal": "t6",
    "worktree": "~/.herdr/worktrees/herdr-app/hrd-144-timer-on-each-tab",
    "branch": "hrd-144-timer-on-each-tab",
    "pr": 204,
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
    "tickets": [{ "id": "T1", "title": "…", "blockedBy": "" }],
    "asked": "2026-11-17T10:12:00Z", "answer": null
  }]
}
```

## Talking to Shepherd

The mods send plain lines to Shepherd's terminal with `hc send <shepherd> "<line>"`:

| line | meaning |
|---|---|
| `answer q7: One more loop` | answer a question (free text works too) |
| `round q2: 1. One loop 2. Only after both pass 3. Herdr and my phone` | answer a grilling round |

Planners report with `grill <id> round <n>: <path>`, `spec <id>: <path>` and `tickets <id>: <path>`; plan files live in `.herdr/shepherd/plans/<id>/`.
| `steer HRD-144 redirect: fix the failing test first` | redirect the agent on a task |
| `steer HRD-144 context: use the core's start time` | add context |
| `pause HRD-144` / `resume HRD-144` | pause or resume |
| `status HRD-144?` | Shepherd replies in its own output |
| anything else | a normal message to Shepherd |

Sub-agents report with `hc send <shepherd> "done HRD-144 …"` or `"ask HRD-144: …"`. They never talk to the person.

## Workflow: `shepherd/workflow.json` (per person) and `.herdr/orchestra.json` (per space)

See `shepherd/workflow.example.json`. Per-space keys override per-person ones.

## Colors

Mods use `theme()` names only. Group colors come from the status colors:

- plan uses a purple derived from `accent`
- build loop uses `working`
- ship uses `done`
- "needs you" uses `blocked`
- stuck uses ansi red
