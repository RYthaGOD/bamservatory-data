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
    match(el, /"bam_node":"([^"]*)"/, m);            bn  = m[1]
    match(el, /"region":"([^"]*)"/, m);              rg  = m[1]
    match(el, /"connected_validators":([0-9]+)/, m); cv  = m[1]
    match(el, /"node_stake":([0-9.eE+-]+)/, m);      nst = m[1]
    ncount++
    NB[ncount]=bn; NRG[ncount]=rg; NCV[ncount]=cv; NSS[ncount]=nst; NSN[ncount]=nst+0
    total_node_stake += nst + 0
    if (nst + 0 > top_stake) { top_stake = nst + 0; top_node = bn }
  }
  hhi = 0
  for (i = 1; i <= ncount; i++) {
    share = (total_node_stake > 0) ? NSN[i] / total_node_stake * 100 : 0
    frac  = (total_node_stake > 0) ? NSN[i] / total_node_stake       : 0
    hhi  += frac * frac
    printf "%s,%s,%s,%s,%s,%.6f\n", ts, NB[i], NRG[i], NCV[i], NSS[i], share >> NODES
  }
  top_share = (total_node_stake > 0) ? top_stake / total_node_stake * 100 : 0

  # --- validators ---
  vcount = 0; connected = 0; total_val_stake = 0
  vv = split(vals_seg, VA, /\},\{/)
  for (i = 1; i <= vv; i++) {
    el = VA[i]; if (el == "") continue
    match(el, /"validator_pubkey":"([^"]*)"/, m); pk = m[1]
    if (match(el, /"bam_node_connection":"([^"]*)"/, m)) conn = m[1]; else conn = ""
    match(el, /"stake":([0-9.eE+-]+)/, m);            stk  = m[1]
    match(el, /"stake_percentage":([0-9.eE+-]+)/, m); spct = m[1]
    vcount++
    total_val_stake += stk + 0
    if (conn != "") connected++
    printf "%s,%s,%s,%s,%s\n", ts, pk, conn, stk, spct >> VALS
  }
  unconnected = vcount - connected

  printf "%s,%s,%s,%d,%d,%d,%d,%.2f,%.2f,%s,%.6f,%.6f\n", \
    ts, bam_stake, bam_pct, ncount, vcount, connected, unconnected, \
    total_node_stake, total_val_stake, top_node, top_share, hhi >> SUMMARY
}
