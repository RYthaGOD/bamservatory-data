// Has BAM published an attestation surface yet?
//
// This project's largest stated limit is that membership originates with Jito.
// A BAM-produced block is indistinguishable from any other on chain, because BAM
// changes how a block is assembled and not what ends up in it, so "which
// validators run BAM" is a claim by Jito that no amount of cross-checking turns
// into a derivation. BAM describes its ordering attestations as a public audit
// trail; when an endpoint serves them, that limit closes.
//
// Both READMEs carry that limit as prose with a hand-written date attached —
// "re-checked 2026-08-09". A date maintained by memory is wrong from the first
// week nobody remembers, and it is wrong in the direction that matters: it would
// go on saying no endpoint exists after one appeared, so the project would keep
// publishing a weaker claim than the truth and never notice the thing it has
// been waiting for.
//
// So the check runs on a schedule and writes down what it found. A 404 is the
// expected result and is not a failure; the point is the date attached to it.
//
//   node probe-attestations.mjs --out /data/capture/attestations.json
//
// Paths are guesses, deliberately. There is no published API surface to consult,
// so this probes the shapes an attestation endpoint would plausibly take on the
// host that already serves BAM's other public data. A hit needs a human to look
// at it, which is why a positive result is loud.

import fs from "node:fs";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = arg("--out", "attestations.json");
const BASE = arg("--bam", process.env.BAM_API_BASE || "https://explorer.bam.dev/api/v1");

const CANDIDATES = [
  "/attestations", "/attestation", "/proofs", "/ordering_attestations",
  "/schedules", "/plugins", "/tee", "/enclave",
];

// A known-good path, so a total outage is distinguishable from "still nothing".
// Without it, every endpoint being unreachable would be recorded as the same
// result as every endpoint being absent — and the day BAM's API is simply down
// would read as evidence about attestations.
const CONTROL = "/validators";

const probe = async (path) => {
  try {
    const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(20000) });
    const body = r.ok ? (await r.text()).slice(0, 400) : null;
    return { path, status: r.status, ok: r.ok, sample: body };
  } catch (e) {
    return { path, status: null, ok: false, error: e.message };
  }
};

const main = async () => {
  const control = await probe(CONTROL);
  const results = [];
  for (const p of CANDIDATES) results.push(await probe(p));

  const found = results.filter((r) => r.ok);
  const out = {
    checkedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    base: BASE,
    // If the control failed, this run establishes nothing about attestations.
    // Recording that plainly is the difference between "we looked and there was
    // nothing" and "we could not look".
    reachable: control.ok,
    attestationsAvailable: control.ok && found.length > 0,
    endpointsFound: found.map((r) => r.path),
    probed: results.map(({ path, status }) => ({ path, status })),
  };

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");

  if (!control.ok) {
    console.log(`attestation probe: BAM API unreachable (control ${CONTROL} -> ${control.status ?? control.error}) — result inconclusive`);
    return;
  }
  if (out.attestationsAvailable) {
    console.log(`attestation probe: ENDPOINT FOUND — ${out.endpointsFound.join(", ")}`);
    console.log("attestation probe: this closes the project's largest stated limit. Look at it.");
    for (const r of found) console.log(`  ${r.path} -> ${String(r.sample).slice(0, 200)}`);
    return;
  }
  console.log(`attestation probe: none of ${CANDIDATES.length} candidate paths served attestations (checked ${out.checkedAt})`);
};

main().catch((e) => {
  console.error(`attestation probe failed: ${e.message}`);
  process.exit(0);   // Never costs a capture; this is informational.
});
