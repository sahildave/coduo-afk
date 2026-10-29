// scripts/model-check.mjs — did a role's session stay on the model it started on?
//
// Anthropic moves a message its bio/cyber safeguards flag to an older model and
// lets the session carry on there. Nothing fails: the lane finishes, its checks
// may pass, and the only trace is the `model` field on the assistant messages in
// `stream.jsonl`. That is a change WITHIN one session, so the session is
// compared against itself: the model its `system/init` event names against the
// model on each top-level assistant turn. The configured model is not an input —
// aliases, provider ids and CLI defaults all resolve before init is written.
//
// Assumption, not yet observed: init records the model the session STARTED on
// and is never rewritten when the safeguard later moves it. As of 2026-09-23 no
// stream on the author's machine shows a switch at all (356 streams across 11
// projects: every top-level turn equals its init model, and no id carries a
// `[1m]` suffix on either side), so the switch fixture in the tests encodes this
// assumption rather than a captured stream. If a real switch ever rewrites
// init, this reads `match`; revisit then.
//
// Fail direction: this never fails a lane. The work continued legitimately on
// another model, so the finding is a fact for a human, recorded and logged, not
// a verdict. No init model or no assistant turns is "unknown" and raises
// nothing, because a herdr pane, a Codex stream and a fast-forward merge all
// legitimately carry none.
//
// Pure. Callers own reading the stream and writing the record.

// Claude Code emits `"model":"<synthetic>"` on assistant messages it makes up
// itself (an API error rendered as a turn, an interrupted request). They were
// served by no model at all, so they are evidence of nothing.
const SYNTHETIC = /^<.*>$/;

/**
 * The model a session started on, and the models that served its top-level
 * assistant turns, counted.
 *
 * Sub-agent turns (`parent_tool_use_id` set) are left out: a sub-agent runs on
 * whatever model its own definition names, so a different id there is a choice,
 * not a switch.
 *
 * @param {string} raw stream.jsonl text
 * @returns {{ started: string|null, counts: Record<string, number> }}
 */
export const observedModels = (raw) => {
  const counts = {};
  let started = null;
  for (const line of String(raw ?? '').split('\n')) {
    let event;
    // A lane killed mid-write leaves a truncated last line; skip it, never throw.
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') {
      started ??= event.model;
      continue;
    }
    if (event?.type !== 'assistant' || event.parent_tool_use_id) continue;
    const model = event.message?.model;
    if (typeof model !== 'string' || !model || SYNTHETIC.test(model)) continue;
    counts[model] = (counts[model] ?? 0) + 1;
  }
  return { started, counts };
};

/**
 * The record a role's run carries: the model it started on, what answered, and
 * whether any reply came from another model.
 *
 * `status` is:
 *   - `match`    every counted turn came from the model named at init;
 *   - `switched` at least one came from another — the alarm;
 *   - `unknown`  no init model, or no top-level assistant turns. No alarm.
 *
 * @param {string} raw stream.jsonl text
 */
export const modelCheck = (raw) => {
  const { started, counts } = observedModels(raw);
  const models = Object.keys(counts);
  let status = 'unknown';
  if (started && models.length) status = models.every((model) => model === started) ? 'match' : 'switched';
  return { started, observed: counts, status };
};

/**
 * The one log line for a switch, or null when there is nothing to say. Shared so
 * every role's alarm reads the same and is greppable as `MODEL SWITCH`.
 */
export const modelSwitchLine = (label, check) => {
  if (check?.status !== 'switched') return null;
  const later = Object.entries(check.observed)
    .filter(([model]) => model !== check.started)
    .map(([model, n]) => `${model} ×${n}`)
    .join(', ');
  return `MODEL SWITCH — ${label} started on ${check.started}, later replies came from ${later}. `
    + 'The work continued on that model and the lane was not failed; read its output with that in mind.';
};
