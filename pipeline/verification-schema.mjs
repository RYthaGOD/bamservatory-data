// The shape of verification.csv, every shape it has ever had, and the migration
// that carries a file written under an older one forward.
//
// Columns are grouped by what they measure rather than by when they were added,
// so both additions so far landed in the middle of a row rather than at the end.
// That grouping is what makes a row readable and is worth keeping — but it means
// a row cannot be interpreted by position alone unless you know which schema
// wrote it.
//
// So every header this file has ever had is recorded here, and each row is read
// under the one whose width matches its own. Reading old rows under the current
// header instead is not a smaller bug, it is a quieter one: it renames values
// rather than losing them. That happened. A migration keyed on the current
// header alone moved BAM's published stake into bam_share_reported_pct and wrote
// 141,537,711 into a column that means "per cent", and nothing about the file
// looked wrong afterwards.
//
// Adding a column: append a new entry with the full header as it will be
// written. Never edit an existing entry — those describe rows that already
// exist, so rewriting one changes the meaning of history rather than the shape
// of the future.

// ── schema history, oldest first ─────────────────────────────────────────────
const V1 = [
  "ts",
  "explorer_validators", "kobe_running_bam", "in_both",
  "only_explorer", "only_kobe", "disputed_stake_sol",
  "onchain_matched", "stake_reported_sol", "stake_onchain_sol",
  "stake_abs_diff_sol", "stake_max_rel_pct",
  "bam_share_reported_pct", "bam_share_onchain_pct",
];

// + BAM's own published headline, so the share tile compares against what BAM
//   states rather than against a restatement of our own figures.
const V2 = [
  "ts",
  "explorer_validators", "kobe_running_bam", "in_both",
  "only_explorer", "only_kobe", "disputed_stake_sol",
  "onchain_matched", "stake_reported_sol", "stake_onchain_sol",
  "stake_abs_diff_sol", "stake_max_rel_pct",
  "bam_headline_stake_sol", "bam_headline_share_pct",
  "bam_share_reported_pct", "bam_share_onchain_pct",
];

// + source-health counts, so a truncated Kobe response is auditable rather than
//   implicit, and the median deviation, because a max is decided by one outlier.
const V3 = [
  "ts",
  "explorer_validators", "kobe_running_bam", "in_both",
  "only_explorer", "only_kobe", "disputed_stake_sol",
  "kobe_total_validators", "chain_validators",
  "onchain_matched", "stake_reported_sol", "stake_onchain_sol",
  "stake_abs_diff_sol", "stake_max_rel_pct", "stake_median_rel_pct",
  "bam_headline_stake_sol", "bam_headline_share_pct",
  "bam_share_reported_pct", "bam_share_onchain_pct",
];

export const SCHEMAS = [V1, V2, V3];
export const COLUMNS = SCHEMAS[SCHEMAS.length - 1];
export const HEADER = COLUMNS.join(",");

// A row is identified by its width, so two schemas of the same width would be
// indistinguishable and every row of that width a coin toss. Checked at load
// rather than left as a rule someone has to remember.
{
  const widths = SCHEMAS.map((s) => s.length);
  if (new Set(widths).size !== widths.length) {
    throw new Error(`verification schemas must have distinct widths, got ${widths.join()}`);
  }
}

// ── row assembly ─────────────────────────────────────────────────────────────
// Rows are built by name. The row and the header are then the same list read two
// ways and cannot drift apart, which is the failure this module exists to
// prevent: a positional row builder and a separate header agree only for as long
// as whoever edits one remembers the other. They did not.
export function toLine(row, { strict = false } = {}) {
  if (strict) {
    const missing = COLUMNS.filter((c) => row[c] === undefined || row[c] === null);
    const extra = Object.keys(row).filter((k) => !COLUMNS.includes(k));
    if (missing.length) throw new Error(`row is missing ${missing.join()}`);
    if (extra.length) throw new Error(`row has unknown column(s) ${extra.join()}`);
  }
  return COLUMNS.map((c) => (row[c] ?? "")).join(",");
}

// ── invariants ───────────────────────────────────────────────────────────────
// True by construction, not judgements about what a normal reading looks like.
// A row that breaks one of these was not produced by any run of this collector,
// so it describes nothing that was ever measured.
//
// Deliberately absent: bounds on the *_rel_pct deviation columns. A validator
// whose reported stake is double the chain's gives 100%, and a check that
// discarded that would throw away the strongest finding this collector can make.
const isBlank = (x) => x === undefined || String(x).trim() === "";
const le = (a, b) => isBlank(a) || isBlank(b) || Number(a) <= Number(b);
const isShare = (x) => isBlank(x) || (Number(x) >= 0 && Number(x) <= 100);

const INVARIANTS = [
  ["ts is a timestamp", (r) => Number.isFinite(Date.parse(r.ts))],
  // matched is counted over BAM's own list, so it cannot exceed it.
  ["onchain_matched <= explorer_validators", (r) => le(r.onchain_matched, r.explorer_validators)],
  ["in_both <= explorer_validators", (r) => le(r.in_both, r.explorer_validators)],
  // A share of the network is a share of the network.
  ["shares are percentages", (r) =>
    isShare(r.bam_share_reported_pct) && isShare(r.bam_share_onchain_pct) && isShare(r.bam_headline_share_pct)],
];

// ── migration ────────────────────────────────────────────────────────────────
// Runs on every write, not only when the header changes. A file can hold rows
// that need repair while its header already reads correct — which is exactly the
// state a header-only migration leaves behind, having rewritten the header and
// misfiled the rows underneath it.
//
// Rows matching no schema, or breaking an invariant, are dropped rather than
// carried or guessed at: a gap in the series is true, whereas a row whose
// columns cannot be attributed is not a reading. Nothing is lost that the
// archive's own git history does not still hold.

// A byte-order mark on the first line would otherwise become part of the "ts"
// column name, and every lookup against it would miss.
const stripBom = (s) => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s);

// The file is written with "\n", but a copy that has been through a Windows
// editor comes back with "\r\n" and a trailing "\r" on every value.
const NEWLINE = /\r?\n/;

export function migrate(text) {
  const lines = stripBom(String(text)).split(NEWLINE).filter((l) => l.trim().length);
  const body = lines.length && lines[0].startsWith("ts,") ? lines.slice(1) : lines;

  const kept = [];
  const dropped = [];
  for (const line of body) {
    const cells = line.split(",");
    const schema = SCHEMAS.find((s) => s.length === cells.length);
    if (!schema) {
      dropped.push({ line, why: `${cells.length} columns match no schema this file has had` });
      continue;
    }
    const row = {};
    schema.forEach((name, i) => { row[name] = (cells[i] ?? "").trim(); });

    const broke = INVARIANTS.find(([, ok]) => !ok(row));
    if (broke) {
      dropped.push({ line, why: `fails "${broke[0]}"` });
      continue;
    }
    kept.push(toLine(row));
  }

  const out = [HEADER, ...kept].join("\n") + "\n";
  return { text: out, kept: kept.length, dropped, changed: out !== text };
}
