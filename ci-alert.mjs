// Turn a red CI run into one GitHub issue that mentions the owner, and close it
// when the workflow next goes green.
//
// Why this exists: from 2026-09-22 to 2026-10-04 the verify badge was red on
// nine unreviewed cross-vantage findings and nobody knew for twelve days, and on
// 2026-09-24/25 the freshness check failed seven runs in a row while the
// verification source returned HTTP 403 — also unseen. GitHub's own failure
// emails go only to whoever last edited the cron, and the local watcher only
// runs while someone has a session open. Both checks did their job; nothing
// carried the result to a person.
//
// One notification per incident, not per run. While the issue is open, further
// red runs only rewrite its "Latest red run" line, and editing an issue does not
// notify anyone. A green run closes it with a comment, the second and last
// notification. A run where every job was skipped says nothing either way and
// changes nothing.
//
// Run as the last job of a workflow, after every job it reports on:
//
//   NEEDS='${{ toJSON(needs) }}' WORKFLOW=verify node ci-alert.mjs
//
// with GH_TOKEN (issues: write), GITHUB_REPOSITORY, RUN_URL, EVENT and OWNER set.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LABEL = "ci-red";

// A timed-out job is reported as cancelled, and the 2026-08-18 three-hour apt
// hang is exactly the kind of red this has to carry, so cancelled counts.
export function verdict(needs) {
  const results = Object.entries(needs ?? {}).map(([job, n]) => [job, n?.result]);
  const red = results.filter(([, r]) => r === "failure" || r === "cancelled");
  if (red.length) return { state: "red", red };
  if (results.some(([, r]) => r === "success")) return { state: "green", red };
  return { state: "unknown", red };
}

const bodyFor = (owner, workflow, line) => `@${owner} — \`${workflow}\` is red.

First red run: ${line}
Latest red run: ${line}

This issue was opened by the workflow itself and closes itself on the next green
run. Until then, later red runs only update the line above, so this is one
notification per incident rather than one per run.

How to read it:
- **cross-vantage agreement** — usually a minute the collectors disagree about
  that nobody has reviewed yet. Check it against the raw captures; if it is
  understood, add a \`REVIEWED.tsv\` entry (the file's header gives the rules).
- **published data is current** — the live site, the capture, the verification
  run or the \`daily\` series stopped advancing. The run log names which.
- anything else — the archive or a pipeline guard; the run log names the check.
`;

export function alert({ env, gh, now = new Date() }) {
  const repo = ["--repo", env.GITHUB_REPOSITORY];
  const v = verdict(JSON.parse(env.NEEDS || "{}"));
  const title = `CI red: ${env.WORKFLOW}`;
  const open = JSON.parse(gh(["issue", "list", ...repo, "--state", "open", "--label", LABEL,
    "--json", "number,title,body", "--limit", "100"]) || "[]").find((i) => i.title === title);
  const failed = v.red.map(([job, r]) => `${job} (${r})`).join(", ");
  const line = `${env.RUN_URL} (${env.EVENT}, ${now.toISOString()}) — ${failed}`;

  if (v.state === "red") {
    if (!open) {
      gh(["label", "create", LABEL, ...repo, "--color", "B60205", "--force",
        "--description", "Opened and closed by CI when a workflow goes red"]);
      gh(["issue", "create", ...repo, "--title", title, "--label", LABEL,
        "--body", bodyFor(env.OWNER, env.WORKFLOW, line)]);
      return "opened";
    }
    const body = open.body.replace(/^Latest red run: .*$/m, `Latest red run: ${line}`);
    if (body !== open.body) gh(["issue", "edit", String(open.number), ...repo, "--body", body]);
    return "updated";
  }
  if (v.state === "green" && open) {
    gh(["issue", "close", String(open.number), ...repo, "--comment",
      `Green again: ${env.RUN_URL} (${env.EVENT}, ${now.toISOString()}).`]);
    return "closed";
  }
  return "unchanged";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const key of ["NEEDS", "WORKFLOW", "GITHUB_REPOSITORY", "RUN_URL", "EVENT", "OWNER"])
    if (!process.env[key]) { console.error(`ci-alert: ${key} is not set`); process.exit(2); }
  const gh = (args) => execFileSync("gh", args, { encoding: "utf8" });
  console.log(`ci-alert: ${alert({ env: process.env, gh })} (${process.env.WORKFLOW})`);
}
