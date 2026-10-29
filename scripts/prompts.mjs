/**
 * Role prompts as files (docs/epic-schema.md "Roles").
 *
 * A prompt used to be a JavaScript template literal inside `roles.mjs`, which
 * made every project share one wording and made a one-sentence change an
 * exercise in escaping `\n`. A prompt is now a Markdown file:
 *
 *   <runner>/prompts/<role>.md              the default, shipped here
 *   <project>/.afk-setup/prompts/<role>.md  the project's override, optional
 *
 * The override wins whole; there is no merge. A project that wants one changed
 * sentence copies the default and edits it, which is the only rule a human can
 * hold in their head — a per-section merge would mean reasoning about a
 * three-way diff to answer "what did the agent actually read".
 *
 * `.afk-setup/` is committed and `.afk/` is gitignored machine state. That line
 * is why the override lives where it does: a prompt has to reach a fresh clone.
 *
 * ## The template language, and why it is this small
 *
 *   {{name}}            the value, or "" when absent
 *   {{#name}}...{{/name}}   the body, only when `name` is present
 *
 * "Present" is `isBlank` below, not JS truthiness: `0` is present, `[]` is not.
 * An empty list has to read as absent or a role with no configured skills gets
 * a heading with nothing under it.
 *
 * Sections DO NOT NEST. One `{{#a}}` may not contain another, and `loadPrompt`
 * refuses a template that tries — the single-pass replace would otherwise leave
 * the inner markup in the text an agent reads, silently. No prompt has ever
 * wanted a nested section; the check is here so a future one fails loudly.
 *
 * There are no loops, no filters and no expressions. Every list the prompts
 * need — acceptance criteria, task tables, ledger notes — is already formatted
 * by the code that knows its shape, and arrives as one string. A template
 * language is a thing you debug at 2am; this one has two features and no
 * evaluation order to be wrong about.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root, runnerRoot } from "./lib.mjs";

export const defaultPromptPath = (role) => join(runnerRoot, "prompts", `${role}.md`);
export const overridePromptPath = (role, projectRoot) =>
  join(projectRoot, ".afk-setup", "prompts", `${role}.md`);

/**
 * Sections must be resolved before bare placeholders. A section body may hold
 * `{{name}}` marks of its own, and a bare pass first would fill them inside a
 * section that then gets dropped — wasted, but also wrong the other way round:
 * a value containing `{{#x}}` would be read as markup on the second pass.
 */
const SECTION = /\{\{#([\w.]+)\}\}\n?([\s\S]*?)\{\{\/\1\}\}\n?/g;
const PLACEHOLDER = /\{\{([\w.]+)\}\}/g;

const lookup = (values, path) =>
  path.split(".").reduce((node, key) => (node == null ? node : node[key]), values);

const isBlank = (value) =>
  value === null || value === undefined || value === false || value === ""
  || (Array.isArray(value) && value.length === 0);

export const render = (template, values = {}) =>
  String(template)
    .replace(SECTION, (_, name, body) => (isBlank(lookup(values, name)) ? "" : body))
    .replace(PLACEHOLDER, (_, name) => {
      const value = lookup(values, name);
      return isBlank(value) ? "" : String(value);
    });

/**
 * Load a role's template: the project's override if it has one, else the
 * shipped default.
 *
 * `requires` is the role's own list of patterns the template must still match
 * after an override replaces it. It is not style policing. Two roles are parsed
 * by taking the LAST fenced `json` block of their output; an override that
 * drops that instruction produces an agent whose report cannot be read, and the
 * failure surfaces minutes later as "no block" with no hint at the cause. This
 * turns that into one error at load time, naming the file.
 */
// One `{{#a}}` inside another. Found by walking the open/close marks in order:
// a second open before the first closes is a nest.
export const findsNestedSection = (template) => {
  const marks = [...String(template).matchAll(/\{\{([#/])([\w.]+)\}\}/g)];
  let open = null;
  for (const [, kind, name] of marks) {
    if (kind === "#") {
      if (open) return { outer: open, inner: name };
      open = name;
    } else if (open === name) {
      open = null;
    }
  }
  return null;
};

export const loadPrompt = (role, projectRoot = root, requires = []) => {
  // The runner is invoked from the project root, so `root` is the project even
  // though the agent it is building a prompt for will run somewhere else.
  const override = overridePromptPath(role, projectRoot || root);
  const path = existsSync(override) ? override : defaultPromptPath(role);
  const template = readFileSync(path, "utf8");
  const nested = findsNestedSection(template);
  if (nested) {
    throw new Error(
      `${path} nests {{#${nested.inner}}} inside {{#${nested.outer}}}, which this renderer does not support.\n`
      + "  The inner markup would reach the agent as literal text. Flatten them into two sections.",
    );
  }
  for (const { pattern, why } of requires) {
    if (!pattern.test(template)) {
      throw new Error(
        `${path} is missing something the runner depends on: ${why}\n`
        + `  expected to match: ${pattern}\n`
        + `  Copy ${defaultPromptPath(role)} and re-apply your edit.`,
      );
    }
  }
  return template;
};

export const promptFor = (role, projectRoot, values, requires) =>
  render(loadPrompt(role, projectRoot, requires), values);
