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

// ── reviewed divergences ─────────────────────────────────────────────────────
// Findings that have been investigated, explained, and recorded in REVIEWED.tsv.
// They are still reported in full; they just stop failing the run.
//
// The archive is append-only, so without this one bad minute fails every run
// forever. A permanently red badge is not a stricter check — it is a check
// nobody reads any more, and the next real divergence arrives inside a failure
// that was already there.
//
// Keyed to one vantage at one minute, so an entry can never cover a divergence
// other than the one someone actually looked at. --strict ignores the ledger.
const REVIEWED = (() => {
  const p = path.join(ROOT, "REVIEWED.tsv");
  const m = new Map();
  if (!fs.existsSync(p)) return m;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [vantage, minute, reviewedAt, ...rest] = line.split("\t");
    if (!vantage || !minute) continue;
    m.set(`${vantage}\t${minute}`, { reviewedAt, why: rest.join(" ").trim() });
  }
  return m;
})();
const STRICT = has("--strict");
// "vantage/ams/raw" -> "ams"; the primary is its own name.
const vantageOf = (rel) => (rel.startsWith("vantage/") ? rel.split("/")[1] : "primary");

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
// A relabelling in flight is not a disagreement.
//
// BAM periodically renames its whole fleet, swapping every node's -1/-2 suffix.
// Eight of these are on record between 2026-07-08 and 2026-08-18, and they are
// getting more frequent. When one completes inside a single capture nothing here
// notices. When it takes longer — the 2026-08-18 one took about three minutes,
// passing through a state where both names were live at once — the vantages
// sample different instants of the transition and report different node sets.
//
// That is a difference in when each collector looked, not in what it was shown,
// and failing on it has a cost beyond the noise: this check going red every few
// days is how a real divergence gets waved through as 'probably another rename'.
// The file that records reviewed divergences says the same thing about itself.
//
// So a node-set difference is excused only when all of this holds:
//
//   * both vantages report the identical stake figure — the API's own number,
//     compared exactly, not within a tolerance
//   * both report the identical validator count
//   * both see the identical set of regions
//   * every differing name is a conventional {city}-mainnet-bam-{n}-tee node
//
// The region test is what makes this narrow. A node genuinely present at one
// vantage and absent at the other changes the region set and still fails, which
// is what happened on 2026-08-12T04:18 when one collector held sin and another
// held tyo during a torn read. Only a suffix flip inside regions both vantages
// already agree on is forgiven.
//
// A relabelling whose stake moved between the two samples is still reported.
// That is the safe direction: it costs a review entry, not a missed divergence.
const RELABEL_NAME = /^[a-z]{3}-mainnet-bam-\d+-tee$/;
const regionsOf = (names) => [...new Set(names.map((n) => n.split("-")[0]))].sort().join(",");
const relabelInFlight = (a, b, extraInB, extraInA) =>
  a.validators === b.validators &&
  a.stake === b.stake &&
  regionsOf(a.nodes) === regionsOf(b.nodes) &&
  [...extraInB, ...extraInA].every((n) => RELABEL_NAME.test(n));

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

// Neighbouring minutes, used to build a local envelope.
//
// The vantages tick on independent clocks and can sample tens of seconds apart.
// BAM stake moves continuously — validators connect and disconnect, and a single
// large one shifts the total by over a million SOL in a minute. Comparing two
// instants for near-equality therefore reports ordinary volatility as
// disagreement: observed in the first real run, where both vantages reported
// byte-identical stake whenever the value was stable, and differed only across a
// three-minute window in which the validator count went 371→374→371.
//
// So a reading is judged against the range the other vantage actually observed
// either side of that minute. A value inside that range is consistent with
// having sampled the same reality at a different moment. A value outside it is
// not, and that is the thing worth alarming about — a vantage being served a
// view the others never saw at all.
const around = (map, min) => {
  const t = new Date(min + ":00Z").getTime();
  const out = [];
  for (let d = -1; d <= 1; d++) {
    const k = new Date(t + d * 60000).toISOString().slice(0, 16);
    if (map.has(k)) out.push(map.get(k));
  }
  return out;
};

const shiftDay = (day, n) => {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// A day's own file cannot supply neighbours for its first and last minute — they
// live in the adjacent files. Without them the envelope at midnight is built
// from fewer samples and is therefore narrower, which fails safe (it can only
// over-report, never miss) but would still turn a public badge red over nothing.
// So the boundary minutes are borrowed from the days either side.
const withEdges = (rel, day) => {
  const map = loadDay(rel, day);
  if (!map) return null;
  const prev = loadDay(rel, shiftDay(day, -1));
  if (prev) {
    const keys = [...prev.keys()].sort();
    if (keys.length) map.set(keys[keys.length - 1], prev.get(keys[keys.length - 1]));
  }
  const next = loadDay(rel, shiftDay(day, 1));
  if (next) {
    const keys = [...next.keys()].sort();
    if (keys.length) map.set(keys[0], next.get(keys[0]));
  }
  return map;
};

const compareDay = (day, aRel, bRel) => {
  // Compared minutes come from the day itself; the envelope may reach one minute
  // past either end, so borrowed edges are excluded from `shared` below.
  const Aday = loadDay(aRel, day), Bday = loadDay(bRel, day);
  if (!Aday || !Bday) return null;
  const A = withEdges(aRel, day), B = withEdges(bRel, day);

  // From the day's own minutes, never the borrowed edges — those exist only to
  // give the first and last minute a two-sided envelope, and comparing them here
  // would double-count them against the neighbouring day's own run.
  const shared = [...Aday.keys()].filter((k) => Bday.has(k)).sort();
  const res = { day, aOnly: Aday.size - shared.length, bOnly: Bday.size - shared.length,
                compared: shared.length, agree: 0, relabels: 0, issues: [] };

  for (const min of shared) {
    const a = A.get(min), b = B.get(min);
    const nearA = around(A, min), nearB = around(B, min);
    const problems = [];

    // Node sets change rarely, so this stays close to exact — but a node
    // appearing or vanishing mid-minute is real, so accept a match against any
    // reading A took nearby.
    //
    // Only B is judged against A's window, never the reverse. An earlier version
    // also passed the minute when A's set matched anything near B, which meant a
    // single forged minute was excused by its own untouched neighbours: a
    // witness hiding an entire region went undetected in testing. One side has
    // to be the reference or nothing is being checked.
    const bKey = b.nodes.join(",");
    if (!nearA.some((x) => x.nodes.join(",") === bKey)) {
      const missA = b.nodes.filter((n) => !a.nodes.includes(n));
      const missB = a.nodes.filter((n) => !b.nodes.includes(n));
      if (relabelInFlight(a, b, missA, missB)) res.relabels++;
      else
        problems.push(`node set differs${missA.length ? ` (+${missA.join("|")} in B)` : ""}${missB.length ? ` (+${missB.join("|")} in A)` : ""}`);
    }

    const vLo = Math.min(...nearA.map((x) => x.validators));
    const vHi = Math.max(...nearA.map((x) => x.validators));
    if (b.validators < vLo - VAL_TOL || b.validators > vHi + VAL_TOL)
      problems.push(`validators ${b.validators} outside A's ${vLo}–${vHi}`);

    const sLo = Math.min(...nearA.map((x) => x.stake));
    const sHi = Math.max(...nearA.map((x) => x.stake));
    const margin = (sHi || 1) * (STAKE_TOL / 100);
    if (b.stake < sLo - margin || b.stake > sHi + margin) {
      const off = ((b.stake < sLo ? sLo - b.stake : b.stake - sHi) / (sHi || 1)) * 100;
      problems.push(`stake ${b.stake} outside A's ${sLo.toFixed(0)}–${sHi.toFixed(0)} by ${off.toFixed(2)}%`);
    }

    if (problems.length === 0) res.agree++;
    else if (res.issues.length < 10) res.issues.push({ min, problems });
  }
  return res;
};

console.log(`cross-vantage agreement — A = ${A_REL}`);

let anyDivergence = false;
let reviewedHits = 0;
let relabelTotal = 0;
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
    relabelTotal += r.relabels;
    const relabelNote = r.relabels ? `   ${r.relabels} relabelling minute(s)` : "";
    console.log(`  ${day}  ${String(r.compared).padStart(8)}  ${String(r.agree).padStart(6)} (${pct}%)  ${String(r.aOnly).padStart(6)}  ${String(r.bOnly).padStart(6)}${relabelNote}`);
    for (const i of r.issues) {
      const seen = REVIEWED.get(`${vantageOf(bRel)}\t${i.min}`);
      if (seen && !STRICT) {
        reviewedHits++;
        console.log(`      ${i.min}  ${i.problems.join("; ")}`);
        console.log(`        └ reviewed ${seen.reviewedAt}: ${seen.why}`);
        continue;
      }
      anyDivergence = true;
      console.log(`      ${i.min}  ${i.problems.join("; ")}`);
    }
  }
}

console.log();
if (relabelTotal) {
  console.log(`${relabelTotal} minute(s) differed only by a fleet relabelling in flight —`);
  console.log("identical stake, identical validator count, identical regions, and every");
  console.log("differing name a suffix variant. Counted, not treated as divergence.");
  console.log();
}
if (reviewedHits) {
  console.log(`${reviewedHits} finding(s) matched a reviewed entry in REVIEWED.tsv and are`);
  console.log(`reported above rather than failing this run. Run with --strict to ignore`);
  console.log(`that file and treat every finding as a failure.`);
  console.log();
}
console.log(anyDivergence
  ? "Divergence found. Investigate before relying on either vantage."
  : reviewedHits
    ? "No divergence beyond tolerance that has not already been reviewed."
    : "No divergence beyond tolerance.");
console.log();
console.log("Agreement means two independent collectors saw the same thing. It does");
console.log("not mean the API told the truth — both could be shown the same false");
console.log("view. That gap closes only with attestations, not with more vantages.");

process.exit(anyDivergence ? 1 : 0);
