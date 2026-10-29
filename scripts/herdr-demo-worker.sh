#!/bin/sh
# Mock worker for the herdr slice-0 demo (scripts/herdr-demo.mjs).
# Runs inside a herdr pane; HERDR_PANE_ID is set by herdr itself.
# The completion sentinel lives in this file, not the invocation line,
# so `pane wait-output` cannot match the echoed command text.

if [ "$1" = "merge" ]; then
  task="$2"
  herdr pane report-metadata "$HERDR_PANE_ID" --source afk:progress --title "merging #$task" --token "progress=merging #$task" >/dev/null 2>&1
  echo "[integrator] merging afk/$task into main"
  sleep 2
  echo "[integrator] post-merge checks green"
  echo "AFK_MERGED_$task"
  exit 0
fi

task="$1"
secs="${2:-2}"
i=0
total=5
for phase in Resolve Context Plan Implement Test; do
  i=$((i + 1))
  herdr pane report-metadata "$HERDR_PANE_ID" --source afk:progress --title "$i/$total · $phase" --token "progress=$i/$total · $phase" >/dev/null 2>&1
  echo "[task $task] $i/$total $phase"
  sleep "$secs"
done
herdr pane report-metadata "$HERDR_PANE_ID" --source afk:progress --title "done · awaiting integration" --token "progress=done · awaiting integration" >/dev/null 2>&1
echo "AFK_TASK_DONE_$task"
