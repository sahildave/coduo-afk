// scripts/prompts.test.mjs — the prompt template loader and its two guards.
//
// The failures these prevent are both silent-at-write-time and expensive at
// read-time: an override that a project never actually gets, and an override
// that strips the one instruction the output parser depends on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultPromptPath,
  findsNestedSection,
  loadPrompt,
  overridePromptPath,
  promptFor,
  render,
} from "./prompts.mjs";
import { implementerPrompt, roleFor, rolePrompt, skillsFor } from "./roles.mjs";

const TASK = { id: "204", title: "Add thing", allowedPaths: ["src/**"], checks: ["npm test"] };

const project = (files = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-prompts-"));
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, ".afk-setup", "prompts", name);
    mkdirSync(join(dir, ".afk-setup", "prompts"), { recursive: true });
    writeFileSync(path, body);
  }
  return dir;
};

test("render substitutes a placeholder and reaches through a dotted path", () => {
  assert.equal(render("{{a}} and {{b.c}}", { a: "A", b: { c: "C" } }), "A and C");
});

test("an absent value renders as nothing, not as the literal placeholder", () => {
  // A prompt that says `{{ledgerNotes}}` to an agent is worse than one that
  // says nothing: the agent tries to interpret it.
  assert.equal(render("x{{missing}}y", {}), "xy");
  assert.equal(render("x{{nothing}}y", { nothing: null }), "xy");
});

test("a section renders only when its value is present", () => {
  // The markers sit on their own lines and vanish with the section, so the
  // blank line that separates a block from its neighbour is written INSIDE the
  // body. That is the convention every shipped template follows.
  const template = "head\n{{#extra}}\n\n{{extra}}\n{{/extra}}\n\ntail";
  assert.equal(render(template, {}), "head\n\ntail");
  assert.equal(render(template, { extra: "E" }), "head\n\nE\n\ntail");
  // An empty list is absent, so a role with no skills gets no empty heading.
  assert.equal(render(template, { extra: [] }), "head\n\ntail");
});

test("sections resolve before placeholders, so a value cannot inject markup", () => {
  // A ledger note or a human's custom instruction is free-form text from
  // outside the runner. If placeholders were filled first, a note containing
  // `{{#x}}` would be read as template markup on the second pass.
  const out = render("{{note}}", { note: "{{#evil}}dropped{{/evil}}" });
  assert.equal(out, "{{#evil}}dropped{{/evil}}");
});

test("a project override wins over the shipped default", () => {
  const dir = project({ "implementer.md": "OVERRIDDEN {{task.id}}" });
  assert.equal(promptFor("implementer", dir, { task: { id: "204" } }), "OVERRIDDEN 204");
  rmSync(dir, { recursive: true, force: true });
});

test("a project with no override gets the shipped default", () => {
  const dir = project();
  assert.match(loadPrompt("implementer", dir), /You are the builder for exactly one assigned task/);
  assert.ok(defaultPromptPath("implementer").endsWith("prompts/implementer.md"));
  assert.ok(overridePromptPath("implementer", dir).endsWith(".afk-setup/prompts/implementer.md"));
  rmSync(dir, { recursive: true, force: true });
});

test("an override that drops the last-JSON-block rule is refused, by name", () => {
  // verifier.mjs and supervisor.mjs both parse the LAST fenced `json` block.
  // Without this, the override is accepted, the run proceeds, and the failure
  // arrives minutes later as an unparseable report with no cause attached.
  const dir = project({ "verifier.md": "Review the branch. Emit some JSON somewhere." });
  const requires = [{ pattern: /LAST thing in your final message/, why: "the parser needs it last" }];
  assert.throws(
    () => loadPrompt("verifier", dir, requires),
    (error) =>
      error.message.includes(".afk-setup/prompts/verifier.md")
      && error.message.includes("the parser needs it last"),
  );
  rmSync(dir, { recursive: true, force: true });
});

test("an override that drops the {{phases}} mark is refused, through the real role", () => {
  // Not a re-declared pattern: this goes through implementerPrompt, so it fails
  // if the guard is ever detached from the role that needs it. Under the
  // `direct` runtime the prompt file is the only place a lane hears its phase
  // walk — herdr's pointer prompt does not exist there.
  const dir = project({ "implementer.md": "Build {{task.id}}. No phase walk here." });
  assert.throws(
    () => implementerPrompt({ task: TASK, taskText: "SPEC", projectRoot: dir }),
    (error) =>
      error.message.includes(".afk-setup/prompts/implementer.md")
      && error.message.includes("phase walk"),
  );
  rmSync(dir, { recursive: true, force: true });
});

test("an override that keeps the mark is accepted", () => {
  // The guard is on the mark, not on the sentence: a project may reword the
  // prose around it however it likes.
  const dir = project({ "implementer.md": "Build {{task.id}}. Phases: {{phases}}." });
  assert.match(
    implementerPrompt({ task: TASK, taskText: "SPEC", projectRoot: dir }),
    /Phases: Resolve → Context → Plan → Implement → Test → Self-check → Report\./,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("every shipped default satisfies the guard its role applies", () => {
  // The guard is only worth having if the default it defends passes it.
  const requires = [{ pattern: /LAST thing in your final message/, why: "the parser needs it last" }];
  for (const role of ["verifier", "supervisor"]) {
    assert.ok(loadPrompt(role, null, requires), role);
  }
  const phases = [{ pattern: /\{\{phases\}\}/, why: "the phase walk is rendered here" }];
  for (const role of ["implementer", "integrator", "verifier"]) {
    assert.ok(loadPrompt(role, null, phases), role);
  }
});

// ---------------------------------------------------------------------------
// The skills join: .afk-setup/config.yaml `roles:` → the prompt's {{skills}}
// ---------------------------------------------------------------------------

test("a role with no configured skills gets no skills paragraph at all", () => {
  // Not an empty heading: a prompt that says "these skills are installed:"
  // and then nothing reads as a bug to the agent.
  assert.equal(skillsFor({}, "implementer"), null);
  assert.equal(skillsFor({ roles: { implementer: { always: [], offer: [] } } }, "implementer"), null);
  const prompt = implementerPrompt({ task: TASK, taskText: "SPEC" });
  assert.doesNotMatch(prompt, /Apply these skills/);
  assert.doesNotMatch(prompt, /installed for this project/);
});

test("`always` is stated as a rule and `offer` as a choice, and they differ", () => {
  // The whole point of two lists: `implement` is not optional, a design skill
  // on a backend ticket is. One list would force one register for both.
  const text = skillsFor(
    { roles: { implementer: { always: ["implement"], offer: ["shadcn"] } } },
    "implementer",
  );
  assert.match(text, /Apply these skills to every task, before you start: implement\./);
  assert.match(text, /only when it is relevant to your task: shadcn/);
});

test("the configured skills reach the prompt the builder actually reads", () => {
  const config = { roles: { implementer: { offer: ["shadcn", "emil-design-eng"] } } };
  const prompt = rolePrompt(roleFor("implementer"), config, { task: TASK, taskText: "SPEC" });
  assert.match(prompt, /shadcn, emil-design-eng/);
  // Still after the builder rules, and still before the sentence that says
  // those rules win. That order is what keeps injected context inert.
  assert.ok(prompt.indexOf("Builder rules:") < prompt.indexOf("shadcn"));
  assert.ok(prompt.indexOf("shadcn") < prompt.indexOf("These builder rules override"));
});

test("config cannot grant a skill the role denies, and the error names the file", () => {
  // `herdr` lets an agent start sibling agents in other panes, which breaks
  // one-ticket-one-agent. The deny rule is rendered into the agent's own
  // settings, so a grant here would only ever produce a skill that fails to
  // load — silently, mid-run.
  assert.throws(
    () => skillsFor({ roles: { implementer: { offer: ["herdr"] } } }, "implementer"),
    (error) =>
      error.message.includes(".afk-setup/config.yaml")
      && error.message.includes("roles.implementer.offer")
      && error.message.includes("herdr"),
  );
  // The supervisor is the one role that keeps it, so the same config is legal there.
  assert.match(skillsFor({ roles: { supervisor: { offer: ["herdr"] } } }, "supervisor"), /herdr/);
});

test("a role name the runner does not have is refused, not ignored", () => {
  // A typo in a hand-edited config would otherwise mean "no skills", silently.
  assert.throws(() => skillsFor({ roles: { implementor: {} } }, "implementor"), /Unknown role/);
});

test("a nested section is refused at load time, not leaked into the prompt", () => {
  // The renderer is single-pass, so the inner markup would survive into the
  // text an agent reads. Silent, and it looks like a prompt-authoring bug.
  const dir = project({ "implementer.md": "{{#a}}A{{#b}}B{{/b}}{{/a}}" });
  assert.throws(
    () => loadPrompt("implementer", dir),
    (error) => error.message.includes("nests {{#b}} inside {{#a}}"),
  );
  rmSync(dir, { recursive: true, force: true });
});

test("no shipped template nests a section", () => {
  for (const role of ["implementer", "integrator", "plan-reviewer", "verifier", "supervisor"]) {
    assert.equal(findsNestedSection(readFileSync(defaultPromptPath(role), "utf8")), null, role);
  }
});

test("zero is a value, an empty list is not", () => {
  // `isBlank`, not truthiness. A role with no skills must get no heading; a
  // legitimate 0 must still print.
  assert.equal(render("{{#n}}n={{n}}{{/n}}", { n: 0 }), "n=0");
  assert.equal(render("{{#n}}n={{n}}{{/n}}", { n: [] }), "");
});

// ---------------------------------------------------------------------------
// Lessons: a repeat finding is a rule's gap, an edit to a rule is a loosening
// ---------------------------------------------------------------------------

const rendered = (role, values = {}) => rolePrompt(roleFor(role), {}, values);

test("the verifier's standards pass finds the lessons home and reports a loosening", () => {
  // A lesson rule that a later diff quietly weakens stops catching the thing it
  // was written for, and every gate stays green. The verifier is the only
  // reader that sees the diff, so the rule has to be in its prompt.
  const prompt = rendered("verifier");
  assert.match(prompt, /lessons home/);
  assert.match(prompt, /sgconfig\.yml/);
  assert.match(prompt, /custom_rules/);
  assert.match(prompt, /possible loosening/);
  assert.match(prompt, /suppression/);
  assert.match(prompt, /suppression with no stated reason is `major` on its own/);
});

test("the verifier skips what a lesson enforces, yet reports a repeat as that rule's gap", () => {
  // Two halves of one instruction: without the first the review re-litigates
  // what the linter already holds; without the second a repeat is dropped as
  // "the lint covers it" when the lint demonstrably did not.
  const prompt = rendered("verifier");
  assert.match(prompt, /Skip whatever an existing lesson already enforces/);
  assert.match(prompt, /should have caught[^.]*`axis: "standards"`[^.]*names the lesson/);
});

test("the verifier's lesson findings reuse the standards axis, not a new one", () => {
  // verifier.mjs validates `axis` against the three values the rules list; a
  // fourth would be discarded by the parser.
  const prompt = rendered("verifier");
  assert.match(prompt, /`findings\[\]\.axis` is "standards" or "spec"[^.]*or "reach"/);
  assert.doesNotMatch(prompt, /axis: "lesson/);
});

test("the reflector lists findings with a code shape that got no rule lesson", () => {
  const prompt = rendered("reflector");
  const learnings = prompt.slice(prompt.indexOf("## Reusable learnings"));
  assert.match(learnings, /code shape and got no `rule`\s+lesson/);
  assert.match(learnings, /`lesson` fields? in `fixes\.json`/);
  assert.match(learnings, /`missing`/);
});
