#!/bin/sh
# PostToolUse hook: the lane's elapsed time against its budget, shown to the
# agent after every tool call (lib.mjs `withTimeBudget`). $1 holds
# "<start epoch seconds> <budget seconds>". Runs on every tool call, so it stays
# plain sh with one fork. No clock file, no output: it must never block a tool.
read start budget 2>/dev/null < "$1" || exit 0
now=$(date +%s)
printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"elapsed %ss / %ss"}}\n' "$((now - start))" "$budget"
