# Flatten compact BAM snapshot JSONL into three live CSV datasets.
#
# One input line = one captured snapshot (the compact JSON written to
# ticks.jsonl). Emits, via append (>>), one row per snapshot to SUMMARY,
# one row per node to NODES, and one row per validator to VALS.
#
# Raw API fields are written through verbatim (no float reformatting) to
# preserve source precision; only derived metrics (shares, totals, HHI) are
# computed here.
#
# Required -v vars: SUMMARY, NODES, VALS (output file paths).
# Optional -v vars: PREV_NODES, PREV_VALS (counts from the previous summary row),
#                   STREAK_FILE, SKIPLOG, ACCEPT_FILE — see the partial-response
#                   guard below.

# Make a value safe to write into an unquoted CSV field.
#
# These outputs have no quoting or escaping — every consumer splits on commas
# and reads fixed positions. A name carrying a comma therefore does not corrupt
# itself, it shifts every field after it: node_stake_share and node_stake_hhi
# would be read from the wrong columns and published as measurements.
#
# BAM names nodes {city}-mainnet-bam-{n}-tee and validator keys are base58, so
# this should never fire. It exists because the failure is silent and lands in
# the derived statistics rather than anywhere that would look wrong, and the
# true value is preserved verbatim in the raw archive regardless.
function csvsafe(s) {
  gsub(/[,"\r\n]/, "_", s)
  return s
}

# How many captures in a row have been withheld as partial. Kept in a file
# because this script is invoked once per capture and remembers nothing itself.
function readstreak(  s, line) {
  s = 0
  if (STREAK_FILE != "" && (getline line < STREAK_FILE) > 0) s = line + 0
  if (STREAK_FILE != "") close(STREAK_FILE)
  return s
}
function writestreak(v) {
  if (STREAK_FILE == "") return
  printf "%d\n", v > STREAK_FILE
  close(STREAK_FILE)
}

# The operator's way of saying a collapse is real. Its presence is the whole
# message, so an empty file counts: getline returns 0 for that and -1 only when
# the file cannot be opened.
function accepted(  line, r) {
  if (ACCEPT_FILE == "") return 0
  r = (getline line < ACCEPT_FILE)
  close(ACCEPT_FILE)
  return r >= 0
}
function consumeaccept(  q) {
  q = ACCEPT_FILE
  gsub(/'/, "'\\''", q)
  system("rm -f '" q "'")
}
function skiplog(msg) {
  if (SKIPLOG == "") return
  print msg >> SKIPLOG
  close(SKIPLOG)
}

{
  line = $0
  if (line ~ /^[ \t]*$/) next

  # One line, one capture.
  #
  # A record written twice with no newline between them is still one line, and
  # everything below parses by regex rather than by JSON — so the segment
  # boundaries run straight through both copies and the counts come out summed.
  # raw/2026/06/29 carries exactly that: 2026-06-29T04:04:58Z appears twice in a
  # single 120 KB line, and re-flattening it yields a row claiming 771 validators
  # and 282M SOL, against 380 and 141M either side of it.
  #
  # A JSON parser rejects the line outright, which is why this went unseen: every
  # consumer that reads the archive properly skips it, and only this one, which
  # reads it by pattern, is fooled. The published series never contained the row
  # — so the effect was that re-deriving the series from the archive produced one
  # row the original did not have, in the artifact whose whole claim is that the
  # two agree.
  #
  # gsub returns the match count and, replacing each match with itself, leaves
  # the line untouched.
  if (gsub(/"ts":"/, "&", line) > 1) {
    if (SKIPLOG != "") {
      printf "%s malformed capture withheld — %d records concatenated into one line\n", \
        substr(line, 8, 20), gsub(/"ts":"/, "&", line) >> SKIPLOG
      close(SKIPLOG)
    }
    next
  }

  match(line, /"ts":"([^"]+)"/, m);                     ts       = m[1]
  match(line, /"bam_stake":([0-9.eE+-]+)/, m);          bam_stake = m[1]
  match(line, /"bam_stake_percentage":([0-9.eE+-]+)/, m); bam_pct  = m[1]

  # Slice out the nodes[...] and validators[...] segments. Element objects
  # contain no ']' so the array boundaries are unambiguous.
  ns = index(line, "\"nodes\":[")
  vs = index(line, "],\"validators\":[")
  nodes_seg = substr(line, ns + 8, vs - (ns + 8))   # 8 = len('"nodes":[')
  vals_seg  = substr(line, vs + 16)                 # 16 = len('],"validators":[')
  sub(/\]\}[ \t]*$/, "", vals_seg)

  # A capture that came back with no nodes at all is a degraded response, not an
  # observation that BAM has no nodes. The public API returned exactly this 16
  # times between 2026-07-30 and 2026-08-04: valid JSON, empty arrays, zero
  # stake.
  #
  # Emitting a row for it put "BAM holds 0% of Solana stake" into the published
  # series as though it were measured, which dragged the site's own minimum
  # statistics to zero. Worse, the split below does not yield an empty list for
  # an empty array — the leftover bracket survives as a single element — so the
  # record was counted as one node with a blank name.
  #
  # The raw capture is still archived either way, so nothing is hidden: the
  # empty response remains in the record, and the effect here is a gap in
  # coverage, which is true, instead of a false measurement.
  if (nodes_seg !~ /"bam_node"/) {
    next
  }

  # --- nodes ---
  ncount = 0; total_node_stake = 0; top_stake = -1; top_node = ""
  delete NB; delete NRG; delete NCV; delete NSS; delete NSN
  nn = split(nodes_seg, NA, /\},\{/)
  for (i = 1; i <= nn; i++) {
    el = NA[i]; if (el == "") continue
    match(el, /"bam_node":"([^"]*)"/, m);            bn  = csvsafe(m[1])
    match(el, /"region":"([^"]*)"/, m);              rg  = csvsafe(m[1])
    match(el, /"connected_validators":([0-9]+)/, m); cv  = m[1]
    match(el, /"node_stake":([0-9.eE+-]+)/, m);      nst = m[1]
    ncount++
    NB[ncount]=bn; NRG[ncount]=rg; NCV[ncount]=cv; NSS[ncount]=nst; NSN[ncount]=nst+0
    total_node_stake += nst + 0
    if (nst + 0 > top_stake) { top_stake = nst + 0; top_node = bn }
  }
  # Rows are buffered rather than written as they are computed. The completeness
  # check below needs the validator count, which is not known until the whole
  # record has been read — and a check that fires after half the rows are already
  # on disk protects nothing.
  hhi = 0
  delete NOUT
  for (i = 1; i <= ncount; i++) {
    share = (total_node_stake > 0) ? NSN[i] / total_node_stake * 100 : 0
    frac  = (total_node_stake > 0) ? NSN[i] / total_node_stake       : 0
    hhi  += frac * frac
    NOUT[i] = sprintf("%s,%s,%s,%s,%s,%.6f", ts, NB[i], NRG[i], NCV[i], NSS[i], share)
  }
  top_share = (total_node_stake > 0) ? top_stake / total_node_stake * 100 : 0

  # --- validators ---
  vcount = 0; connected = 0; total_val_stake = 0
  delete VOUT
  vv = split(vals_seg, VA, /\},\{/)
  for (i = 1; i <= vv; i++) {
    el = VA[i]; if (el == "") continue
    match(el, /"validator_pubkey":"([^"]*)"/, m); pk = csvsafe(m[1])
    if (match(el, /"bam_node_connection":"([^"]*)"/, m)) conn = csvsafe(m[1]); else conn = ""
    match(el, /"stake":([0-9.eE+-]+)/, m);            stk  = m[1]
    match(el, /"stake_percentage":([0-9.eE+-]+)/, m); spct = m[1]
    vcount++
    total_val_stake += stk + 0
    if (conn != "") connected++
    VOUT[vcount] = sprintf("%s,%s,%s,%s,%s", ts, pk, conn, stk, spct)
  }
  unconnected = vcount - connected

  # A partial response is not a smaller network.
  #
  # The API has served coherent but incomplete views: 2026-07-29T19:12:06Z came
  # back with 10 nodes and 235 validators where the surrounding captures saw 15
  # and ~380. Everything inside it agreed — the headline stake matched the sum of
  # its own nodes and validators — so nothing about the record looked wrong. It
  # entered the series as an observation, dragged the published minimum node
  # count to 10, and four minutes later the "missing" nodes reappeared and were
  # read as six new nodes arriving at once, firing region signals and two
  # cutovers that never happened.
  #
  # Internal consistency therefore cannot separate a partial view from a real
  # one. Persistence can: a genuine change to BAM stays changed, while a partial
  # read is corrected on the next capture. So a collapse against the previous
  # capture is withheld — but only MAX_SKIP times in a row. If the smaller
  # network is still there after that, it is the network, and it is recorded.
  #
  # The bound matters more than the threshold. Withholding indefinitely would let
  # one bad comparison freeze the series permanently, which is a worse failure
  # than the one being prevented: the collector would go on publishing a network
  # that no longer exists and nothing would look broken.
  #
  # The raw capture is archived either way. What is withheld here is the
  # interpretation, never the record.
  #
  # Without STREAK_FILE there is nowhere to count consecutive withholdings, so
  # the release above could never fire and a sustained drop would be withheld
  # for as long as it lasted. The guard therefore does not run at all when no
  # state file is given — as when the archive is re-flattened by hand. Letting a
  # partial row through is recoverable; dropping an unbounded run of real ones
  # during a rebuild is not.
  RATIO = 0.8
  MAX_SKIP = 2
  # A collapse is not a smaller network either, and persistence cannot tell the
  # two apart.
  #
  # The bounded release above assumes a failed read corrects itself within a
  # couple of captures. On 2026-10-21 one did not: from 01:20Z the API served a
  # single dev node holding one validator and 519,552 SOL, against 16 nodes, 375
  # validators and 159.8M SOL a capture earlier, while Kobe went on reporting 375
  # validators running BAM. The two holds ran out, the third capture was
  # recorded as observed, and the dashboard published BAM at 0.12% of Solana
  # stake, run by one node, for as long as the API stayed broken.
  #
  # Below COLLAPSE of the previous capture there is no release on persistence.
  # BAM losing three quarters of its nodes or validators inside one capture
  # interval is not a change any rollover, relabelling or outage on record has
  # come close to — the worst real partial view, 2026-07-29, kept 62% of its
  # validators — and if it ever happens for real, it is an event a person should
  # confirm rather than one a counter should wave through.
  #
  # The objection to withholding indefinitely, above, was that a frozen series
  # looks healthy. It no longer does: check-freshness.mjs fails once the newest
  # capture in the published window is 90 minutes old, and that failure is the
  # alert. So a collapse is held until the API recovers, which needs no one, or
  # until an operator creates ACCEPT_FILE, which records the next collapsed
  # capture as observed and is then removed. Acceptance answers the collapse in
  # front of it only: a file found while nothing is collapsing is removed
  # unused, so one left behind cannot wave through the next incident unseen.
  #
  # Between COLLAPSE and RATIO the bounded release still applies, so a genuine
  # halving is recorded after two captures exactly as before.
  COLLAPSE = 0.25
  guarded = (STREAK_FILE != "" && PREV_NODES + 0 > 0 && PREV_VALS + 0 > 0)
  collapse = (guarded && (ncount < PREV_NODES * COLLAPSE || vcount < PREV_VALS * COLLAPSE))
  if (accepted()) {
    consumeaccept()
    if (collapse) {
      skiplog(sprintf("%s collapse accepted by operator — recording it as observed (%d/%d nodes, %d/%d validators vs previous capture)", \
        ts, ncount, PREV_NODES, vcount, PREV_VALS))
    } else {
      skiplog(sprintf("%s operator acceptance discarded unused — no collapse to accept", ts))
    }
  } else if (collapse) {
    # Keeps the words "partial response withheld" so every withheld capture is
    # counted the same way downstream, whichever rule withheld it.
    streak = readstreak()
    writestreak(streak + 1)
    skiplog(sprintf("%s partial response withheld (%d/%d nodes, %d/%d validators vs previous capture; collapse, hold %d, no release until the API recovers or an operator accepts it)", \
      ts, ncount, PREV_NODES, vcount, PREV_VALS, streak + 1))
    next
  } else if (guarded && (ncount < PREV_NODES * RATIO || vcount < PREV_VALS * RATIO)) {
    streak = readstreak()
    if (streak < MAX_SKIP) {
      writestreak(streak + 1)
      skiplog(sprintf("%s partial response withheld (%d/%d nodes, %d/%d validators vs previous capture; skip %d of %d)", \
        ts, ncount, PREV_NODES, vcount, PREV_VALS, streak + 1, MAX_SKIP))
      next
    }
    # Held for MAX_SKIP captures and still low: treat it as real from here on.
    #
    # Deliberately does not repeat the word "withheld" — this line records the
    # opposite decision, and a log where the two cannot be told apart by a plain
    # search is a log that will be miscounted by whoever next tries.
    skiplog(sprintf("%s reduced capture persisted past %d holds — recording it as observed (%d nodes, %d validators)", \
      ts, MAX_SKIP, ncount, vcount))
  }
  writestreak(0)

  for (i = 1; i <= ncount; i++) print NOUT[i] >> NODES
  for (i = 1; i <= vcount; i++) print VOUT[i] >> VALS
  close(NODES); close(VALS)

  printf "%s,%s,%s,%d,%d,%d,%d,%.2f,%.2f,%s,%.6f,%.6f\n", \
    ts, bam_stake, bam_pct, ncount, vcount, connected, unconnected, \
    total_node_stake, total_val_stake, top_node, top_share, hhi >> SUMMARY
  close(SUMMARY)
}
