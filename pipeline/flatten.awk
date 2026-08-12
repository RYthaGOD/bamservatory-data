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
#                   STREAK_FILE, SKIPLOG — see the partial-response guard below.

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

{
  line = $0
  if (line ~ /^[ \t]*$/) next

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
  RATIO = 0.8
  MAX_SKIP = 2
  if (PREV_NODES + 0 > 0 && PREV_VALS + 0 > 0 &&
      (ncount < PREV_NODES * RATIO || vcount < PREV_VALS * RATIO)) {
    streak = readstreak()
    if (streak < MAX_SKIP) {
      writestreak(streak + 1)
      if (SKIPLOG != "") {
        printf "%s partial response withheld (%d/%d nodes, %d/%d validators vs previous capture; skip %d of %d)\n", \
          ts, ncount, PREV_NODES, vcount, PREV_VALS, streak + 1, MAX_SKIP >> SKIPLOG
        close(SKIPLOG)
      }
      next
    }
    # Held for MAX_SKIP captures and still low: treat it as real from here on.
    if (SKIPLOG != "") {
      printf "%s reduced capture persisted past %d withheld captures — recording it as observed (%d nodes, %d validators)\n", \
        ts, MAX_SKIP, ncount, vcount >> SKIPLOG
      close(SKIPLOG)
    }
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
