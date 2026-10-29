// scripts/forecast.mjs — the stop forecast (epic #190, #191).
//
// Every place a run will wait for a human, what waits behind it, and the answer
// the epic recorded for it. `afk validate` and `afk epic` print it; the launch
// row in docs/measure carries it (scripts/measure.mjs).
//
// Pure: no model, no network, no file. Input is the parsed `afk:` spec (or a
// DAG, which the measurement module holds) and the project's AFK config.
//
// The gate computation — which tasks are gated, and which tasks wait behind
// each — lives here and only here. scripts/measure.mjs imports it for the
// launch row's `humanGates`, so the forecast and the row cannot disagree about
// what a gate blocks.
//
// An answer changes no scheduling. `park` and `delegate` both still park; this
// module records what the human decided, it never releases a gate.

export const LAUNCH_STATUSES = ["pre-launch", "launched"];
export const STOP_ANSWERS = ["park", "last", "delegate: <condition>"];
export const MIN_DELEGATE_CONDITION = 10;

/** `before`, `after` or null. Reads a DAG task (`humanGated`/`gateAfter`) or a spec task (`gate`). */
export const gateOf = (task) =>
  task?.gate ?? (task?.humanGated ? "before" : task?.gateAfter ? "after" : null);

// One task list for both inputs: the spec's `tasks:` mapping (`depends_on`,
// `gate`) and a DAG's `tasks` array (`dependsOn`, `humanGated`/`gateAfter`).
const tasksOf = (source) =>
  Array.isArray(source?.tasks)
    ? source.tasks.map((task) => ({
        id: String(task.id),
        dependsOn: (task.dependsOn ?? []).map(String),
        gate: gateOf(task),
      }))
    : Object.entries(source?.tasks ?? {}).map(([id, task]) => ({
        id: String(id),
        dependsOn: (Array.isArray(task?.depends_on) ? task.depends_on : []).map(String),
        gate: gateOf(task),
      }));

/** Every task that depends, directly or not, on `id`. */
export const dependentsOf = (tasks, id) => {
  const found = new Set();
  const visit = (parent) => {
    for (const task of tasks) {
      if ((task.dependsOn ?? []).map(String).includes(String(parent)) && !found.has(task.id)) {
        found.add(task.id);
        visit(task.id);
      }
    }
  };
  visit(id);
  return [...found];
};

/**
 * The declared gates and what each one blocks. `gate: before` holds the task
 * itself and everything behind it; `gate: after` lets the task run and holds
 * what depends on it, and the close.
 * @param {{tasks: object[]|object}} source a DAG or a parsed `afk:` spec
 * @returns {{taskId: string, gate: "before"|"after", blocked: string[]}[]}
 */
export const declaredGates = (source) => {
  const tasks = tasksOf(source);
  return tasks.filter((task) => task.gate).map((task) => ({
    taskId: task.id,
    gate: task.gate,
    blocked: [...(task.gate === "before" ? [task.id] : []), ...dependentsOf(tasks, task.id)],
  }));
};

/**
 * One `stops:` value, parsed. Null for anything that is not a valid answer;
 * `validateStops` says why.
 * @returns {{kind: "park"}|{kind: "last"}|{kind: "delegate", condition: string}|null}
 */
export const parseStopAnswer = (value) => {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "park" || text === "last") return { kind: text };
  const delegate = text.match(/^delegate:\s*(.*)$/s);
  if (delegate && delegate[1].trim().length >= MIN_DELEGATE_CONDITION) {
    return { kind: "delegate", condition: delegate[1].trim() };
  }
  return null;
};

/**
 * The project's launch status, read off the loaded config object. A missing
 * key is treated as `launched`, and says so: the safe reading of an unknown
 * audience is that there is one.
 * @returns {{value: string, declared: boolean}}
 */
export const launchStatusOf = (config) => {
  const value = config?.launchStatus;
  return value === undefined || value === null
    ? { value: "launched", declared: false }
    : { value: String(value), declared: true };
};

/**
 * The `stops:` rules that need the graph. Errors refuse the epic; the one
 * warning does not, because the plan reviewer may raise a stop later.
 * @returns {{errors: object[], warnings: object[]}} entries shaped like validateEpicSpec's
 */
export const validateStops = (spec) => {
  const errors = [];
  const warnings = [];
  if (!Object.hasOwn(spec ?? {}, "stops")) return { errors, warnings };
  const stops = spec.stops;
  if (!stops || typeof stops !== "object" || Array.isArray(stops)) {
    errors.push({ code: "stops", taskId: null, message: "`stops` must be a mapping of task id to answer (park, last, delegate: <condition>)" });
    return { errors, warnings };
  }
  const tasks = tasksOf(spec);
  const ids = new Set(tasks.map((task) => task.id));
  const gates = new Map(declaredGates(spec).map((gate) => [gate.taskId, gate]));
  for (const [id, value] of Object.entries(stops)) {
    if (!ids.has(id)) {
      errors.push({ code: "stops", taskId: id, message: `stops: \`${id}\` is not a task in this block` });
      continue;
    }
    const delegate = typeof value === "string" ? value.trim().match(/^delegate:\s*(.*)$/s) : null;
    if (delegate && delegate[1].trim().length < MIN_DELEGATE_CONDITION) {
      errors.push({
        code: "stops",
        taskId: id,
        message: `stops: task \`${id}\`: the delegate condition ${JSON.stringify(delegate[1].trim())} is shorter than ${MIN_DELEGATE_CONDITION} characters — say what the delegate checks`,
      });
      continue;
    }
    const answer = parseStopAnswer(value);
    if (!answer) {
      errors.push({
        code: "stops",
        taskId: id,
        message: `stops: task \`${id}\`: ${JSON.stringify(value)} is not an answer (allowed: ${STOP_ANSWERS.join(", ")})`,
      });
      continue;
    }
    const gate = gates.get(id);
    if (!gate) {
      warnings.push({
        code: "stop_without_gate",
        taskId: id,
        message: `stops: task \`${id}\` has an answer but no declared gate — it is recorded in case the plan reviewer raises a stop there`,
      });
      continue;
    }
    if (answer.kind === "last") {
      const ungated = gate.blocked.filter((blocked) => !gates.has(blocked));
      if (ungated.length) {
        errors.push({
          code: "stops",
          taskId: id,
          message: `stops: task \`${id}\`: \`last\` cannot hold — ${ungated.map((task) => `#${task}`).join(", ")} ${ungated.length === 1 ? "has" : "have"} no stop of ${ungated.length === 1 ? "its" : "their"} own and still wait${ungated.length === 1 ? "s" : ""} behind it`,
        });
      }
    }
  }
  return { errors, warnings };
};

const NOTE = {
  gate_before: (id) => `needs two launches: --task=${id}, then a plain relaunch`,
  gate_after: (id) => `the epic cannot close until #${id} is accepted`,
  needs_human: (id, evidence) => `needs a human: "${evidence}"`,
};

/**
 * The stop forecast.
 * @param {{spec: object, config: object|null}} input `spec` is the parsed
 *   `afk:` block or a DAG; answers come from its `stops:` key when it has one
 */
export const buildForecast = ({ spec, config = null }) => {
  const total = tasksOf(spec).length;
  const answers = spec?.stops && typeof spec.stops === "object" ? spec.stops : {};
  const stops = declaredGates(spec).map((gate) => {
    const kind = gate.gate === "before" ? "gate_before" : "gate_after";
    return {
      task: gate.taskId,
      kind,
      blocks: gate.blocked,
      share: total ? gate.blocked.length / total : 0,
      note: NOTE[kind](gate.taskId),
      answer: Object.hasOwn(answers, gate.taskId) ? parseStopAnswer(answers[gate.taskId]) : null,
    };
  });
  const parked = new Set(stops.flatMap((stop) => stop.blocks)).size;
  return {
    launchStatus: launchStatusOf(config),
    stops,
    parked: { tasks: parked, total, share: total ? parked / total : 0 },
    unanswered: stops.filter((stop) => !stop.answer).length,
  };
};

/**
 * The forecast with the plan reviewer's `needs_human` findings added as stops.
 * Each holds its task and every transitive dependant, and takes its answer from
 * `stops:` like a gate. One stop per task: `stops:` answers per task.
 * @param {object} forecast from `buildForecast`
 * @param {{spec: object, findings: object[]}} input the kept review findings
 */
export const withReviewStops = (forecast, { spec, findings = [] }) => {
  const tasks = tasksOf(spec);
  const answers = spec?.stops && typeof spec.stops === "object" ? spec.stops : {};
  const total = forecast.parked.total;
  const taken = new Set(forecast.stops.map((stop) => stop.task));
  const added = [];
  for (const finding of findings) {
    const task = String(finding.tasks?.[0] ?? "");
    if (finding.kind !== "needs_human" || !task || taken.has(task)) continue;
    taken.add(task);
    const blocks = [task, ...dependentsOf(tasks, task)];
    added.push({
      task,
      kind: "needs_human",
      blocks,
      share: total ? blocks.length / total : 0,
      note: NOTE.needs_human(task, finding.evidence),
      answer: Object.hasOwn(answers, task) ? parseStopAnswer(answers[task]) : null,
    });
  }
  // `validateStops` checks `last` against declared gates only; it runs before
  // the review raises these. The same rule, here: `last` cannot hold while a
  // task with no stop of its own waits behind it. Fails closed: the stop is
  // left unanswered, so `--unattended` refuses.
  for (const stop of added) {
    if (stop.answer?.kind !== "last") continue;
    const ungated = stop.blocks.filter((id) => !taken.has(id));
    if (!ungated.length) continue;
    stop.answer = null;
    stop.note += `; \`last\` refused: ${ungated.map((id) => `#${id}`).join(", ")} wait${ungated.length === 1 ? "s" : ""} behind it with no stop of ${ungated.length === 1 ? "its" : "their"} own`;
  }
  const stops = [...forecast.stops, ...added];
  const parked = new Set(stops.flatMap((stop) => stop.blocks)).size;
  return {
    ...forecast,
    stops,
    parked: { tasks: parked, total, share: total ? parked / total : 0 },
    unanswered: stops.filter((stop) => !stop.answer).length,
  };
};

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

const renderAnswer = (answer) => {
  if (!answer) return "none";
  if (answer.kind === "delegate") {
    return `delegate: ${answer.condition} (delegated, parks until delegated acceptance ships)`;
  }
  return answer.kind;
};

// `needs_human` is raised by the plan reviewer (scripts/plan-review.mjs), not
// declared: a child issue asks for a human decision, approval or secret mid-run.
const STOP_LABEL = { gate_before: "gate: before", gate_after: "gate: after", needs_human: "needs_human" };

/** One forecast line. */
export const renderStop = (stop, total) => {
  const parks = stop.blocks.length
    ? ` Parks ${stop.blocks.length} of ${total} tasks (${stop.blocks.map((id) => `#${id}`).join(", ")}).`
    : "";
  return `  #${stop.task} ${STOP_LABEL[stop.kind]}.${parks} ${capitalise(stop.note)}. Answer: ${renderAnswer(stop.answer)}.`;
};

/** The forecast's totals line. */
export const renderParked = (forecast) => {
  const { parked } = forecast;
  return `  ${parked.tasks} of ${parked.total} tasks (${Math.round(parked.share * 100)}%) cannot start until a human acts. ${
    forecast.unanswered ? `${plural(forecast.unanswered, "stop")} unanswered.` : "Every stop is answered."
  }`;
};

/**
 * The validate report's "Stop forecast" section, ending with the UNATTENDED
 * line unless `unattended` is set — then the caller prints the verdict itself.
 * @returns {string[]}
 */
export const renderForecast = (forecast, { epicId, unattended = false } = {}) => {
  const lines = [];
  const { launchStatus, stops, parked } = forecast;
  if (!stops.length) {
    lines.push("Stop forecast: no declared stop.");
  } else {
    const status = launchStatus.declared ? launchStatus.value : "not declared, treated as launched";
    lines.push(`Stop forecast (launch status: ${status}):`);
    for (const stop of stops) lines.push(renderStop(stop, parked.total));
    lines.push(renderParked(forecast));
    lines.push("  Answer each stop in the afk: block's stops: key (park, last, delegate: <condition>). Deciding now is a plan edit: drop the gate or write the decision into the ticket, and the stop leaves the forecast.");
  }
  if (!unattended) {
    lines.push(`UNATTENDED: not checked. Run \`afk validate ${epicId} --unattended\` before saying nobody will be needed.`);
  }
  return lines;
};

/**
 * The `--unattended` decision. Ready only when the deterministic tier passed,
 * the plan review passed and every stop has an answer.
 *
 * Fails closed: anything it cannot confirm (no report, no review, an unanswered
 * stop, an expired Infisical session) refuses. A false "ready" leaves a run waiting on a human nobody warned.
 * @returns {{ok: boolean, line: string, reason: string|null}}
 */
export const unattendedVerdict = ({ report, review, nothing = "Nothing was created.", infisical = null }) => {
  const refuse = (reason) => ({ ok: false, reason, line: `UNATTENDED: refused: ${reason}. ${nothing}` });
  if (!report?.ok || !report.forecast) return refuse("validation failed");
  // (#210) The Infisical login line from `infisicalBlocker`, beside the agent
  // login the plan review just exercised: a run nobody watches must not reach
  // a gate whose `infisical run` has no session.
  if (infisical) return refuse(infisical.replace(/\.$/, ""));
  if (!review) return refuse("the plan review did not run");
  if (!review.ok) return refuse(`the plan review refused (${String(review.message ?? "").replace(/\.$/, "")})`);
  const open = report.forecast.stops.filter((stop) => !stop.answer);
  if (open.length) {
    return refuse(`${plural(open.length, "stop")} unanswered (${open.map((stop) => `#${stop.task}`).join(", ")})`);
  }
  const count = report.forecast.stops.length;
  return { ok: true, reason: null, line: `UNATTENDED: ready. ${plural(count, "stop")}, all answered.` };
};
