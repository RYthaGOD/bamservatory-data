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

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };

const OUT = arg("--out", "verification.csv");
const BAM_API = arg("--bam", process.env.BAM_API_BASE || "https://explorer.bam.dev/api/v1");
const KOBE = arg("--kobe", process.env.KOBE_API_BASE || "https://kobe.mainnet.jito.network");
const RPC = arg("--rpc", process.env.SOLANA_RPC_URL || "");

const HEADER = [
  "ts",
  // membership cross-check
  "explorer_validators", "kobe_running_bam", "in_both",
  "only_explorer", "only_kobe", "disputed_stake_sol",
  // stake verification against the chain
  "onchain_matched", "stake_reported_sol", "stake_onchain_sol",
  "stake_abs_diff_sol", "stake_max_rel_pct",
  // BAM's own published headline, and the same quantity derived from chain
  "bam_headline_stake_sol", "bam_headline_share_pct",
  "bam_share_reported_pct", "bam_share_onchain_pct",
].join(",");

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
  for (const [id, r] of explorerById) {
    const c = chain.get(id);
    if (c === undefined) continue;      // in BAM's list but not an active validator
    matched++;
    const claimed = r.stake ?? 0;
    reported += claimed;
    onchain += c;
    if (c > 0) maxRel = Math.max(maxRel, (Math.abs(claimed - c) / c) * 100);
  }
  if (!matched) die("no BAM validator matched an on-chain vote account");

  const row = [
    new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    explorerById.size, kobeBam.size, inBoth,
    onlyExplorer.length, onlyKobe.length, disputedStake.toFixed(2),
    matched, reported.toFixed(2), onchain.toFixed(2),
    Math.abs(reported - onchain).toFixed(2), maxRel.toFixed(4),
    // BAM's published headline, verbatim. Its share uses BAM's own denominator,
    // which is not identical to getVoteAccounts' — that difference is precisely
    // what makes comparing them a real check rather than a restatement.
    headStake.toFixed(2),
    headShare.toFixed(4),
    ((reported / networkStake) * 100).toFixed(4),
    ((onchain / networkStake) * 100).toFixed(4),
  ].join(",");

  if (!fs.existsSync(OUT)) fs.writeFileSync(OUT, HEADER + "\n");
  fs.appendFileSync(OUT, row + "\n");
  console.log(`  ${row}`);
};

main().catch((e) => die(e.message));
