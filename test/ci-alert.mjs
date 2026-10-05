// What ci-alert.mjs does with each kind of run, against a fake `gh` that keeps
// issues in memory. The property that matters is the notification count: one
// when an incident starts, one when it ends, none in between.
import assert from "node:assert/strict";
import { test } from "node:test";
import { alert, verdict, LABEL } from "../ci-alert.mjs";

const env = (needs, workflow = "verify") => ({
  NEEDS: JSON.stringify(needs), WORKFLOW: workflow, GITHUB_REPOSITORY: "o/r",
  RUN_URL: "https://example/run", EVENT: "schedule", OWNER: "RYthaGOD",
});
const red = { "cross-vantage": { result: "failure" }, freshness: { result: "success" } };
const green = { "cross-vantage": { result: "success" }, freshness: { result: "success" } };

// Calls that would notify someone: creating an issue and commenting (close
// --comment). Editing a body and listing do not.
function fakeGh() {
  const issues = [];
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    const val = (flag) => args[args.indexOf(flag) + 1];
    if (args[0] === "issue" && args[1] === "list")
      return JSON.stringify(issues.filter((i) => i.open && i.labels.includes(val("--label"))));
    if (args[0] === "issue" && args[1] === "create") {
      issues.push({ number: issues.length + 1, title: val("--title"), body: val("--body"), labels: [val("--label")], open: true });
      return "";
    }
    if (args[0] === "issue" && args[1] === "edit") { issues.find((i) => i.number === +args[2]).body = val("--body"); return ""; }
    if (args[0] === "issue" && args[1] === "close") { issues.find((i) => i.number === +args[2]).open = false; return ""; }
    if (args[0] === "label") return "";
    throw new Error("unexpected gh call " + args.join(" "));
  };
  const notifications = () => calls.filter((a) => a[0] === "issue" && (a[1] === "create" || a.includes("--comment"))).length;
  return { gh, issues, calls, notifications };
}

test("a failure or a cancellation is red; skips alone say nothing", () => {
  assert.equal(verdict(red).state, "red");
  assert.equal(verdict({ a: { result: "cancelled" }, b: { result: "success" } }).state, "red");
  assert.equal(verdict(green).state, "green");
  assert.equal(verdict({ a: { result: "skipped" } }).state, "unknown");
  assert.equal(verdict({}).state, "unknown");
});

test("an incident is one issue, one mention, and one close", () => {
  const f = fakeGh();
  assert.equal(alert({ env: env(red), gh: f.gh }), "opened");
  assert.equal(f.issues.length, 1);
  assert.equal(f.issues[0].title, "CI red: verify");
  assert.deepEqual(f.issues[0].labels, [LABEL]);
  assert.match(f.issues[0].body, /^@RYthaGOD/);
  assert.match(f.issues[0].body, /cross-vantage \(failure\)/);

  // Red again: the body moves on, nobody is notified, no second issue.
  const later = new Date("2026-10-06T00:00:00Z");
  assert.equal(alert({ env: env(red), gh: f.gh, now: later }), "updated");
  assert.equal(f.issues.length, 1);
  assert.match(f.issues[0].body, /Latest red run: .*2026-10-06T00:00:00/);
  assert.doesNotMatch(f.issues[0].body, /First red run: .*2026-10-06/);

  assert.equal(alert({ env: env(green), gh: f.gh }), "closed");
  assert.equal(f.issues[0].open, false);
  assert.equal(f.notifications(), 2);

  // A new incident after recovery is a new issue, not a reopened one.
  assert.equal(alert({ env: env(red), gh: f.gh }), "opened");
  assert.equal(f.issues.length, 2);
});

test("green with nothing open, or a run that skipped everything, changes nothing", () => {
  const f = fakeGh();
  assert.equal(alert({ env: env(green), gh: f.gh }), "unchanged");
  alert({ env: env(red), gh: f.gh });
  assert.equal(alert({ env: env({ a: { result: "skipped" } }), gh: f.gh }), "unchanged");
  assert.equal(f.issues[0].open, true, "no information must not close an incident");
});

test("each workflow has its own incident", () => {
  const f = fakeGh();
  alert({ env: env(red, "verify"), gh: f.gh });
  assert.equal(alert({ env: env(red, "freshness"), gh: f.gh }), "opened");
  assert.equal(alert({ env: env(green, "freshness"), gh: f.gh }), "closed");
  assert.deepEqual(f.issues.map((i) => [i.title, i.open]), [["CI red: verify", true], ["CI red: freshness", false]]);
});
