// scripts/hub/server.mjs — the hub's HTTP surface (#229). Plain `node:http`,
// bound to 127.0.0.1 only.
//
//   GET  /            the page (scripts/hub/page.mjs)
//   GET  /favicon.ico the coduo.co icon (icon.png, served as image/png)
//   GET  /runs.json   the run list the page is drawn from
//   GET  /usage.html, /lanes.html, /usage, /lanes, /lanes/compare
//                     the AFK spending and AFK lanes views (scripts/machine-views.mjs)
//   GET  /targets     [{name, state}], state `warm Nm | cold Nm | no session`
//   POST /comment     {target, anchor: {run, field}, quote?, text}
//   POST /respond     {target, verdict, markdown}
//
// Any page in the browser can POST to localhost, so every POST must carry the
// token this process put in its page (`x-afk-hub-token`), an `Origin`, when
// sent, that is this hub, and a `Host` that is this hub (a DNS-rebound name
// is refused). The Host check runs on every request, GETs included, so a
// DNS-rebound page cannot read the page or its token (#236 H2). The token is
// new on every start: a page left open across a restart is told to reload.
// GETs send no CORS header, so another origin can trigger them but never read
// them.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { serveMachineView } from "../machine-views.mjs";
import { hubView, renderPage } from "./page.mjs";
import { listRuns } from "./runs.mjs";
import { resolveStranded } from "./inbox.mjs";
import { send } from "./send.mjs";
import { listTargets } from "./targets.mjs";

const MAX_BODY = 256 * 1024;
const MAX_TEXT = 64 * 1024;
const NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on("end", () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("body is not JSON")); }
  });
  req.on("error", reject);
});

const hostsOf = (port) => [`127.0.0.1:${port}`, `localhost:${port}`];

/** Why any request is refused for its Host, or null. */
export const hostRefusal = (req, { port }) =>
  (hostsOf(port).includes(req.headers.host) ? null : `host ${req.headers.host ?? "(none)"} is not this hub`);

/** Why a POST is refused, or null. */
export const refusal = (req, { token, port }) => {
  const hosts = hostsOf(port);
  const origin = req.headers.origin;
  if (origin != null && !hosts.map((host) => `http://${host}`).includes(origin)) return `origin ${origin} is not this hub`;
  if (req.headers["x-afk-hub-token"] !== token) return "missing or wrong x-afk-hub-token";
  return null;
};

/** The fields to store for a POST body, or a string saying why it is refused. */
const parseSend = (path, body) => {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  if (typeof body.target !== "string" || !NAME.test(body.target)) return "target must be a session name";
  if (path === "/comment") {
    const { anchor } = body;
    if (!anchor || typeof anchor.field !== "string" || !anchor.field || (anchor.run != null && typeof anchor.run !== "string")) return "anchor must be {run, field}";
    if (typeof body.text !== "string" || !body.text.trim() || body.text.length > MAX_TEXT) return "text must be non-empty";
    return {
      target: body.target,
      via: "comment",
      anchor: { run: anchor.run ?? null, field: anchor.field },
      quote: typeof body.quote === "string" ? body.quote.slice(0, 400) : "",
      text: body.text.trim(),
    };
  }
  if (body.verdict != null && !["Approve", "Request changes", "Comment"].includes(body.verdict)) return "verdict must be Approve, Request changes, Comment or null";
  if (typeof body.markdown !== "string" || !body.markdown.trim() || body.markdown.length > MAX_TEXT) return "markdown must be non-empty";
  return { target: body.target, via: "respond", verdict: body.verdict ?? null, text: body.markdown };
};

export const startHub = ({ port, env = process.env }) => {
  const token = randomUUID();
  const server = createServer(async (req, res) => {
    try {
      const misdirected = hostRefusal(req, { port });
      if (misdirected) { json(res, 421, { error: misdirected }); return; }
      const path = new URL(req.url, "http://127.0.0.1").pathname;
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(renderPage(await hubView(env), { token }));
      } else if (req.method === "GET" && path === "/favicon.ico") {
        // icon.png is coduo-website app/icon.ico: a PNG despite that name.
        res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=86400" });
        res.end(readFileSync(new URL("./icon.png", import.meta.url)));
      } else if (req.method === "GET" && path === "/runs.json") {
        json(res, 200, await listRuns(env));
      } else if (req.method === "GET" && serveMachineView(req, res)) {
        // /usage.html, /lanes.html and their JSON: the AFK spending and AFK
        // lanes tabs, served from the modules the dashboard uses.
      } else if (req.method === "GET" && path === "/targets") {
        json(res, 200, (await listTargets(env)).map(({ name, state }) => ({ name, state })));
      } else if (req.method === "POST" && (path === "/comment" || path === "/respond")) {
        const why = refusal(req, { token, port });
        if (why) { json(res, 403, { error: why }); return; }
        let body;
        try { body = await readBody(req); } catch (error) { json(res, 400, { error: error.message }); return; }
        const fields = parseSend(path, body);
        if (typeof fields === "string") { json(res, 400, { error: fields }); return; }
        json(res, 200, await send(fields, env));
      } else {
        json(res, 404, { error: "not found" });
      }
    } catch (error) {
      json(res, 500, { error: error.message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Only after the port is ours: a second `afk hub` that fails to bind must
    // not queue the running hub's in-flight items.
    server.listen(port, "127.0.0.1", () => { resolveStranded(env); resolve({ server, token }); });
  });
};
