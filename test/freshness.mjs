import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFreshness, fetchMetrics } from "../check-freshness.mjs";

const NOW = Date.parse("2026-09-11T13:30:00Z");
const good = () => ({
  generatedAt: "2026-09-11T13:20:00Z", schemaVersion: 4,
  window: { to: "2026-09-11T13:19:00Z" },
  verification: { latest: { ts: "2026-09-11T13:18:00Z" } },
  provenance: { collector: "collector", archive: "archive", inputs:
    Object.fromEntries(["summary.csv", "nodes.csv", "detections.log"].map(k => [k, "sha256:" + "a".repeat(64)])) },
});
test("current data passes", () => assert.deepEqual(checkFreshness(good(), NOW).errors, []));
for (const [name, set] of [
  ["publication", (m, v) => m.generatedAt = v],
  ["capture", (m, v) => m.window.to = v],
  ["verification", (m, v) => m.verification.latest.ts = v],
]) {
  test(`${name} cannot be missing, invalid, stale, or future-dated`, () => {
    for (const value of [undefined, "nonsense", "2026-09-11T11:00:00Z", "2026-09-12T13:20:00Z"]) {
      const m = good(); set(m, value);
      assert.ok(checkFreshness(m, NOW).errors.length > 0, `${name}: ${value}`);
    }
  });
}
test("malformed payloads and provenance fail", () => {
  for (const m of [null, {}, { ...good(), schemaVersion: 0 }, { ...good(), provenance: {} }])
    assert.ok(checkFreshness(m, NOW).errors.length);
  const m = good(); m.provenance.inputs["nodes.csv"] = "sha256:";
  assert.ok(checkFreshness(m, NOW).errors.length);
});
test("HTTP failures are retried, but bounded", async () => {
  let attempts = 0;
  const m = await fetchMetrics("unused", { sleep: async () => {}, fetcher: async () => {
    attempts++;
    return attempts < 3 ? { ok: false, status: 503 } : { ok: true, json: async () => good() };
  } });
  assert.equal(attempts, 3); assert.deepEqual(m, good());
  attempts = 0;
  await assert.rejects(fetchMetrics("unused", { sleep: async () => {}, fetcher: async () => {
    attempts++; throw new Error("offline");
  } }), /offline/);
  assert.equal(attempts, 6);
});
