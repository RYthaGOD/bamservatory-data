// Recompute a published verification row from the evidence it was derived from.
//
// The rest of this archive is checkable because the raw captures are published:
// anyone can rebuild the dashboard's figures from them and compare. The
// verification series was the exception. It reports aggregates over three API
// responses that existed for a moment and were never written down, so its
// numbers could be read but not checked.
//
// verification/ now carries the inputs behind each row, and this turns them back
// into a row. If what comes out does not match what was published, one of the
// two is wrong and the difference is printed field by field.
//
//   node recompute.mjs                        # every row that has evidence
//   node recompute.mjs --day 2026-08-12       # one archived day
//   node recompute.mjs --ts 2026-08-12T04:07:11Z
//
// This proves the transform, not the sources. Evidence gathered by the same
// process it vouches for cannot establish that BAM or Jito told the truth, and
// nothing here pretends otherwise — see "What cannot be verified" in the README.
// What it does establish is that the published figure is the one these inputs
// produce, which until now had to be taken on faith.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { COLUMNS } from "./pipeline/verification-schema.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };

const ROOT = arg("--root", ".");
const DAY = arg("--day", null);
const TS = arg("--ts", null);
const EVIDENCE_DIR = path.join(ROOT, "verification");
const CSV = path.join(ROOT, "verification.csv");

// ── the computation, exactly as verify-sources.mjs performs it ───────────────
// Deliberately a transcription rather than a shared import. If both sides called
// the same function, a mistake inside it would reproduce itself perfectly and
// this check would confirm the error. Two independent expressions of the same
// arithmetic disagree when either one is wrong.
function recompute(ev) {
  const s = ev.sources;
  const explorer = new Map(s.bam_validators);
  const kobeBam = new Map(s.kobe_running_bam);
  const chain = new Map(s.chain_vote_accounts);

  const onlyExplorer = [...explorer.keys()].filter((id) => !kobeBam.has(id));
  const onlyKobe = [...kobeBam.keys()].filter((id) => !explorer.has(id));
  const inBoth = explorer.size - onlyExplorer.length;

  const disputedStake =
    onlyExplorer.reduce((a, id) => a + (explorer.get(id) ?? 0), 0) +
    onlyKobe.reduce((a, id) => a + (kobeBam.get(id) ?? 0) / 1e9, 0);

  let networkStake = 0;
  for (const [, lamports] of s.chain_vote_accounts) networkStake += lamports / 1e9;

  let matched = 0, reported = 0, onchain = 0, maxRel = 0;
  const rels = [];
  for (const [id, claimed] of explorer) {
    if (!chain.has(id)) continue;
    const c = chain.get(id) / 1e9;
    matched++;
    reported += claimed;
    onchain += c;
    if (c > 0) {
      const rel = (Math.abs(claimed - c) / c) * 100;
      rels.push(rel);
      if (rel > maxRel) maxRel = rel;
    }
  }
  rels.sort((a, b) => a - b);
  const medRel = rels.length ? rels[Math.floor(rels.length / 2)] : 0;

  return {
    ts: ev.ts,
    explorer_validators: String(explorer.size),
    kobe_running_bam: String(kobeBam.size),
    in_both: String(inBoth),
    only_explorer: String(onlyExplorer.length),
    only_kobe: String(onlyKobe.length),
    disputed_stake_sol: disputedStake.toFixed(2),
    kobe_total_validators: String(s.kobe_total),
    chain_validators: String(s.chain_vote_accounts.length),
    onchain_matched: String(matched),
    stake_reported_sol: reported.toFixed(2),
    stake_onchain_sol: onchain.toFixed(2),
    stake_abs_diff_sol: Math.abs(reported - onchain).toFixed(2),
    stake_max_rel_pct: maxRel.toFixed(4),
    stake_median_rel_pct: medRel.toFixed(4),
    bam_headline_stake_sol: Number(s.bam_headline.bam_stake).toFixed(2),
    bam_headline_share_pct: Number(s.bam_headline.bam_stake_percentage).toFixed(4),
    bam_share_reported_pct: ((reported / networkStake) * 100).toFixed(4),
    bam_share_onchain_pct: ((onchain / networkStake) * 100).toFixed(4),
  };
}

// ── inputs ───────────────────────────────────────────────────────────────────
const readEvidence = () => {
  const out = [];
  const push = (buf) => {
    for (const line of buf.toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* a truncated tail is not a row */ }
    }
  };
  // The live file first, then archived days. A row published minutes ago has not
  // been archived yet, and it is the one a reader is most likely to check.
  const live = path.join(ROOT, "verification-evidence.jsonl");
  if (fs.existsSync(live)) push(fs.readFileSync(live));

  if (fs.existsSync(EVIDENCE_DIR)) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".jsonl.zst")) push(zlib.zstdDecompressSync(fs.readFileSync(p)));
      }
    };
    walk(EVIDENCE_DIR);
  }
  return out;
};

const readPublished = () => {
  if (!fs.existsSync(CSV)) return new Map();
  const lines = fs.readFileSync(CSV, "utf8").trim().split(/\r?\n/);
  const hdr = lines[0].split(",");
  const m = new Map();
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    const row = {};
    hdr.forEach((name, i) => { row[name] = (c[i] ?? "").trim(); });
    if (row.ts) m.set(row.ts, row);
  }
  return m;
};

// ── run ──────────────────────────────────────────────────────────────────────
let evidence = readEvidence();
if (DAY) evidence = evidence.filter((e) => e.ts.startsWith(DAY));
if (TS) evidence = evidence.filter((e) => e.ts === TS);

const published = readPublished();

if (!evidence.length) {
  console.log("No evidence records found for that selection.");
  console.log("Evidence is written from the first verification run after this was deployed;");
  console.log("rows published before then cannot be recomputed, only read.");
  process.exit(0);
}

console.log(`recomputing ${evidence.length} row(s) from published evidence\n`);

let checked = 0, agreed = 0, missing = 0;
const disagreements = [];

for (const ev of evidence) {
  const got = recompute(ev);
  const want = published.get(ev.ts);
  if (!want) {
    missing++;
    continue;
  }
  checked++;
  const diffs = COLUMNS.filter((c) => (want[c] ?? "") !== (got[c] ?? ""))
    .map((c) => `      ${c}: published ${want[c] || "(blank)"} / recomputed ${got[c]}`);
  if (diffs.length === 0) agreed++;
  else disagreements.push(`  ${ev.ts}\n${diffs.join("\n")}`);
}

if (disagreements.length) {
  console.log("DISAGREEMENT — a published row is not what its own inputs produce:\n");
  console.log(disagreements.join("\n\n"));
  console.log();
}

console.log(`  rows with evidence and a published row : ${checked}`);
console.log(`  reproduced exactly                     : ${agreed}`);
console.log(`  disagreed                              : ${disagreements.length}`);
if (missing) console.log(`  evidence with no published row         : ${missing}  (row dropped by a schema migration, or not yet published)`);
console.log();
console.log("This checks the transform, not the sources. It shows the published figure is");
console.log("the one these inputs produce — not that BAM or Jito reported truthfully, which");
console.log("no amount of our own evidence could establish.");

process.exit(disagreements.length ? 1 : 0);
