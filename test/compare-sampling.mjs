// What compare.mjs excuses as sampling, and what it must not.
//
// Two rules, both in compare.mjs: a witness that saw less of one node for one
// capture, and a witness that matches a torn primary capture's node list. The
// synthetic half builds the smallest archives that isolate each condition, so
// removing any one of them from compare.mjs fails a case here. The real half
// replays archived days without REVIEWED.tsv, so the answer is what the rules
// do, not what was signed off.
//
//   node test/compare-sampling.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-sampling-"));
process.on("exit", () => fs.rmSync(WORK, { recursive: true, force: true }));

let fails = 0;
const check = (label, ok, detail = "") => {
  if (ok) console.log(`  ok    ${label}`);
  else { console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); fails++; }
};

const compare = (root, args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [path.join(ROOT, "compare.mjs"), "--root", root, ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) { return { code: e.status, out: String(e.stdout ?? "") + String(e.stderr ?? "") }; }
};

// ── synthetic ────────────────────────────────────────────────────────────────

const DAY = "2026-10-06";
const FULL = {
  "ams-mainnet-bam-1-tee": [60, 60, 60, 60, 60],
  "fra-mainnet-bam-2-tee": [50, 50],
  "hkg-mainnet-bam-2-tee": [40, 40],
  "lon-mainnet-bam-1-tee": [30],
};

// A capture is a node -> validator-stakes map. Node entries are derived from it
// unless `entries` overrides one; the headline is the sum unless `header` is set.
const capture = (ts, spec, { entries = {}, header, extraNodes = [] } = {}) => {
  const nodes = Object.entries(spec).map(([name, vals]) => ({
    bam_node: name, region: name,
    connected_validators: entries[name]?.cv ?? vals.length,
    node_stake: entries[name]?.stake ?? vals.reduce((s, v) => s + v, 0),
  }));
  for (const n of extraNodes) nodes.push({ bam_node: n, region: n, connected_validators: 0, node_stake: 0 });
  const validators = Object.entries(spec).flatMap(([name, vals]) =>
    vals.map((s, i) => ({ validator_pubkey: `${name}-${i}`, bam_node_connection: name, stake: s, stake_percentage: 0 })));
  const sum = nodes.reduce((s, n) => s + n.node_stake, 0);
  return JSON.stringify({ ts, stake: { bam_stake: header ?? sum, bam_stake_percentage: 30 }, nodes, validators });
};

const without = (spec, node) => Object.fromEntries(Object.entries(spec).filter(([n]) => n !== node));
const withVals = (spec, node, vals) => ({ ...spec, [node]: vals });

const writeVantage = (dir, rel, lines) => {
  const p = path.join(dir, rel, "2026", "10");
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "06.jsonl.zst"), zlib.zstdCompressSync(Buffer.from(lines.join("\n") + "\n")));
};

// A is whole at 12:00, 12:01 and 12:02 unless `a` replaces it. B is whole either
// side of the case under test at 12:01 unless `before`/`after` replace them; null
// leaves that minute out.
const scenario = ({ b, a, before = capture(`${DAY}T12:00:10Z`, FULL), after = capture(`${DAY}T12:02:10Z`, FULL), strict = false }) => {
  const dir = fs.mkdtempSync(path.join(WORK, "s-"));
  writeVantage(dir, "raw", a ?? [
    capture(`${DAY}T12:00:30Z`, FULL), capture(`${DAY}T12:01:30Z`, FULL), capture(`${DAY}T12:02:30Z`, FULL),
  ]);
  writeVantage(dir, "vantage/w/raw", [before, b, after].filter(Boolean));
  const r = compare(dir, ["--b", "vantage/w/raw", "--day", DAY, ...(strict ? ["--strict"] : [])]);
  return { ...r, excused: /12:01 .*\n\s+└ sampling/.test(r.out), failed: r.code !== 0 };
};

const at = (spec, opts) => capture(`${DAY}T12:01:10Z`, spec, opts);
const tail = (r) => r.out.trim().split("\n").slice(-6).join(" | ");

console.log("── one node short for one capture is excused ──");
{
  const r = scenario({ b: at(without(FULL, "hkg-mainnet-bam-2-tee")) });
  check("node absent entirely", r.excused && !r.failed, tail(r));
}
{
  const r = scenario({ b: at(withVals(FULL, "hkg-mainnet-bam-2-tee", [40])) });
  check("node at one of its two validators", r.excused && !r.failed, tail(r));
}
{
  // Four records gone: more than the validator tolerance, so there is a finding to excuse.
  const spec = withVals(FULL, "ams-mainnet-bam-1-tee", [60]);
  const r = scenario({ b: at(spec, { entries: { "ams-mainnet-bam-1-tee": { cv: 5, stake: 300 } } }) });
  check("validator list short on one node, node entry and headline whole", r.excused && !r.failed, tail(r));
}
{
  const r = scenario({ b: at(without(FULL, "hkg-mainnet-bam-2-tee")), strict: true });
  check("--strict reports it instead", !r.excused && r.failed);
}

console.log("── remove one reason to excuse it, and it is reported ──");
{
  const spec = without(withVals(FULL, "fra-mainnet-bam-2-tee", [50]), "hkg-mainnet-bam-2-tee");
  const r = scenario({ b: at(spec) });
  check("two nodes short at once", !r.excused && r.failed, tail(r));
}
{
  const r = scenario({ b: at(without(FULL, "hkg-mainnet-bam-2-tee"), { extraNodes: ["sea-mainnet-bam-1-tee"] }) });
  check("B lists a node A never did", !r.excused && r.failed, tail(r));
}
{
  const spec = without(FULL, "hkg-mainnet-bam-2-tee");
  const r = scenario({ b: at(spec, { entries: { "lon-mainnet-bam-1-tee": { cv: 1, stake: 30.01 } } }) });
  check("another node differs by one cent", !r.excused && r.failed, tail(r));
}
{
  const r = scenario({ b: at(without(FULL, "hkg-mainnet-bam-2-tee"), { header: 510 - 80 - 1 }) });
  check("headline short by more than the node held", !r.excused && r.failed, tail(r));
}
{
  const spec = withVals(FULL, "hkg-mainnet-bam-2-tee", [40]);
  const r = scenario({ b: at(spec, { entries: { "hkg-mainnet-bam-2-tee": { cv: 3, stake: 40 } } }) });
  check("the node's entry claims more validators than A gave it", !r.excused && r.failed, tail(r));
}
{
  const spec = withVals(FULL, "hkg-mainnet-bam-2-tee", [40, 40, 40]);
  const r = scenario({ b: at(spec, { entries: { "hkg-mainnet-bam-2-tee": { cv: 1, stake: 40 } } }) });
  check("the validator list holds more of the node than A's did", !r.excused && r.failed, tail(r));
}
{
  const r = scenario({ b: at(without(FULL, "hkg-mainnet-bam-2-tee"), { header: 511 }) });
  check("headline above A's", !r.excused && r.failed, tail(r));
}
{
  const r = scenario({ b: at(without(FULL, "hkg-mainnet-bam-2-tee")), after: capture(`${DAY}T12:02:10Z`, without(FULL, "hkg-mainnet-bam-2-tee")) });
  check("the absence lasts two captures", !r.excused && r.failed, tail(r));
}
{
  const r = scenario({ b: at(without(FULL, "hkg-mainnet-bam-2-tee")), before: null });
  check("no capture before it to show the node whole", !r.excused && r.failed, tail(r));
}

console.log("── a torn primary capture whose node list the witness matches ──");
{
  const short = without(FULL, "hkg-mainnet-bam-2-tee");
  const tornA = [
    capture(`${DAY}T12:00:30Z`, FULL),
    capture(`${DAY}T12:01:30Z`, short, { header: 510 }),
    capture(`${DAY}T12:02:30Z`, FULL),
  ];
  const r = scenario({ a: tornA, b: at(short), before: null });
  check("excused when A's headline disagrees with A's own node list", r.excused && !r.failed, tail(r));

  const coherentA = [...tornA];
  coherentA[1] = capture(`${DAY}T12:01:30Z`, FULL);
  const c = scenario({ a: coherentA, b: at(short), before: null });
  check("reported when A is coherent", !c.excused && c.failed, tail(c));

  const r2 = scenario({ a: tornA, b: at(short, { header: 429 }), before: null });
  check("reported when B is torn too", !r2.excused && r2.failed, tail(r2));
}

// ── real archive ─────────────────────────────────────────────────────────────

// Copies only the days needed, and no REVIEWED.tsv.
const realRoot = (days) => {
  const dir = fs.mkdtempSync(path.join(WORK, "real-"));
  for (const rel of ["raw", "vantage/ams/raw", "vantage/sin/raw"])
    for (const day of days) {
      const [y, m, d] = day.split("-");
      const src = path.join(ROOT, rel, y, m, `${d}.jsonl.zst`);
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(path.join(dir, rel, y, m), { recursive: true });
      fs.copyFileSync(src, path.join(dir, rel, y, m, `${d}.jsonl.zst`));
    }
  return dir;
};

console.log("── real: 2026-10-06 and 10-07, ten findings, all sampling ──");
{
  const dir = realRoot(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
  for (const day of ["2026-10-06", "2026-10-07"]) {
    const r = compare(dir, ["--day", day]);
    check(`${day} passes with no review ledger`, r.code === 0, tail(r));
    const s = compare(dir, ["--day", day, "--strict"]);
    check(`${day} still fails under --strict`, s.code !== 0);
  }
  const r = compare(dir, ["--day", "2026-10-06"]);
  check("10-06 Singapore 13:47 names the short validator list",
    /2026-10-06T13:47[^\n]*\n\s+└ sampling: hkg-mainnet-bam-2-tee 15 of 15 connected, 10 of 15 validator records/.test(r.out), tail(r));
}

console.log("── real: what must still fail ──");
{
  const dir = realRoot(["2026-08-11", "2026-08-12", "2026-08-13"]);
  const r = compare(dir, ["--day", "2026-08-12"]);
  check("08-12 outage: sin 04:18 and ams 04:21 still reported",
    /2026-08-12T04:18\s+node set differs(?![^\n]*\n\s+└ sampling)/.test(r.out) &&
    /2026-08-12T04:21\s+node set differs(?![^\n]*\n\s+└ sampling)/.test(r.out) && r.code !== 0, tail(r));
}
{
  const dir = realRoot(["2026-09-30", "2026-10-01", "2026-10-02"]);
  const r = compare(dir, ["--day", "2026-10-01"]);
  check("10-01 20:02: a node the witness held and the primary did not, still reported",
    /2026-10-01T20:02\s+node set differs \(\+hkg-mainnet-bam-2-tee in B\)(?![^\n]*\n\s+└ sampling)/.test(r.out) && r.code !== 0, tail(r));
}
{
  const dir = realRoot(["2026-09-22", "2026-09-23", "2026-09-24"]);
  const r = compare(dir, ["--day", "2026-09-23", "--b", "vantage/sin/raw"]);
  check("09-23 06:04: a torn witness capture, still reported",
    /2026-09-23T06:04\s+stake(?![^\n]*\n\s+└ sampling)/.test(r.out) && r.code !== 0, tail(r));
}

console.log(fails ? `\ncompare sampling: ${fails} check(s) FAILED` : "\ncompare sampling: all checks passed");
process.exit(fails ? 1 : 0);
