#!/usr/bin/env node
// AFK Codex — the same runner, resolved against the Codex backend.
//
// There is no dispatcher here on purpose. `main` in afk.mjs owns the command
// table, the accepted-flag table and the manual, and this file's whole job is
// to say which backend the operator picked by choosing this executable over
// `afk`. Copying the dispatcher would produce two of them, and the second one
// silently stops gaining commands the day it is copied.
import { isMainModule } from "./scripts/lib.mjs";
import { main } from "./afk.mjs";

if (isMainModule(import.meta.url)) await main(process.argv.slice(2), { backend: "codex" });
