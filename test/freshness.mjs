import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFreshness, fetchMetrics } from "../check-freshness.mjs";

const NOW = Date.parse("2026-09-11T13:30:00Z");
const good = () => ({
  generatedAt: "2026-09-11T13:20:00Z", schemaVersion: 4,
  window: { to: "2026-09-11T13:19:00Z" },
  verification: { latest: { ts: "2026-09-11T13:18:00Z" } },
  daily: [
    { date: "2026-09-09", bamStakePct: 34.1, captures: 1440 },
    { date: "2026-09-10", bamStakePct: 34.2, captures: 1438 },
  ],
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
test("daily cannot be missing, stale, unfinished, malformed, or out of order", () => {
  for (const [label, edit] of [
    ["missing", (m) => delete m.daily],
    ["empty", (m) => m.daily = []],
    ["stale by a day", (m) => m.daily.pop()],
    ["publishing the day in progress", (m) => m.daily.push({ date: "2026-09-11", bamStakePct: 34.3, captures: 800 })],
    ["null value", (m) => m.daily[1].bamStakePct = null],
    ["zero", (m) => m.daily[1].bamStakePct = 0],
    ["over 100", (m) => m.daily[1].bamStakePct = 120],
    ["bad date", (m) => m.daily[1].date = "10 Sep"],
    ["out of order", (m) => m.daily.reverse()],
    ["duplicated day", (m) => m.daily[0].date = "2026-09-10"],
  ]) {
    const m = good(); edit(m);
    assert.ok(checkFreshness(m, NOW).errors.some((e) => e.startsWith("daily")), label);
  }
});
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
