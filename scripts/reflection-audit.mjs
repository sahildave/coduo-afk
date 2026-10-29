// Phase 0 + hard-key clustering for docs/reflection. Deterministic, no LLM.
// Re-running on an unchanged corpus produces byte-identical output.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, relative } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const REFL = resolve(ROOT, "docs", "reflection");

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(resolve(dir, e.name)) : e.name.endsWith(".md") ? [resolve(dir, e.name)] : []);

const addedOn = (file) => {
  try {
    const out = execFileSync("git", ["log", "--diff-filter=A", "--format=%ad", "--date=short", "--", file],
      { cwd: ROOT, encoding: "utf8" }).trim().split("\n").filter(Boolean);
    return out[out.length - 1] ?? "";
  } catch { return ""; }
};

// --- Phase 0: extract every proposal item under the runner-changes heading ---
const SECTION = /^#{2,3}\s+.*what i would change/i;
const ITEM = /^\s*(?:[-*]\s+|\d+[.)]\s+)/;

const items = [];
const files = walk(REFL).sort();
const filesWithSection = new Set();
const sectionStyle = { bullet: 0, numbered: 0 };

for (const file of files) {
  const rel = relative(REFL, file);
  const [project, base] = [rel.split("/")[0], rel.split("/").pop()];
  const epic = (base.match(/epic-([\w.-]+?)(?:-run-\d+)?\.md$/) ?? [, base.replace(/\.md$/, "")])[1];
  const lines = readFileSync(file, "utf8").split("\n");
  let inSection = false, buf = null;
  const flush = () => { if (buf && buf.trim()) items.push({ project, epic, file: rel, text: buf.trim() }); buf = null; };
  for (const line of lines) {
    if (/^#{1,3}\s/.test(line)) {
      if (SECTION.test(line)) { inSection = true; filesWithSection.add(rel); continue; }
      if (inSection) { flush(); inSection = false; }
      continue;
    }
    if (!inSection) continue;
    if (/^\s*```/.test(line)) continue;
    if (ITEM.test(line)) {
      flush();
      sectionStyle[/^\s*\d/.test(line) ? "numbered" : "bullet"]++;
      buf = line.replace(ITEM, "");
    } else if (buf !== null && line.trim()) buf += " " + line.trim();
    else flush();
  }
  flush();
}

const dates = new Map(files.map((f) => [relative(REFL, f), addedOn(f)]));
for (const it of items) {
  it.firstSeen = dates.get(it.file) ?? "";
  it.disposition = /^untracked\b/i.test(it.text) ? "untracked"
    : /^tracked:/i.test(it.text) ? "tracked" : "none";
  it.body = it.text.replace(/^untracked\s*[—:-]\s*/i, "").replace(/^tracked:\s*\S+\s*[—-]\s*/i, "");
}

// --- Phase 1 tier 1: hard keys ---
const keysOf = (s) => {
  const k = new Set();
  const add = (v) => { if (v && v.length > 3) k.add(v.toLowerCase()); };
  for (const m of s.matchAll(/`([^`]+)`/g)) {
    for (const t of m[1].matchAll(/[A-Za-z_][\w.-]{3,}/g)) add(t[0]);
  }
  for (const m of s.matchAll(/\b[a-z][a-z0-9]*(?:[A-Z][a-zA-Z0-9]*)+\b/g)) add(m[0]);
  for (const m of s.matchAll(/--[a-z][a-z0-9-]{2,}/g)) add(m[0]);
  for (const m of s.matchAll(/\b[\w][\w.-]*\.(?:json|mjs|md|ya?ml|tsx?|jsx?|log)\b/g)) add(m[0]);
  return k;
};
for (const it of items) it.keys = keysOf(it.body);

const freq = new Map();
for (const it of items) for (const k of it.keys) freq.set(k, (freq.get(k) ?? 0) + 1);

const report = [];
const cluster = (maxDf) => {
  const parent = items.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent[x] = y; };
  const byKey = new Map();
  items.forEach((it, i) => {
    for (const k of it.keys) {
      if (freq.get(k) > maxDf) continue;
      if (freq.get(k) < 2) continue;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(i);
    }
  });
  for (const idxs of byKey.values()) for (let i = 1; i < idxs.length; i++) union(idxs[0], idxs[i]);
  const groups = new Map();
  items.forEach((_, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); });
  return [...groups.values()];
};

console.log(`files scanned           ${files.length}`);
console.log(`files with a proposals section  ${filesWithSection.size}`);
console.log(`proposal items extracted        ${items.length}   (bullet ${sectionStyle.bullet}, numbered ${sectionStyle.numbered})`);
const byDisp = items.reduce((a, i) => (a[i.disposition] = (a[i.disposition] ?? 0) + 1, a), {});
console.log(`  disposition:`, byDisp);
console.log(`  projects: ${new Set(items.map((i) => i.project)).size}`);
console.log(`  items with zero keys: ${items.filter((i) => !i.keys.size).length}`);
console.log(`\ndistinct keys ${freq.size}; keys shared by >=2 items ${[...freq.values()].filter((v) => v >= 2).length}`);
console.log(`most common keys:`, [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}:${v}`).join(" "));

console.log(`\nmaxDf  clusters  singletons  largest  2nd  3rd`);
for (const df of [3, 5, 8, 10, 15, 20, 30]) {
  const g = cluster(df).sort((a, b) => b.length - a.length);
  console.log(`${String(df).padStart(5)}  ${String(g.length).padStart(8)}  ${String(g.filter((x) => x.length === 1).length).padStart(10)}  ${String(g[0].length).padStart(7)}  ${String(g[1]?.length ?? 0).padStart(3)}  ${String(g[2]?.length ?? 0).padStart(3)}`);
}

const CHOSEN = Number(process.env.MAXDF ?? 8);
const groups = cluster(CHOSEN).sort((a, b) => b.length - a.length || a[0] - b[0]);
const rows = groups.map((g, n) => {
  const members = g.map((i) => items[i]);
  const shared = [...members.reduce((acc, m) => { for (const k of m.keys) if (freq.get(k) >= 2 && freq.get(k) <= CHOSEN) acc.set(k, (acc.get(k) ?? 0) + 1); return acc; }, new Map())]
    .filter(([, c]) => c > 1 || members.length === 1).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k);
  const seen = members.map((m) => m.firstSeen).filter(Boolean).sort();
  return { id: `C${String(n + 1).padStart(3, "0")}`, n: members.length,
    projects: [...new Set(members.map((m) => m.project))], keys: shared,
    firstSeen: seen[0] ?? "", lastSeen: seen[seen.length - 1] ?? "", members };
});
writeFileSync(resolve(ROOT, "docs", "reflection-clusters.json"), JSON.stringify({ maxDf: CHOSEN, items: items.length, clusters: rows }, null, 2));
console.log(`\nAt maxDf=${CHOSEN}: ${rows.length} clusters, ${rows.filter((r) => r.n > 1).length} multi-item, covering ${rows.filter((r) => r.n > 1).reduce((a, r) => a + r.n, 0)} items.`);
console.log(`wrote docs/reflection-clusters.json`);
console.log(`\ntop recurring clusters:`);
for (const r of rows.filter((x) => x.n > 1).slice(0, 15)) {
  console.log(`  ${r.id}  n=${String(r.n).padStart(2)}  proj=${r.projects.length}  ${r.firstSeen}..${r.lastSeen}  [${r.keys.join(", ")}]`);
  console.log(`        ${r.members[0].body.slice(0, 110)}`);
}
