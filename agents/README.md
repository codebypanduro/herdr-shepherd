# Agents for building this repo

Two `hc` templates, symlinked into `~/.config/herdr-core/templates/`:

```sh
for f in slice-builder code-review; do ln -sf "$PWD/agents/$f.md" ~/.config/herdr-core/templates/$f.md; done
```

## A slice, start to finish

The lead (the agent the person talks to) runs this and relays each report to the person.

```sh
SPACE=$(hc get $HC_TERMINAL_ID | jq -r '.labels["herdr.space"]')
hc run --bg --name slice-7 --cwd "$PWD" --label herdr.space=$SPACE --label herdr.tab=slice-7 \
  slice-builder "Build slice 7. Lead: $HC_TERMINAL_ID. Scratch repo for live tests: <path or none>."
# … "slice 7 ready: .herdr/slices/slice-7.md"
hc run --bg --name review-7 --cwd "$PWD" --label herdr.space=$SPACE --label herdr.tab=review-7 \
  code-review "Review main..slice-7. Spec: slice 7 in docs/SLICES.md. Findings: .herdr/slices/review-7.md. Lead: $HC_TERMINAL_ID."
# … "review done: …" → hc send slice-7 "Review findings: .herdr/slices/review-7.md"
# … "slice 7 ready" again → the person hears the report; merge slice-7 into main.
```

Reports live in `.herdr/slices/` (kept out of git by `.git/info/exclude`).
