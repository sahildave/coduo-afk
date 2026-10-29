#!/usr/bin/env node
// PreToolUse hook on Write|Edit|MultiEdit|NotebookEdit: a lane's file tools may
// write only the lane's own worktree, never the project's checkout or another
// lane (roles.mjs `guardProjectRoot`).
//
//   node project-root-guard.mjs <project root> <lanes dir> <own lane>
//
// A hook, not an `Edit(<root>/**)` deny rule: Claude Code merges Edit deny rules
// into the sandbox's `filesystem.denyWrite`, which would also refuse sandboxed
// Bash the shared `<root>/.git` a linked worktree writes its index and objects
// to. A hook decision binds the file tools only. Bash stays capped by the
// sandbox's own allowWrite, which already excludes the root except its `.git`.
//
// Order: the own lane is allowed first, so a lane placed inside the project
// (AFK_WORKTREE_ROOT) can still write itself; then anything else under the
// lanes dir is a sibling and denied; then the checkout is denied; everything
// else (/tmp, scratch) is allowed.
//
// The own lane comes from the command line, fixed when the runner renders the
// settings, and not from the event's `cwd` or this process's cwd: both follow
// the agent's `cd`, so a builder that stepped into /tmp would lose its own lane
// and one that stepped into a sibling would gain that sibling.
//
// Fail direction: input with no target path is allowed — there is nothing to
// guard. With no own lane given, every lane is denied: refusing a lane its own
// files is loud and recoverable, a write into a sibling is a silent merge
// conflict. A path that does not exist yet is judged by its nearest existing
// parent, so a new file through a symlinked directory is still caught.
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const canonical = (path) => {
  let dir = resolve(path);
  const rest = [];
  for (;;) {
    try { return resolve(realpathSync(dir), ...rest); } catch {}
    const parent = dirname(dir);
    if (parent === dir) return resolve(path);
    rest.unshift(dir.slice(parent.length).replace(/^\//, ''));
    dir = parent;
  }
};
const under = (path, dir) => path === dir || path.startsWith(dir.endsWith('/') ? dir : `${dir}/`);

const [root, lanes, lane] = process.argv.slice(2);
const deny = (reason) => process.stdout.write(`${JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
})}\n`);
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let event = {};
  try { event = JSON.parse(input); } catch {}
  const tool = event.tool_input ?? {};
  const target = tool.file_path ?? tool.notebook_path;
  if (!root || typeof target !== 'string' || !target) return;
  const path = canonical(resolve(event.cwd ?? process.cwd(), target));
  const own = lane ? canonical(lane) : null;
  if (own && under(path, own)) return;
  const fix = `A lane writes only its own worktree${own ? ` ${own}` : ''}; make this change there.`;
  const others = lanes ? canonical(lanes) : null;
  if (others && under(path, others)) return deny(`${path} is in another lane under ${others}. ${fix}`);
  const checkout = canonical(root);
  if (under(path, checkout)) deny(`${path} is inside the project's checkout ${checkout}. ${fix}`);
});
