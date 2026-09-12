// Pin the evidence behind the review, including the inconsistencies that make
// this more than a clean rename. Do not let a broader relabel rule swallow it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const cents = value => Math.round(value * 100);
const nodeSum = r => r.nodes.reduce((sum, n) => sum + cents(n.node_stake), 0);
const names = r => r.nodes.map(n => n.bam_node).sort();
const captures = {};
for (const [vantage, base, sha] of [
  ["primary", "", "bf02dad1c3b96b04cd365c53cc8fad1b325f50ce326ed30079473fdc47142e5e"],
  ["ams", "vantage/ams/", "d1d3819da7f027f9664f102ac6b41f78c7a0779c75ed65d09b60d499db3b2eb8"],
  ["sin", "vantage/sin/", "62b9857d917769c62a5e681b80bb206b5fa2a7a43e3e6f21cc76e24dc4637e18"],
]) {
  const rel = base + "raw/2026/09/09.jsonl.zst";
  const buf = fs.readFileSync(path.join(ROOT, rel));
  assert.equal(crypto.createHash("sha256").update(buf).digest("hex"), sha);
  const entry = fs.readFileSync(path.join(ROOT, base + "MANIFEST.tsv"), "utf8")
    .split(/\r?\n/).find(line => line.split("\t")[1] === rel);
  assert.equal(entry?.split("\t")[0], sha);
  captures[vantage] = zlib.zstdDecompressSync(buf).toString().trim().split("\n").map(JSON.parse);
  assert.equal(captures[vantage].length, 1440);
}
const at = (v, min) => captures[v].find(r => r.ts.startsWith("2026-09-09T" + min));
const a = at("primary", "17:53"), b = at("ams", "17:53"), s = at("sin", "17:53");
assert.equal(a.ts, "2026-09-09T17:53:19Z");
assert.equal(b.ts, "2026-09-09T17:53:31Z");
assert.deepEqual([a.nodes.length, b.nodes.length, s.nodes.length], [16, 17, 16]);
const sortedValidators = r => [...r.validators].sort((x, y) => x.validator_pubkey.localeCompare(y.validator_pubkey));
assert.equal(a.validators.length, 377);
assert.deepEqual(sortedValidators(a), sortedValidators(b));
assert.deepEqual(sortedValidators(a), sortedValidators(s));
assert.deepEqual(names(b).filter(n => !names(a).includes(n)), ["sqq-mainnet-bam-1-tee"]);
for (const n of a.nodes) assert.deepEqual(b.nodes.find(x => x.bam_node === n.bam_node), n);
assert.equal(nodeSum(b) - nodeSum(a), cents(111750.25));
assert.equal(cents(a.stake.bam_stake), cents(149689732.54));
assert.equal(cents(b.stake.bam_stake), cents(149944019.20));
assert.equal(nodeSum(a) - cents(a.stake.bam_stake), cents(142536.43));
assert.equal(b.nodes.reduce((sum, n) => sum + n.connected_validators, 0), 378);
assert.equal(b.validators.some(v => v.bam_node_connection === "sqq-mainnet-bam-1-tee"), false);
for (const v of ["primary", "ams", "sin"]) {
  assert.equal(at(v, "17:54").validators.length, 379);
  assert.equal(at(v, "17:54").nodes.length, 19);
  assert.deepEqual(names(at(v, "18:06")), names(at("primary", "18:06")));
}
for (const strict of [false, true]) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "compare.mjs"), "--day", "2026-09-09",
    "--b", "vantage/ams/raw", ...(strict ? ["--strict"] : [])], { cwd: ROOT, encoding: "utf8" });
  assert.ifError(r.error);
  assert.equal(r.status, strict ? 1 : 0, r.stdout + r.stderr);
  assert.match(r.stdout, /2026-09-09T17:53\s+node set differs \(\+sqq-mainnet-bam-1-tee in B\)/);
  if (!strict) assert.match(r.stdout, /reviewed 2026-09-11/);
  else assert.doesNotMatch(r.stdout, /reviewed 2026-09-11/);
}
console.log("September 9: archive hashes, endpoint lag, recovery, visible review and strict failure verified.");
