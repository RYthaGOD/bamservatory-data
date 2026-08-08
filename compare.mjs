// Cross-vantage agreement check.
//
// Two collectors in different regions record the same public API independently.
// This diffs their records so that "the API said X" can be distinguished from
// "the API said X *to us*" — the difference between a faithful recording and a
// corroborated one.
//
//   node compare.mjs --day 2026-08-09
//   node compare.mjs --day 2026-08-09 --b vantage/sin
//   node compare.mjs --all
//
// Needs no credentials and no cooperation from the operator. Run it on a clone.
//
// What is compared, and what deliberately is not:
//
//   node set          exact match expected — nodes join and leave rarely, so a
//                     disagreement is meaningful rather than noise
//   node count        exact
//   validator count   within tolerance; validators connect and disconnect
//                     continuously and the two vantages never sample the same
//                     instant
//   BAM stake         within tolerance, for the same reason — stake moves every
//                     slot, so demanding equality would report drift as
//                     divergence and make the check useless
//
// The vantages are compared minute by minute. They tick on independent clocks,
// so a minute is the smallest bucket in which both can be expected to have a
// sample at all.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);

const ROOT = arg("--root", ".");
const A_REL = arg("--a", "raw");
const B_REL = arg("--b", null);
const STAKE_TOL = Number(arg("--stake-tolerance", "0.5"));   // percent
const VAL_TOL = Number(arg("--validator-tolerance", "3"));   // absolute count

// Discover witnesses if none named.
const vantageDir = path.join(ROOT, "vantage");
let bList = [];
if (B_REL) bList = [B_REL];
else if (fs.existsSync(vantageDir)) {
  bList = fs.readdirSync(vantageDir)
    .filter((d) => fs.existsSync(path.join(vantageDir, d, "raw")))
    .map((d) => `vantage/${d}/raw`);
}

if (bList.length === 0) {
  console.log("No witness vantage found. Nothing to cross-check.");
  console.log("A single collector cannot corroborate itself — this check is only");
  console.log("meaningful once a second vantage is publishing.");
  process.exit(0);
}

const dayPath = (rel, day) => {
  const [y, m, d] = day.split("-");
  return path.join(ROOT, rel, y, m, `${d}.jsonl.zst`);
};

const daysIn = (rel) => {
  const base = path.join(ROOT, rel);
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const y of fs.readdirSync(base))
    for (const m of fs.readdirSync(path.join(base, y)))
      for (const f of fs.readdirSync(path.join(base, y, m)))
        if (f.endsWith(".jsonl.zst")) out.push(`${y}-${m}-${f.slice(0, 2)}`);
  return out.sort();
};

// Reduce a day's raw records to one comparable fact per minute. Where a vantage
// captured twice in a minute the first is kept, so both sides use the same rule.
const loadDay = (rel, day) => {
  const p = dayPath(rel, day);
  if (!fs.existsSync(p)) return null;
  let text;
  try {
    text = zlib.zstdDecompressSync(fs.readFileSync(p)).toString("utf8");
  } catch (e) {
    // Report and carry on rather than aborting the run. A file that will not
    // decompress is itself a finding — verify.sh will name it precisely — and
    // stopping here would hide agreement or divergence on every other day.
    console.error(`  ! ${rel} ${day}: cannot decompress (${e.code || e.message}). Run ./verify.sh.`);
    return null;
  }
  const byMinute = new Map();
  for (const line of text.split("\n")) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const minute = r.ts.slice(0, 16);
    if (byMinute.has(minute)) continue;
    byMinute.set(minute, {
      ts: r.ts,
      stake: r.stake?.bam_stake ?? 0,
      nodes: (r.nodes ?? []).map((n) => n.bam_node).sort(),
      validators: (r.validators ?? []).length,
    });
  }
  return byMinute;
};

const compareDay = (day, aRel, bRel) => {
  const A = loadDay(aRel, day), B = loadDay(bRel, day);
  if (!A || !B) return null;

  const shared = [...A.keys()].filter((k) => B.has(k)).sort();
  const res = { day, aOnly: A.size - shared.length, bOnly: B.size - shared.length,
                compared: shared.length, agree: 0, issues: [] };

  for (const min of shared) {
    const a = A.get(min), b = B.get(min);
    const problems = [];

    if (a.nodes.join(",") !== b.nodes.join(",")) {
      const missA = b.nodes.filter((n) => !a.nodes.includes(n));
      const missB = a.nodes.filter((n) => !b.nodes.includes(n));
      problems.push(`node set differs${missA.length ? ` (+${missA.join("|")} in B)` : ""}${missB.length ? ` (+${missB.join("|")} in A)` : ""}`);
    }
    if (Math.abs(a.validators - b.validators) > VAL_TOL)
      problems.push(`validators ${a.validators} vs ${b.validators}`);

    const denom = Math.max(a.stake, b.stake) || 1;
    const drift = (Math.abs(a.stake - b.stake) / denom) * 100;
    if (drift > STAKE_TOL)
      problems.push(`stake drift ${drift.toFixed(2)}% (${a.stake} vs ${b.stake})`);

    if (problems.length === 0) res.agree++;
    else if (res.issues.length < 10) res.issues.push({ min, problems });
  }
  return res;
};

console.log(`cross-vantage agreement — A = ${A_REL}`);

let anyDivergence = false;
for (const bRel of bList) {
  const days = has("--all")
    ? daysIn(A_REL).filter((d) => daysIn(bRel).includes(d))
    : [arg("--day", null)].filter(Boolean);

  if (days.length === 0) {
    const overlap = daysIn(A_REL).filter((d) => daysIn(bRel).includes(d));
    console.log(`\nB = ${bRel}`);
    console.log(overlap.length
      ? `  no --day given. Overlapping days: ${overlap.join(", ")}`
      : `  no overlapping days yet — the witness has not completed a full UTC day.`);
    continue;
  }

  console.log(`\nB = ${bRel}`);
  console.log("  day         compared   agree   A-only  B-only");
  for (const day of days) {
    const r = compareDay(day, A_REL, bRel);
    if (!r) { console.log(`  ${day}  (not present in both)`); continue; }
    const pct = r.compared ? ((r.agree / r.compared) * 100).toFixed(1) : "n/a";
    console.log(`  ${day}  ${String(r.compared).padStart(8)}  ${String(r.agree).padStart(6)} (${pct}%)  ${String(r.aOnly).padStart(6)}  ${String(r.bOnly).padStart(6)}`);
    for (const i of r.issues) {
      anyDivergence = true;
      console.log(`      ${i.min}  ${i.problems.join("; ")}`);
    }
  }
}

console.log();
console.log(anyDivergence
  ? "Divergence found. Investigate before relying on either vantage."
  : "No divergence beyond tolerance.");
console.log();
console.log("Agreement means two independent collectors saw the same thing. It does");
console.log("not mean the API told the truth — both could be shown the same false");
console.log("view. That gap closes only with attestations, not with more vantages.");

process.exit(anyDivergence ? 1 : 0);
