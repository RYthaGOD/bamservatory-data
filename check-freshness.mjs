// Shared by the full verification workflow and the separate hourly monitor.
// A recent publication alone does not prove its underlying captures are recent.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function checkFreshness(m, now = Date.now()) {
  const errors = [], readings = [];
  for (const [name, value] of [
    ["generatedAt", m?.generatedAt],
    ["window.to", m?.window?.to],
    ["verification.latest.ts", m?.verification?.latest?.ts],
  ]) {
    const ts = typeof value === "string" ? Date.parse(value) : NaN;
    const age = (now - ts) / 60000;
    if (!Number.isFinite(age)) errors.push(`${name}: missing or invalid timestamp`);
    else {
      readings.push(`${name}: ${value} (${age.toFixed(1)} min old)`);
      if (age > 90) errors.push(`${name}: ${age.toFixed(1)} min old (limit 90)`);
      if (age < -5) errors.push(`${name}: more than 5 min in the future`);
    }
  }
  // `daily` is read by the Solana Foundation's data aggregator, which stores one
  // row per completed UTC day. Captures can be current while this field has
  // stopped advancing, and nothing above would notice; their chart would just
  // go flat. The newest row must be the day before the newest capture, because
  // the day in progress is never published.
  const daily = m?.daily;
  if (!Array.isArray(daily) || !daily.length) errors.push("daily: missing or empty");
  else {
    const bad = daily.find((d, i) =>
      !/^\d{4}-\d{2}-\d{2}$/.test(d?.date ?? "") || !(d.bamStakePct > 0 && d.bamStakePct < 100) ||
      (i > 0 && !(d.date > daily[i - 1]?.date)));
    if (bad) errors.push(`daily: malformed or out-of-order row ${JSON.stringify(bad)}`);
    const to = Date.parse(m?.window?.to);
    const last = daily[daily.length - 1]?.date;
    if (Number.isFinite(to)) {
      const want = new Date(to - 86_400_000).toISOString().slice(0, 10);
      if (last !== want) errors.push(`daily: newest row is ${last}, expected ${want} (the day before window.to)`);
      else readings.push(`daily: ${daily.length} rows through ${last}`);
    }
  }
  if (!Number.isInteger(m?.schemaVersion) || m.schemaVersion < 1) errors.push("missing schemaVersion");
  for (const key of ["collector", "archive"])
    if (typeof m?.provenance?.[key] !== "string" || !m.provenance[key]) errors.push(`missing provenance.${key}`);
  for (const key of ["summary.csv", "nodes.csv", "detections.log"])
    if (!/^sha256:[a-f0-9]{64}$/i.test(m?.provenance?.inputs?.[key] ?? "")) errors.push(`invalid digest for ${key}`);
  return { errors, readings };
}

export async function fetchMetrics(url, { fetcher = fetch, sleep = delay } = {}) {
  // Retry transport/HTTP/JSON errors. A valid but stale response is evaluated
  // once below: retries must not turn old data into a pass.
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const r = await fetcher(url, { cache: "no-store", signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (attempt === 6) throw e;
      await sleep(10_000);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const m = await fetchMetrics("https://rythagod.github.io/bamservatory/metrics.json");
    const { errors, readings } = checkFreshness(m);
    for (const line of readings) console.log(line);
    for (const error of errors) console.error(`FAIL: ${error}`);
    if (errors.length) process.exitCode = 1;
    else console.log("Publication, capture, verification, and provenance checks passed.");
  } catch (e) {
    console.error(`Cannot check live metrics: ${e.message}`);
    process.exitCode = 1;
  }
}
