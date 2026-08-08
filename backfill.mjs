// One-off backfill of raw capture history into the archive.
//
// The dashboard has published figures derived from captures going back to
// 2026-06-20, but the raw records behind them only ever existed on the machine
// that gathered them. Until they are published, every historical claim on the
// site rests on data nobody outside can inspect — which is the one thing a
// third-party verifier cannot afford.
//
// Reads the capture log a line at a time and emits exactly what the live
// pipeline emits: one zstd file per completed UTC day under raw/YYYY/MM/DD, one
// SHA-256 line per day in MANIFEST.tsv. verify.sh cannot tell the difference,
// which is the point — backfilled history and live history must be the same
// kind of artifact, checked the same way.
//
//   node backfill.mjs --log <ticks.jsonl> --archive <repo> [--through YYYY-MM-DD]
//
// Safe to re-run: days already in the manifest are left untouched, so an
// interrupted run resumes rather than rewriting history it already published.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import readline from "node:readline";

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};

const LOG = arg("--log", "d:/bam-net-ticks/ticks.jsonl");
const ARCHIVE = arg("--archive", ".");
const THROUGH = arg("--through", null); // last day to archive, inclusive
const MANIFEST = path.join(ARCHIVE, "MANIFEST.tsv");
const COLLECTOR = arg("--collector", "0fcd020edfd9d71e7c36d971dad47ba88442a520");

if (!fs.existsSync(LOG)) {
  console.error(`capture log not found: ${LOG}`);
  process.exit(1);
}

// Days already published. Re-emitting one would either be a no-op or a silent
// revision of something a third party may already have verified, and the
// manifest is meant to be append-only.
const already = new Set();
if (fs.existsSync(MANIFEST)) {
  for (const line of fs.readFileSync(MANIFEST, "utf8").split("\n")) {
    const [, rel] = line.split("\t");
    if (rel && rel.startsWith("raw/")) {
      already.add(rel.replace(/^raw\//, "").replace(/\.jsonl\.zst$/, "").replace(/\//g, "-"));
    }
  }
}
if (!fs.existsSync(MANIFEST)) {
  fs.writeFileSync(MANIFEST, "sha256\tpath\trecords\tfirst_ts\tlast_ts\tarchived_at\tcollector\n");
}

// ts is the first field of every record, so the day is a fixed-offset slice.
// Parsing the JSON to read one field would cost hours across a log this size.
const dayOf = (line) => line.slice(7, 17);
const tsOf = (line) => line.slice(7, 27);

const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);

let current = null;   // { day, chunks[], bytes, records, firstTs, lastTs }
const written = [];
let skipped = 0, malformed = 0, totalRecords = 0;

const flush = () => {
  if (!current || current.records === 0) return;
  const { day, chunks, records, firstTs, lastTs } = current;
  current = null;

  if (already.has(day)) { skipped++; return; }
  if (THROUGH && day > THROUGH) return;

  const [y, m, d] = day.split("-");
  const rel = `raw/${y}/${m}/${d}.jsonl.zst`;
  const out = path.join(ARCHIVE, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  // Level 19 to match `zstd -19` in archive.sh. The bytes will not be identical
  // to the CLI's — that does not matter, since each file is hashed as it is
  // written and any valid zstd stream decompresses the same.
  const raw = Buffer.from(chunks.join(""), "utf8");
  const comp = zlib.zstdCompressSync(raw, {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 },
  });
  fs.writeFileSync(out, comp);

  const sha = crypto.createHash("sha256").update(comp).digest("hex");
  fs.appendFileSync(
    MANIFEST,
    `${sha}\t${rel}\t${records}\t${firstTs}\t${lastTs}\t${new Date().toISOString().replace(/\.\d+Z$/, "Z")}\t${COLLECTOR}\n`
  );

  const pct = ((records / 1440) * 100).toFixed(1);
  console.log(
    `  ${day}  ${String(records).padStart(5)} rec  ${pct.padStart(5)}%  ` +
    `${(raw.length / 1048576).toFixed(1)}MB → ${(comp.length / 1048576).toFixed(2)}MB  ${sha.slice(0, 12)}`
  );
  written.push({ day, records, bytes: comp.length });
};

const rl = readline.createInterface({
  input: fs.createReadStream(LOG, { highWaterMark: 1 << 22 }),
  crlfDelay: Infinity,
});

console.log(`reading ${LOG}`);
console.log("  day        records  coverage   raw → zstd        sha256");

for await (const line of rl) {
  if (!line) continue;
  const day = dayOf(line);
  if (!isDay(day)) { malformed++; continue; }
  totalRecords++;

  // Records arrive in capture order, so a change of day closes the previous
  // one. Buffering a single day at a time is what keeps a 2.3 GB log within
  // ordinary memory.
  if (!current || current.day !== day) {
    flush();
    current = { day, chunks: [], records: 0, firstTs: null, lastTs: null };
  }
  current.chunks.push(line, "\n");
  current.records++;
  current.firstTs ??= tsOf(line);
  current.lastTs = tsOf(line);
}
flush();

const totalBytes = written.reduce((a, w) => a + w.bytes, 0);
console.log();
console.log(`records read      ${totalRecords}`);
console.log(`days written      ${written.length}`);
console.log(`days skipped      ${skipped} (already in manifest)`);
if (malformed) console.log(`malformed lines   ${malformed}`);
console.log(`archive size      ${(totalBytes / 1048576).toFixed(1)} MB`);
