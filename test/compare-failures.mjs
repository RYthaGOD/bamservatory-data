// A successful comparison must actually check data, including findings after
// the old ten-item display limit. These cases reproduce false green results.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../compare.mjs", import.meta.url));
const DAY = "2026-09-09";
const capture = (i, name = "ams-mainnet-bam-1-tee") => ({
  ts: `${DAY}T12:${String(i).padStart(2, "0")}:10Z`,
  stake: { bam_stake: 1000 }, nodes: [{ bam_node: name }], validators: [{}],
});
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bam-compare-check-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const write = (rel, rows) => {
    const p = path.join(dir, rel, "2026/09/09.jsonl.zst");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, zlib.zstdCompressSync(Buffer.from(rows.map(JSON.stringify).join("\n") + "\n")));
    return p;
  };
  const run = (...args) => {
    const r = spawnSync(process.execPath, [SCRIPT, "--root", dir, ...args], { encoding: "utf8" });
    assert.ifError(r.error);
    return { status: r.status, out: r.stdout + r.stderr };
  };
  return { dir, write, run };
}

test("missing witnesses cannot pass --all", t => {
  const f = fixture(t); f.write("raw", [capture(0)]);
  assert.notEqual(f.run("--all").status, 0);
});
test("an incorrect witness path cannot pass a requested day", t => {
  const f = fixture(t); f.write("raw", [capture(0)]); f.write("vantage/ams/raw", [capture(0)]);
  assert.notEqual(f.run("--day", DAY, "--b", "vantage/typo/raw").status, 0);
});
test("every selected witness must have overlapping data", t => {
  const f = fixture(t); f.write("raw", [capture(0)]); f.write("vantage/ams/raw", [capture(0)]);
  fs.mkdirSync(path.join(f.dir, "vantage/sin/raw"), { recursive: true });
  assert.notEqual(f.run("--all").status, 0);
});
test("days with no shared minutes fail", t => {
  const f = fixture(t); f.write("raw", [capture(0)]); f.write("vantage/ams/raw", [capture(30)]);
  assert.notEqual(f.run("--all").status, 0);
});
test("unreadable and malformed captures fail", t => {
  const f = fixture(t); f.write("raw", [capture(0)]);
  const p = f.write("vantage/ams/raw", [capture(0)]);
  fs.writeFileSync(p, "not zstd");
  assert.notEqual(f.run("--all").status, 0);
  f.write("vantage/ams/raw", [{ ...capture(0), stake: {} }]);
  assert.notEqual(f.run("--all").status, 0);
  fs.writeFileSync(p, zlib.zstdCompressSync(Buffer.from("{broken json\n")));
  assert.notEqual(f.run("--all").status, 0);
});
test("an eleventh unreviewed finding cannot hide behind ten reviewed findings", t => {
  const f = fixture(t);
  f.write("raw", Array.from({ length: 12 }, (_, i) => capture(i)));
  f.write("vantage/ams/raw", Array.from({ length: 12 }, (_, i) => capture(i, "fra-mainnet-bam-1-tee")));
  fs.writeFileSync(path.join(f.dir, "REVIEWED.tsv"), Array.from({ length: 10 }, (_, i) =>
    `ams\t${capture(i).ts.slice(0, 16)}\t2026-09-11\tTest review`).join("\n"));
  const r = f.run("--all");
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /2026-09-09T12:10\s+node set differs/);
});
test("invalid tolerances cannot disable numerical checks", t => {
  const f = fixture(t); f.write("raw", [capture(0)]); f.write("vantage/ams/raw", [capture(0)]);
  for (const value of ["NaN", "Infinity", "-1"])
    assert.notEqual(f.run("--all", "--stake-tolerance", value).status, 0);
});
test("a real agreement still succeeds", t => {
  const f = fixture(t); f.write("raw", [capture(0)]); f.write("vantage/ams/raw", [capture(0)]);
  assert.equal(f.run("--all").status, 0);
});
