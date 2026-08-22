// What compare.mjs forgives, and what it must not.
//
// The cross-vantage check fails on any node-set difference, which is the right
// default — two collectors reading the same API should see the same nodes. But
// BAM renames its whole fleet every few days, swapping every node's -1/-2
// suffix, and a rename that takes longer than one capture leaves the vantages
// describing different instants of the same transition. Ten relabellings are
// on record and they are getting more frequent.
//
// So compare.mjs excuses a node-set difference when it is relabel-shaped, and
// this asserts the shape is narrow enough to be worth having. Both directions,
// against real captures from the archive:
//
//   2026-08-18  ams  a relabelling in flight          MUST be forgiven
//   2026-08-12  sin  a torn read during an outage     MUST still fail
//   2026-08-12  ams  the recovery after that outage   MUST still fail
//
// The second and third are what stop this being a rule that forgives anything
// inconvenient. On 2026-08-12 the vantages held genuinely different regions —
// one had sin, the other tyo — which is not a rename however much it resembles
// one at a glance.
//
// And --strict must still show the forgiven minutes. A rule that decided
// something was not a finding at all would otherwise place itself beyond the one
// escape hatch a sceptical reader has.
//
//   node test/compare-relabel.mjs

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let fails = 0;
const check = (label, ok, detail = "") => {
  if (ok) console.log(`  ok    ${label}`);
  else { console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); fails++; }
};

// `strict` defaults on for the cases that must fail, so REVIEWED.tsv cannot mask
// the answer: the question is what the rule does, not what was signed off after.
const run = (day, b, strict = true) => {
  const args = [path.join(ROOT, "compare.mjs"), "--day", day, "--b", b];
  if (strict) args.push("--strict");
  try {
    return execFileSync(process.execPath, args,
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return String(e.stdout ?? "") + String(e.stderr ?? "");
  }
};

const tail = (out) => out.trim().split("\n").slice(-8).join(" | ");

console.log("── a relabelling in flight is forgiven ──");
{
  const out = run("2026-08-18", "vantage/ams/raw", false);
  check("the two transition minutes are counted as relabelling",
    /2 relabelling minute\(s\)/.test(out), tail(out));
  check("neither is reported as a node-set difference",
    !/2026-08-18T21:5[23]\s+node set differs/.test(out));
  check("the day reads as full agreement", /2026-08-18\s+\d+\s+\d+ \(100\.0%\)/.test(out));
}

console.log("── but --strict still shows them ──");
{
  const out = run("2026-08-18", "vantage/ams/raw", true);
  check("--strict reports the relabelling rather than forgiving it",
    /2026-08-18T21:5[23]\s+node set differs/.test(out), tail(out));
  check("--strict fails the run", /Divergence found/.test(out));
}

console.log("── a torn read is NOT forgiven ──");
{
  const out = run("2026-08-12", "vantage/sin/raw");
  check("04:18 still reported", /2026-08-12T04:18\s+node set differs/.test(out));
  check("and the run still fails", /Divergence found/.test(out));
}

console.log("── an outage recovery is NOT forgiven ──");
{
  const out = run("2026-08-12", "vantage/ams/raw");
  check("04:21 still reported", /2026-08-12T04:21\s+node set differs/.test(out));
  check("20:56 — a node absent at one vantage — still reported",
    /2026-08-12T20:56\s+node set differs/.test(out));
  check("and the run still fails", /Divergence found/.test(out));
}

// The default path must not fail on either 08-12 day either — those minutes are
// covered by REVIEWED.tsv, and if that stopped being true this suite should not
// be the thing that hides it.
console.log("── and without --strict, the reviewed minutes are explained, not hidden ──");
{
  const out = run("2026-08-12", "vantage/sin/raw", false);
  check("the finding is still printed", /2026-08-12T04:18\s+node set differs/.test(out));
  check("with its review attached", /└ reviewed 2026-08-13/.test(out));
}

console.log(fails ? `\ncompare relabel: ${fails} check(s) FAILED` : "\ncompare relabel: all checks passed");
process.exit(fails ? 1 : 0);
