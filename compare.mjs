// Cross-vantage agreement check.
//
// Two collectors in different regions record the same public API independently.
// This diffs their records so that "the API said X" can be distinguished from
// "the API said X *to us*" — the difference between a faithful recording and a
// corroborated one.
//
//   node compare.mjs --day 2026-08-09
//   node compare.mjs --day 2026-08-09 --b vantage/sin/raw
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
const REQUESTED = has("--all") || has("--day");
if (![STAKE_TOL, VAL_TOL].every((v) => Number.isFinite(v) && v >= 0)) {
  console.error("Tolerances must be finite, non-negative numbers.");
  process.exit(2);
}
if (has("--day") && !/^\d{4}-\d{2}-\d{2}$/.test(arg("--day", ""))) {
  console.error("--day requires YYYY-MM-DD.");
  process.exit(2);
}
const readErrors = new Set();

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
  process.exit(REQUESTED ? 1 : 0);
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
// Ten are on record between 2026-07-08 and 2026-08-21, and they are
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
//
// Per-node stake is not compared here, and never has been — loadDay keeps node
// names, a total, and a validator count, so a vantage misreporting how stake is
// split between nodes while keeping the total was already invisible. This rule
// widens that slightly, since a suffix flip is no longer flagged and would have
// caught such a thing by accident. Worth stating rather than leaving implicit.
// In every relabelling on record the flipped pairs carry identical per-node
// stake to the cent — fra-1 and fra-2 both held 26137171.91 through the
// 2026-08-18 transition — so a tighter test is possible; it is not built because
// the transitional captures also contain unpaired duplicates that a naive
// multiset comparison would reject, and a rule that breaks on the real case is
// worse than one honest about its edge.
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
    readErrors.add(`${rel} ${day}: cannot decompress (${e.code || e.message}). Run ./verify.sh.`);
    return null;
  }
  const byMinute = new Map();
  for (const line of text.split("\n")) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); }
    catch { readErrors.add(`malformed JSON in ${p}`); continue; }
    if (!r || typeof r.ts !== "string" || !r.ts.startsWith(day + "T") ||
        !Number.isFinite(Date.parse(r.ts)) ||
        !Number.isFinite(r.stake?.bam_stake) || r.stake.bam_stake < 0 ||
        !Array.isArray(r.nodes) || !Array.isArray(r.validators) ||
        r.nodes.some((n) => !n || typeof n.bam_node !== "string" || !n.bam_node)) {
      readErrors.add(`invalid capture in ${p} at ${r?.ts ?? "unknown time"}`);
      continue;
    }
    const minute = r.ts.slice(0, 16);
    if (byMinute.has(minute)) continue;
    const table = new Map(r.nodes.map((n) => [n.bam_node, { cv: n.connected_validators, stake: n.node_stake }]));
    const vBy = new Map();
    for (const v of r.validators) vBy.set(v?.bam_node_connection, (vBy.get(v?.bam_node_connection) ?? 0) + 1);
    byMinute.set(minute, {
      ts: r.ts,
      stake: r.stake?.bam_stake ?? 0,
      nodes: (r.nodes ?? []).map((n) => n.bam_node).sort(),
      validators: (r.validators ?? []).length,
      table,
      vBy,
      nodeSum: r.nodes.reduce((s, n) => s + (Number.isFinite(n.node_stake) ? n.node_stake : NaN), 0),
    });
  }
  return byMinute;
};

// A node flickering at one vantage is not a disagreement either.
//
// Nodes drop out of the API for seconds at a time and come straight back, and
// validators reconnect in waves. The vantages sample tens of seconds apart, so
// the one that lands inside the gap records an absence the others never see.
//
// So a finding is excused when B's capture is one of A's readings in the window
// less part or all of a single node, and nothing else:
//
//   * every other node is identical to the cent — connected count and stake —
//     and so is the number of validator records attributed to it
//   * the one node, in B, holds no more than it did in A, in its node entry and
//     in the validator list alike; it may be absent entirely
//   * B's headline stake lies between A's headline and A's headline less that
//     node's whole stake — never above, never further below
//   * B has nothing A lacked: no node A did not list
//   * B's own captures a minute either side hold that node at least as A did,
//     so the absence lasted one capture
//
// What this forgives is "one vantage, one capture, saw less of one node". What
// it still reports: two nodes moving at once, anything B holds that A did not,
// a deficit larger than the node itself, an absence that lasts two captures,
// and any change elsewhere in the network even by a cent. The last condition is
// what makes it narrow — a witness hiding a node for longer than one capture,
// or the primary reporting a node the witnesses never see, fails as before.
//
// The edge, stated rather than left implicit: the node's size is not bounded.
// A one-capture absence of the largest node in the fleet at one witness would be
// forgiven, and it would be printed exactly like a small one. Bounding it would
// mean another threshold, and thresholds are where this project's past read
// faults have come from.
const SUM_TOL = 0.05; // SOL; node stakes are published to the cent, so sums carry rounding
const sameNode = (p, q) => p.cv === q.cv && p.stake === q.stake;
const coherent = (r) => Math.abs(r.stake - r.nodeSum) <= SUM_TOL;

const shortByOneNode = (b, x) => {
  if (b.nodes.some((n) => !x.table.has(n))) return null;
  const differ = new Set();
  for (const [n, xn] of x.table) {
    const bn = b.table.get(n);
    if (!bn || !sameNode(bn, xn)) differ.add(n);
  }
  for (const n of new Set([...x.vBy.keys(), ...b.vBy.keys()]))
    if ((x.vBy.get(n) ?? 0) !== (b.vBy.get(n) ?? 0)) differ.add(n);
  if (differ.size !== 1) return null;
  const [n] = differ;
  const xn = x.table.get(n);
  if (!xn) return null;
  const bn = b.table.get(n) ?? { cv: 0, stake: 0 };
  if (bn.cv > xn.cv || bn.stake > xn.stake) return null;
  if ((b.vBy.get(n) ?? 0) > (x.vBy.get(n) ?? 0)) return null;
  if (b.stake > x.stake + SUM_TOL || b.stake < x.stake - xn.stake - SUM_TOL) return null;
  return n;
};

// "Whole" means holding at least what A's reading gave the node. A neighbour
// holding more is judged against A in its own minute, so it cannot hide here.
const holdsAtLeast = (r, n, x) => {
  const rn = r?.table.get(n), xn = x.table.get(n);
  return !!rn && rn.cv >= xn.cv && rn.stake >= xn.stake && (r.vBy.get(n) ?? 0) >= (x.vBy.get(n) ?? 0);
};

const minuteShift = (min, d) => new Date(new Date(min + ":00Z").getTime() + d * 60000).toISOString().slice(0, 16);

const flickerAtB = (B, min, b, nearA) => {
  for (const x of nearA) {
    const n = shortByOneNode(b, x);
    if (n && holdsAtLeast(B.get(minuteShift(min, -1)), n, x) && holdsAtLeast(B.get(minuteShift(min, 1)), n, x)) {
      const bn = b.table.get(n), xn = x.table.get(n);
      const entry = bn ? `${bn.cv} of ${xn.cv} connected` : "absent from the node list";
      return `${n} ${entry}, ${b.vBy.get(n) ?? 0} of ${x.vBy.get(n) ?? 0} validator records, ` +
        `for one capture at B; everything else identical to A at ${x.ts.slice(11, 19)}`;
    }
  }
  return null;
};

// The primary's own capture can be torn — its headline stake from one instant,
// its node list from another — and compare.mjs judges B's stake against A's
// headline. A witness that recorded exactly the node list A did then reads as a
// stake divergence. Excused only when B's node entries and per-node validator
// records are identical to an A reading's and B is itself coherent. A finding
// can then only exist if that A reading is not coherent, so the disagreement is
// inside A's capture; no separate test of A is needed.
const sameBody = (b, x) =>
  b.table.size === x.table.size &&
  [...x.table].every(([n, xn]) => b.table.has(n) && sameNode(b.table.get(n), xn)) &&
  b.vBy.size === x.vBy.size &&
  [...x.vBy].every(([n, c]) => b.vBy.get(n) === c);

const tornAtA = (b, nearA) => {
  if (!coherent(b)) return null;
  const x = nearA.find((r) => sameBody(b, r));
  return x ? `A's ${x.ts.slice(11, 19)} headline (${x.stake}) disagrees with its own node list, which B matches exactly` : null;
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
//
// Each day is read up to six times, as itself and as its neighbours' edges, and
// --all runs under a fixed CI timeout while the archive grows daily. Days are
// visited in order, so a handful of recent ones is all the cache needs.
// Callers must not mutate what it returns.
const dayCache = new Map();
const loadDayCached = (rel, day) => {
  const k = `${rel}\t${day}`;
  if (!dayCache.has(k)) {
    dayCache.set(k, loadDay(rel, day));
    if (dayCache.size > 8) dayCache.delete(dayCache.keys().next().value);
  }
  return dayCache.get(k);
};

const withEdges = (rel, day) => {
  const own = loadDayCached(rel, day);
  if (!own) return null;
  const map = new Map(own);
  const prev = loadDayCached(rel, shiftDay(day, -1));
  if (prev) {
    const keys = [...prev.keys()].sort();
    if (keys.length) map.set(keys[keys.length - 1], prev.get(keys[keys.length - 1]));
  }
  const next = loadDayCached(rel, shiftDay(day, 1));
  if (next) {
    const keys = [...next.keys()].sort();
    if (keys.length) map.set(keys[0], next.get(keys[0]));
  }
  return map;
};

const compareDay = (day, aRel, bRel) => {
  // Compared minutes come from the day itself; the envelope may reach one minute
  // past either end, so borrowed edges are excluded from `shared` below.
  const Aday = loadDayCached(aRel, day), Bday = loadDayCached(bRel, day);
  if (!Aday || !Bday) return null;
  const A = withEdges(aRel, day), B = withEdges(bRel, day);

  // From the day's own minutes, never the borrowed edges — those exist only to
  // give the first and last minute a two-sided envelope, and comparing them here
  // would double-count them against the neighbouring day's own run.
  const shared = [...Aday.keys()].filter((k) => Bday.has(k)).sort();
  const res = { day, aOnly: Aday.size - shared.length, bOnly: Bday.size - shared.length,
                compared: shared.length, agree: 0, relabels: 0, excused: [], issues: [] };

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
      // --strict reaches this too. The flag is documented as treating every
      // finding as a failure, and a rule that decides something is not a finding
      // at all would quietly put itself beyond the one escape hatch a sceptical
      // reader has. Under --strict the relabelling is reported like anything else.
      if (!STRICT && relabelInFlight(a, b, missA, missB)) res.relabels++;
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

    if (problems.length === 0) { res.agree++; continue; }
    // Under --strict these are reported like anything else, for the same reason
    // as the relabelling rule above.
    const excuse = STRICT ? null : flickerAtB(B, min, b, nearA) ?? tornAtA(b, nearA);
    if (excuse) res.excused.push({ min, problems, excuse });
    // Review every finding. Truncating this array could hide an unreviewed
    // eleventh finding when the first ten were already in REVIEWED.tsv.
    else res.issues.push({ min, problems });
  }
  return res;
};

console.log(`cross-vantage agreement — A = ${A_REL}`);

let anyDivergence = false;
let incomplete = false;
let reviewedHits = 0;
let relabelTotal = 0;
let excusedTotal = 0;
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
    if (REQUESTED) incomplete = true;
    continue;
  }

  console.log(`\nB = ${bRel}`);
  console.log("  day         compared   agree   A-only  B-only");
  for (const day of days) {
    const r = compareDay(day, A_REL, bRel);
    if (!r) { console.log(`  ${day}  (missing or unreadable at a selected vantage)`); incomplete = true; continue; }
    if (!r.compared) incomplete = true;
    const pct = r.compared ? ((r.agree / r.compared) * 100).toFixed(1) : "n/a";
    relabelTotal += r.relabels;
    const relabelNote = r.relabels ? `   ${r.relabels} relabelling minute(s)` : "";
    const excusedNote = r.excused.length ? `   ${r.excused.length} sampling minute(s)` : "";
    console.log(`  ${day}  ${String(r.compared).padStart(8)}  ${String(r.agree).padStart(6)} (${pct}%)  ${String(r.aOnly).padStart(6)}  ${String(r.bOnly).padStart(6)}${relabelNote}${excusedNote}`);
    // Printed in full, never only counted: each is still a moment one vantage
    // saw something the other did not, and the record of how often a node
    // flickers is worth having even when no single instance is a fault.
    for (const e of r.excused) {
      excusedTotal++;
      console.log(`      ${e.min}  ${e.problems.join("; ")}`);
      console.log(`        └ sampling: ${e.excuse}`);
    }
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
if (excusedTotal) {
  console.log(`${excusedTotal} minute(s) differed only by sampling, marked "└ sampling" above —`);
  console.log("a single node seen short at the witness for one capture with every other");
  console.log("node identical, or a torn primary capture whose node list the witness");
  console.log("matches exactly. Printed, not treated as divergence; --strict fails them.");
  console.log();
}
if (reviewedHits) {
  console.log(`${reviewedHits} finding(s) matched a reviewed entry in REVIEWED.tsv and are`);
  console.log(`reported above rather than failing this run. Run with --strict to ignore`);
  console.log(`that file and treat every finding as a failure.`);
  console.log();
}
for (const error of readErrors) console.error(error);
if (incomplete || readErrors.size) console.error("Comparison incomplete: missing, unreadable, invalid, or non-overlapping data. This is not a pass.");
console.log(anyDivergence
  ? "Divergence found. Investigate before relying on either vantage."
  : incomplete || readErrors.size
    ? "Agreement could not be established for all requested data."
  : reviewedHits
    ? "No divergence beyond tolerance that has not already been reviewed."
    : "No divergence beyond tolerance.");
console.log();
console.log("Agreement means two independent collectors saw the same thing. It does");
console.log("not mean the API told the truth — both could be shown the same false");
console.log("view. That gap closes only with attestations, not with more vantages.");

process.exit(anyDivergence || incomplete || readErrors.size ? 1 : 0);
