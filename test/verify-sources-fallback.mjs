// verify-sources.mjs reads on-chain stake from a configured RPC endpoint, and a
// public one if that will not answer. Its other rule is unchanged and matters as
// much: when no source can be read, the run writes no row, because a gap in
// coverage is true and a row of zeroes would be a measurement that never
// happened. Both are asserted here against the real script, with every source
// served from a local mock.
import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../pipeline/verify-sources.mjs", import.meta.url));
const SOL = 1e9;
const VOTES = { current: [
  { nodePubkey: "A", activatedStake: 100 * SOL },
  { nodePubkey: "B", activatedStake: 50 * SOL },
  { nodePubkey: "C", activatedStake: 250 * SOL },
], delinquent: [] };

// Each RPC path answers as its scenario says and counts the calls it gets.
async function withSources(rpc, fn) {
  const hits = {};
  const server = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] ?? 0) + 1;
    const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/bam/validators") return send(200, [{ validator_pubkey: "A", stake: 100 }, { validator_pubkey: "B", stake: 50 }]);
    if (req.url === "/bam/bam_stake") return send(200, { bam_stake: 150, bam_stake_percentage: 37.5 });
    if (req.url === "/kobe/api/v1/validators") return send(200, [
      { identity_account: "A", running_bam: true, active_stake: 100 * SOL },
      { identity_account: "B", running_bam: true, active_stake: 50 * SOL },
      { identity_account: "C", running_bam: false, active_stake: 250 * SOL },
    ]);
    const answer = rpc[req.url];
    if (answer === "403") return send(403, { error: "forbidden" });
    if (answer === "rpc-error") return send(200, { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "node is behind" } });
    if (answer === "ok") return send(200, { jsonrpc: "2.0", id: 1, result: VOTES });
    send(404, {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base, hits); } finally { server.close(); }
}

const run = (base, { fallback } = {}) => new Promise((resolve) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-sources-"));
  const out = path.join(dir, "verification.csv");
  const env = { ...process.env, SOLANA_RPC_URL: "", VERIFY_EVIDENCE: "" };
  if (fallback === undefined) delete env.SOLANA_RPC_FALLBACK_URL;
  else env.SOLANA_RPC_FALLBACK_URL = fallback;
  execFile(process.execPath, [SCRIPT, "--out", out, "--bam", `${base}/bam`, "--kobe", `${base}/kobe`, "--rpc", `${base}/primary`],
    { env }, (err, stdout, stderr) => {
      const csv = fs.existsSync(out) ? fs.readFileSync(out, "utf8").trim().split("\n") : null;
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ code: err ? err.code : 0, stdout, stderr, csv });
    });
});

// Failure is asserted as nonzero rather than 1: die() calls process.exit while
// fetch sockets are still open, which Node on Windows reports as a crash code.
// Linux, where this runs, exits 1. Either way no row may be written.
const onchainShare = (csv) => {
  const header = csv[0].split(","), row = csv[1].split(",");
  return row[header.indexOf("bam_share_onchain_pct")];
};

test("a 403 from the configured endpoint falls back and still records the row", () =>
  withSources({ "/primary": "403", "/fallback": "ok" }, async (base, hits) => {
    const r = await run(base, { fallback: `${base}/fallback` });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.csv.length, 2);
    assert.equal(onchainShare(r.csv), "37.5000");   // 150 of 400 SOL
    assert.match(r.stdout, /vote accounts from fallback 127\.0\.0\.1:\d+; .*HTTP 403/);
    assert.equal(hits["/primary"], 1);
  }));

test("a JSON-RPC error is no answer either", () =>
  withSources({ "/primary": "rpc-error", "/fallback": "ok" }, async (base) => {
    const r = await run(base, { fallback: `${base}/fallback` });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /node is behind/);
  }));

test("a working endpoint is used alone", () =>
  withSources({ "/primary": "ok", "/fallback": "ok" }, async (base, hits) => {
    const r = await run(base, { fallback: `${base}/fallback` });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(hits["/fallback"], undefined);
    assert.doesNotMatch(r.stdout, /fallback/);
  }));

test("when every endpoint fails, nothing is written", () =>
  withSources({ "/primary": "403", "/fallback": "403" }, async (base) => {
    const r = await run(base, { fallback: `${base}/fallback` });
    assert.notEqual(r.code, 0);
    assert.equal(r.csv, null);
    assert.match(r.stderr, /primary -> HTTP 403; .*fallback -> HTTP 403/);
  }));

test("an empty SOLANA_RPC_FALLBACK_URL disables the fallback", () =>
  withSources({ "/primary": "403", "/fallback": "ok" }, async (base, hits) => {
    const r = await run(base, { fallback: "" });
    assert.notEqual(r.code, 0);
    assert.equal(r.csv, null);
    assert.equal(hits["/fallback"], undefined);
  }));
