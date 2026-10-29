// scripts/machine-views.mjs — the two machine-wide pages, AFK spending
// (usage.html) and AFK lanes (lanes.html), and the JSON they fetch. They read
// Claude Code transcripts on this machine and need no run, so the dashboard
// server and the hub serve them through this one function.
//
//   GET /usage.html, /lanes.html   the pages (`?embed=1` hides their nav links)
//   GET /usage[?all=1]             token usage and cost (scripts/usage.mjs)
//   GET /lanes[?days=N&project=]   context and tool calls per lane (scripts/lanes.mjs)
//   GET /lanes/compare             the codemap-removal routine's table
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { insightsReport, usageReport } from "./usage.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// The lanes reports read every transcript on a cold cache (~7s on 2,268 files,
// 23s on ~15k). On the request thread that read is synchronous, and every
// other request, /health included, waited behind it. So each runs in a worker
// and the request is answered when it finishes; the worker loads the disk cache
// the dashboard's warm-up writes, and writes back what it read.
const lanesModule = JSON.stringify(new URL("./lanes.mjs", import.meta.url).href);
const offThread = (fn, opt) => new Promise((done, fail) => {
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
     import(${lanesModule}).then((m) => parentPort.postMessage(m[workerData.fn](workerData.opt)));`,
    { eval: true, workerData: { fn, opt } },
  );
  worker.once("message", done);
  worker.once("error", fail);
  worker.once("exit", (code) => fail(new Error(`the ${fn} worker exited (${code}) without an answer`)));
});

const answer = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

/** Answers the request and returns true when it is one of the machine views. */
export const serveMachineView = (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const q = url.searchParams;
  const page = { "/usage.html": "usage.html", "/lanes.html": "lanes.html" }[url.pathname];
  if (page) {
    const html = readFileSync(resolve(here, page), "utf8");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(q.get("embed") === "1" ? html.replace("<body>", "<body data-embed>") : html);
    return true;
  }
  let lanes;
  if (url.pathname === "/usage") {
    // `insights` (trailing 30 days, plus last week's Claude Code share) is the
    // same whichever period is asked for.
    answer(res, 200, { ...usageReport({ month: q.get("all") !== "1" }), insights: insightsReport() });
    return true;
  } else if (url.pathname === "/lanes/compare") {
    const opt = { since: q.get("since"), baselineFrom: q.get("from"), baselineTo: q.get("to") };
    for (const k of Object.keys(opt)) if (!/^\d{4}-\d{2}-\d{2}$/.test(opt[k] ?? "")) delete opt[k];
    lanes = offThread("compareLanes", opt);
  } else if (url.pathname === "/lanes") {
    const days = Math.min(365, Math.max(1, Number(q.get("days")) || 30));
    lanes = offThread("lanesReport", { days, project: q.get("project") || null });
  } else {
    return false;
  }
  lanes.then((body) => answer(res, 200, body), (error) => answer(res, 500, { error: error.message }));
  return true;
};
