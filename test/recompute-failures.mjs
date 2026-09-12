import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const evidence = zlib.zstdDecompressSync(fs.readFileSync(path.join(ROOT, "verification/2026/09/09.jsonl.zst")))
  .toString().trim().split("\n")[0];
const ts = JSON.parse(evidence).ts;
const csv = fs.readFileSync(path.join(ROOT, "verification.csv"), "utf8").trim().split(/\r?\n/);
const row = csv.find(line => line.startsWith(ts + ","));
assert.ok(row, "the real evidence fixture must have a published row");

test("CI evidence checking cannot pass an empty, missing, malformed or changed input", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bam-recompute-check-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const run = () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "recompute.mjs"), "--root", dir, "--require-evidence"], { encoding: "utf8" });
    assert.ifError(r.error); return r;
  };
  assert.equal(run().status, 1, "no evidence must fail");
  fs.mkdirSync(path.join(dir, "verification"));
  const p = path.join(dir, "verification/day.jsonl.zst");
  const write = text => fs.writeFileSync(p, zlib.zstdCompressSync(Buffer.from(text + "\n")));
  write(evidence);
  assert.equal(run().status, 1, "evidence without its published row must fail");
  fs.writeFileSync(path.join(dir, "verification.csv"), csv[0] + "\n" + row + "\n");
  assert.equal(run().status, 0, "matching real evidence must pass");
  write(evidence + "\n{broken");
  assert.equal(run().status, 1, "a malformed archived record must fail even beside a valid one");
  write(evidence);
  const changed = row.split(","); changed[1] = String(Number(changed[1]) + 1);
  fs.writeFileSync(path.join(dir, "verification.csv"), csv[0] + "\n" + changed.join(",") + "\n");
  assert.equal(run().status, 1, "a changed published figure must fail");
});
