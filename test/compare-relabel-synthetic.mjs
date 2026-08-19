// Each condition of the relabelling rule, isolated.
//
// test/compare-relabel.mjs asserts the rule against the real archive, which is
// the evidence that matters — but the archive only contains the cases BAM has
// happened to produce, and those do not separate the rule's conditions from one
// another. Deleting the exact-stake test passed that suite untouched, because in
// every real case the region test was already refusing the same minute. A
// condition no test can kill is a condition that will quietly rot.
//
// So this builds the minimal archives that isolate each one: two vantages, one
// minute, four nodes, and a single deliberate difference. The rule forgives a
// suffix flip and nothing else, and each case here removes exactly one reason to
// forgive it.
//
//   node test/compare-relabel-synthetic.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-relabel-"));
process.on("exit", () => fs.rmSync(WORK, { recursive: true, force: true }));

let fails = 0;
const check = (label, ok, detail = "") => {
  if (ok) console.log(`  ok    ${label}`);
  else { console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); fails++; }
};

const DAY = "2026-08-18";
const capture = (ts, nodes, stake, validators) => JSON.stringify({
  ts,
  stake: { bam_stake: stake, bam_stake_percentage: 32 },
  nodes: nodes.map((n) => ({ bam_node: n, region: n, connected_validators: 1, node_stake: stake / nodes.length })),
  validators: Array.from({ length: validators }, (_, i) => ({
    validator_pubkey: `V${i}`, bam_node_connection: nodes[0], stake: 1, stake_percentage: 0.1,
  })),
});

// One minute is enough: the rule looks at a single pair of readings. Three
// captures a minute apart on each side give the neighbour envelope something to
// hold so the check is exercised rather than skipped.
const writeVantage = (dir, rel, sets) => {
  const p = path.join(dir, rel, "2026", "08");
  fs.mkdirSync(p, { recursive: true });
  const lines = sets.map(([ts, nodes, stake, vals]) => capture(ts, nodes, stake, vals));
  fs.writeFileSync(path.join(p, "18.jsonl.zst"), zlib.zstdCompressSync(Buffer.from(lines.join("\n") + "\n")));
};

const OLD = ["ams-mainnet-bam-1-tee", "fra-mainnet-bam-2-tee"];
const NEW = ["ams-mainnet-bam-2-tee", "fra-mainnet-bam-1-tee"];

// `b` is the case under test at 12:01; the minutes either side are identical at
// both vantages so only the middle one can produce a finding.
const scenario = (name, bNodes, bStake, bVals, strict = false) => {
  const dir = fs.mkdtempSync(path.join(WORK, "s-"));
  writeVantage(dir, "raw", [
    [`${DAY}T12:00:30Z`, OLD, 1000, 4],
    [`${DAY}T12:01:30Z`, OLD, 1000, 4],
    [`${DAY}T12:02:30Z`, OLD, 1000, 4],
  ]);
  writeVantage(dir, "vantage/w/raw", [
    [`${DAY}T12:00:10Z`, OLD, 1000, 4],
    [`${DAY}T12:01:10Z`, bNodes, bStake, bVals],
    [`${DAY}T12:02:10Z`, OLD, 1000, 4],
  ]);
  let out;
  try {
    out = execFileSync(process.execPath,
      [path.join(ROOT, "compare.mjs"), "--root", dir, "--b", "vantage/w/raw", "--day", DAY, ...(strict ? ["--strict"] : [])],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { out = String(e.stdout ?? "") + String(e.stderr ?? ""); }
  return { name, out, forgiven: /relabelling minute\(s\)/.test(out), reported: /node set differs/.test(out) };
};

console.log("── a clean suffix flip is forgiven ──");
{
  const r = scenario("flip", NEW, 1000, 4);
  check("counted as a relabelling", r.forgiven, r.out.trim().split("\n").slice(-6).join(" | "));
  check("not reported as a node-set difference", !r.reported);

  // The escape hatch must reach the rule.
  const st = scenario("flip under strict", NEW, 1000, 4, true);
  check("--strict reports it instead", st.reported && !st.forgiven);
}

console.log("── remove one reason to forgive, and it is reported again ──");
{
  const r = scenario("stake moved", NEW, 1001, 4);
  check("stake differs by even 1 SOL — reported", r.reported && !r.forgiven);
}
{
  const r = scenario("validators moved", NEW, 1000, 5);
  check("validator count differs — reported", r.reported && !r.forgiven);
}
{
  const r = scenario("different region", ["ams-mainnet-bam-1-tee", "lon-mainnet-bam-1-tee"], 1000, 4);
  check("a different region — reported", r.reported && !r.forgiven);
}
{
  const r = scenario("unconventional name", ["ams-mainnet-bam-2-tee", "fra-mainnet-bam-dev-tee"], 1000, 4);
  check("a name outside the convention — reported", r.reported && !r.forgiven);
}
{
  const r = scenario("extra node", [...NEW, "sea-mainnet-bam-1-tee"], 1000, 4);
  check("an extra node in a region A does not have — reported", r.reported && !r.forgiven);
}

console.log(fails ? `\nsynthetic relabel: ${fails} check(s) FAILED` : "\nsynthetic relabel: all checks passed");
process.exit(fails ? 1 : 0);
