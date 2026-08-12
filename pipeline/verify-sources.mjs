// Cross-source verification of what BAM reports about itself.
//
// Everything else this project publishes is gathered from BAM's own API, which
// makes it an index of BAM's claims rather than a check on them. This is the
// check. It answers two questions per run, neither of which requires BAM's
// cooperation or an attestation feed:
//
//   1. Is the stake BAM reports real? Take BAM's own membership list, look each
//      validator's stake up on Solana, and compare against what BAM says. This
//      needs no trust in BAM at all — the chain is the authority, and BAM's
//      figures either match it or they do not.
//
//   2. Do Jito's own two systems agree on who is running BAM? The BAM explorer
//      and Jito's Kobe API both publish membership, independently. They join on
//      identity pubkey (Kobe's `identity_account`, the explorer's
//      `validator_pubkey`) — *not* vote account, which matches nothing.
//
// What this cannot do is derive membership independently. A BAM-produced block
// and an ordinary one are indistinguishable on chain: BAM changes how a block is
// assembled, not what ends up in it, so nothing is stamped on the result.
// Membership therefore still comes from Jito — but it is now cross-checked
// rather than taken on faith, and the stake attached to it is verified outright.
//
// Writes one CSV row per run. A run where any source is unavailable writes
// nothing: a gap in coverage is true, whereas a row full of zeroes would be a
// measurement that never happened.
//
//   node verify-sources.mjs --out /data/capture/verification.csv

import fs from "node:fs";
import { HEADER, migrate, toLine } from "./verification-schema.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };

const OUT = arg("--out", "verification.csv");
// Where the inputs behind each row are written. See the evidence block below.
const EVIDENCE = arg("--evidence", process.env.VERIFY_EVIDENCE || "");
const BAM_API = arg("--bam", process.env.BAM_API_BASE || "https://explorer.bam.dev/api/v1");
const KOBE = arg("--kobe", process.env.KOBE_API_BASE || "https://kobe.mainnet.jito.network");
const RPC = arg("--rpc", process.env.SOLANA_RPC_URL || "");

// The columns, every earlier version of them, and the migration between them
// live in verification-schema.mjs. Kept there rather than here because a header
// this file defines privately is a header no reader of the archive can check
// against, and because rows are now assembled by name — see the write below.

const die = (msg) => { console.error(`verify-sources: ${msg}`); process.exit(1); };

const getJSON = async (url, init) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
};

// The three sources return differently-shaped payloads; normalise to an array.
const rowsOf = (j) => Array.isArray(j) ? j : (j?.validators ?? Object.values(j ?? {}).find(Array.isArray) ?? []);

const main = async () => {
  if (!RPC) die("no RPC endpoint. Set SOLANA_RPC_URL or pass --rpc.");

  const [explorerRaw, headlineRaw, kobeRaw, voteRaw] = await Promise.all([
    getJSON(`${BAM_API}/validators`),
    // BAM's own published totals. Worth fetching separately rather than summing
    // the validator list: this is the number BAM actually states about itself,
    // and the whole point is to check *their* claim, not a restatement of it.
    getJSON(`${BAM_API}/bam_stake`),
    getJSON(`${KOBE}/api/v1/validators`),
    getJSON(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "getVoteAccounts",
        params: [{ keepUnstakedDelinquents: false }],
      }),
    }),
  ]);

  const explorer = rowsOf(explorerRaw);
  const kobe = rowsOf(kobeRaw);
  const vote = voteRaw?.result;
  if (!explorer.length) die("BAM explorer returned no validators");
  if (!kobe.length) die("Kobe returned no validators");
  if (!vote?.current?.length) die("RPC returned no vote accounts");

  // Reject a truncated source rather than publishing it as a disagreement.
  //
  // Kobe twice served a short list — 232 and 192 validators against its usual
  // ~666 — and every validator missing from it was recorded as one the two
  // sources "disagreed" about. That produced spikes of 142 and 181 disputed
  // validators on the public chart: not a finding about BAM, an outage at Jito
  // rendered as one.
  //
  // The chain is the reference for how many validators exist, which makes this
  // an independent completeness test rather than a guess about what looks
  // normal. Kobe lists very nearly the full validator set, so a response holding
  // less than four-fifths of it is short, and a short list cannot support any
  // claim about who is missing from it.
  const chainValidators = vote.current.length;
  if (kobe.length < chainValidators * 0.8) {
    die(`Kobe returned ${kobe.length} validators against ${chainValidators} on chain — truncated, refusing to record a disagreement`);
  }
  // Guarded rather than defaulted. A missing headline written as 0 would publish
  // "BAM claims 0% of stake" as a measurement, which is the same fault as
  // recording an empty API response as an observation.
  const headStake = Number(headlineRaw?.bam_stake);
  const headShare = Number(headlineRaw?.bam_stake_percentage);
  if (!(headStake > 0) || !(headShare > 0)) die("BAM /bam_stake returned no usable headline");

  // ── membership ────────────────────────────────────────────────────────────
  const kobeBam = new Set(kobe.filter((r) => r.running_bam === true).map((r) => r.identity_account));
  const explorerById = new Map(explorer.map((r) => [r.validator_pubkey, r]));

  const onlyExplorer = [...explorerById.keys()].filter((id) => !kobeBam.has(id));
  const onlyKobe = [...kobeBam].filter((id) => !explorerById.has(id));
  const inBoth = explorerById.size - onlyExplorer.length;

  // Stake sitting on the disagreement — a discrepancy over 3 dust validators and
  // one over 3 large ones are not the same finding.
  const disputedStake =
    onlyExplorer.reduce((a, id) => a + (explorerById.get(id)?.stake ?? 0), 0) +
    onlyKobe.reduce((a, id) => {
      const k = kobe.find((r) => r.identity_account === id);
      return a + (k ? (k.active_stake ?? 0) / 1e9 : 0);
    }, 0);

  // ── stake against the chain ───────────────────────────────────────────────
  const chain = new Map(vote.current.map((v) => [v.nodePubkey, v.activatedStake / 1e9]));
  const networkStake = vote.current.reduce((a, v) => a + v.activatedStake, 0) / 1e9;

  let matched = 0, reported = 0, onchain = 0, maxRel = 0;
  const rels = [];
  for (const [id, r] of explorerById) {
    const c = chain.get(id);
    if (c === undefined) continue;      // in BAM's list but not an active validator
    matched++;
    const claimed = r.stake ?? 0;
    reported += claimed;
    onchain += c;
    if (c > 0) {
      const rel = (Math.abs(claimed - c) / c) * 100;
      rels.push(rel);
      maxRel = Math.max(maxRel, rel);
    }
  }
  if (!matched) die("no BAM validator matched an on-chain vote account");

  // A max over hundreds of validators is decided by whichever one moved stake
  // between BAM's snapshot and ours — one delegation swing put 27.85% on the
  // chart while every other validator agreed to four decimal places. The median
  // describes the reporting; the max is kept because a genuine systematic error
  // would move both.
  rels.sort((a, b) => a - b);
  const medRel = rels.length ? rels[Math.floor(rels.length / 2)] : 0;

  // Assembled by name, and strictly: a column added to the schema without a
  // value here fails the run instead of writing a row that is one field short of
  // its own header. The positional version of this could not tell the two apart.
  const row = toLine({
    ts: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    explorer_validators: explorerById.size,
    kobe_running_bam: kobeBam.size,
    in_both: inBoth,
    only_explorer: onlyExplorer.length,
    only_kobe: onlyKobe.length,
    disputed_stake_sol: disputedStake.toFixed(2),
    kobe_total_validators: kobe.length,
    chain_validators: chainValidators,
    onchain_matched: matched,
    stake_reported_sol: reported.toFixed(2),
    stake_onchain_sol: onchain.toFixed(2),
    stake_abs_diff_sol: Math.abs(reported - onchain).toFixed(2),
    stake_max_rel_pct: maxRel.toFixed(4),
    stake_median_rel_pct: medRel.toFixed(4),
    // BAM's published headline, verbatim. Its share uses BAM's own denominator,
    // which is not identical to getVoteAccounts' — that difference is precisely
    // what makes comparing them a real check rather than a restatement.
    bam_headline_stake_sol: headStake.toFixed(2),
    bam_headline_share_pct: headShare.toFixed(4),
    bam_share_reported_pct: ((reported / networkStake) * 100).toFixed(4),
    bam_share_onchain_pct: ((onchain / networkStake) * 100).toFixed(4),
  }, { strict: true });

  // ── evidence ──────────────────────────────────────────────────────────────
  // The inputs this row was computed from, so the arithmetic can be checked by
  // someone who does not trust it.
  //
  // Everything else this project publishes is a pure function of published
  // inputs: the captures are archived, so any figure on the dashboard can be
  // recomputed from them. The verification row was the exception. It reports
  // aggregates — a median deviation, a disputed-stake total — over three
  // responses that existed for one moment and were never written down. Nobody
  // could check whether 0.0000% was the right median, only take it.
  //
  // So the responses are reduced to exactly the fields the row is derived from
  // and archived alongside it. recompute.mjs turns one of these back into a row
  // and diffs it against what was published, which is the check this record
  // exists to make possible.
  //
  // What it still does not establish: that the sources told the truth, or that
  // these were faithfully recorded. Evidence produced by the same process it
  // vouches for cannot settle that, and nothing short of attestations will. It
  // closes the gap between the published row and the inputs it claims to come
  // from — which was, until now, unbridgeable rather than merely narrow.
  if (EVIDENCE) {
    const record = {
      ts: row.split(",")[0],
      sources: {
        // Verbatim, both fields, as BAM states them.
        bam_headline: { bam_stake: headStake, bam_stake_percentage: headShare },
        // Only the two fields the row uses. The full response carries display
        // metadata that would triple the size and prove nothing further.
        bam_validators: explorer.map((r) => [r.validator_pubkey, r.stake ?? 0]),
        // Lamports, as Kobe returns them, so the conversion is auditable too.
        kobe_running_bam: kobe.filter((r) => r.running_bam === true)
          .map((r) => [r.identity_account, r.active_stake ?? 0]),
        // The denominator of the truncation guard, and the guard's whole point.
        kobe_total: kobe.length,
        // Every current vote account, not only BAM's. The network total is the
        // denominator of the share figures, so recording only BAM's validators
        // would leave the most contested number on the panel unrecomputable.
        chain_vote_accounts: vote.current.map((v) => [v.nodePubkey, v.activatedStake]),
      },
    };
    fs.appendFileSync(EVIDENCE, JSON.stringify(record) + "\n");
  }

  // Bring the file up to the current schema before appending to it.
  //
  // Unconditional, not gated on the header having changed: the file can hold
  // rows that need repair while its header already reads correct. That is
  // precisely the state the first attempt at this left behind — it rewrote the
  // header, mapped every row through it by name, and so reinterpreted rows that
  // a later schema had written, moving BAM's published stake into a column
  // meaning "per cent" without anything afterwards looking wrong.
  //
  // Cheap enough to run every time: the file grows by one row per cycle, and a
  // year of them is a few thousand lines.
  if (fs.existsSync(OUT)) {
    const m = migrate(fs.readFileSync(OUT, "utf8"));
    for (const d of m.dropped) console.log(`  dropped a row — ${d.why}: ${d.line.slice(0, 120)}`);
    if (m.changed) {
      fs.writeFileSync(OUT, m.text);
      console.log(`  rewrote ${m.kept} rows under the current schema`);
    }
  } else {
    fs.writeFileSync(OUT, HEADER + "\n");
  }
  fs.appendFileSync(OUT, row + "\n");
  console.log(`  ${row}`);
};

main().catch((e) => die(e.message));
