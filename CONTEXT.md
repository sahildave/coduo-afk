# Glossary

Terms with a precise meaning in this project. Settled during the 2026-08-18
herdr grilling session; challenge and update as the model sharpens.

- **Lane** — the composite unit of parallel work: one ticket + one sealed git
  worktree + one branch + one herdr workspace + one primary agent. A lane never
  merges itself.
- **Runtime** — the pluggable layer that executes a lane's agent. `direct` runs
  a headless subprocess; `herdr` runs an interactive agent in a herdr pane.
  The runtime executes and observes; it never schedules.
- **Task** — the schedulable node in the DAG (issue id, dependencies,
  lifecycle). A task *has* a lane while it is running.
- **Passed** — AFK's terminal success state: verified, integrated, post-merge
  checks green. Distinct from any runtime-level "done" signal, which is only
  a hint that the agent stopped working.
- **Gate** — a point where the DAG stops for a human (before or after a task).
  A runtime `blocked` state is an agent asking a question; it may surface a
  gate but is not itself one.
- **Integrator** — the fresh agent that serially merges lane branches into the
  base branch. Never the lane's own agent.
- **Adopt** — the runtime opening a UI surface (herdr workspace) onto a
  worktree that AFK created. AFK owns worktree create/remove; the runtime only
  adopts and displays.
- **Runner version** (`RUNNER_VERSION`, `scripts/lib.mjs`) — the version of the
  runner: its config semantics, report shapes, halt conditions and CLI.
  Currently 2.0.0. Distinct from the **spec version** (`SPEC_VERSION`,
  `scripts/epic-spec.mjs`) — the version of the `afk:` block an epic author types
  into an issue body, which is 1 and did not move with the runner. `afk --version`
  prints both; `CHANGELOG.md` is the breaking-change contract for consumers.
