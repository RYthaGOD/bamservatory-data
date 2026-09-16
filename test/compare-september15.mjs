import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
const root=fileURLToPath(new URL("../",import.meta.url));
const rows=[];
for(const [base,hash] of [
 ["","a4333b0a34f90cd1602c6bdfc261ac6eede697515c90c5e782d6cd911ccc5975"],
 ["vantage/ams/","5950869bebdbd106cdbd9d60bc19da5c93233dd7483f84564942b4461cf6ed08"],
 ["vantage/sin/","639d9db75d23be0b955ada5bce72cef8721b1d0096f2eb74be100e213c5059e9"]]){
 const rel=base+"raw/2026/09/15.jsonl.zst",buf=fs.readFileSync(root+rel);
 assert.equal(crypto.createHash("sha256").update(buf).digest("hex"),hash);
 assert.equal(fs.readFileSync(root+base+"MANIFEST.tsv","utf8").split(/\r?\n/).find(l=>l.split("\t")[1]===rel)?.split("\t")[0],hash);
 rows.push(zlib.zstdDecompressSync(buf).toString().trim().split("\n").map(JSON.parse));
}
const at=(i,m)=>rows[i].find(r=>r.ts.startsWith("2026-09-15T"+m));
const names=r=>r.nodes.map(n=>n.bam_node).sort();
const sum=r=>r.nodes.reduce((s,n)=>s+Math.round(n.node_stake*100),0);
const a=at(0,"23:52"),b=at(1,"23:52"),s=at(2,"23:52");
assert.deepEqual([a.ts,b.ts,s.ts],["2026-09-15T23:52:43Z","2026-09-15T23:52:48Z","2026-09-15T23:52:44Z"]);
assert.deepEqual([a.validators.length,b.validators.length,s.validators.length],[384,383,383]);
assert.deepEqual([a.nodes.length,b.nodes.length,s.nodes.length],[17,17,18]);
assert.deepEqual(names(s).filter(n=>!names(a).includes(n)),["ams-mainnet-bam-1-tee"]);
for(const n of a.nodes) assert.deepEqual(s.nodes.find(w=>w.bam_node===n.bam_node),n);
assert.equal(sum(s)-sum(a),21735196);
for(const r of [a,b,s]) assert.equal(r.stake.bam_stake,151338541.41);
assert.equal(sum(s),15155589336);
const missing=a.validators.filter(v=>!s.validators.some(w=>v.validator_pubkey===w.validator_pubkey));
assert.equal(missing.length,1);
const key="GwHH8ciFhR8vejWCqmg8FWZUCNtubPY2esALvy5tBvji";
assert.equal(missing[0].validator_pubkey,key);
assert.equal(missing[0].stake,217351.96);
assert.equal(missing[0].bam_node_connection,"ams-mainnet-bam-1-tee");
for(let i=0;i<3;i++){
 const r=at(i,"23:53");
 assert.equal(r.validators.length,384);
 assert.deepEqual(names(r),names(at(0,"23:53")));
 assert.equal(r.validators.find(v=>v.validator_pubkey===key).bam_node_connection,"ams-mainnet-bam-2-tee");
}
for(const strict of [false,true]){
 const r=spawnSync(process.execPath,["compare.mjs","--day","2026-09-15","--b","vantage/sin/raw",...(strict?["--strict"]:[])],{cwd:root,encoding:"utf8"});
 assert.ifError(r.error);
 assert.equal(r.status,strict?1:0,r.stdout+r.stderr);
 assert.match(r.stdout,/2026-09-15T23:52\s+node set differs/);
 if(strict) assert.doesNotMatch(r.stdout,/reviewed 2026-09-16/);
 else assert.match(r.stdout,/reviewed 2026-09-16/);
}
console.log("September 15: pinned evidence, endpoint lag, recovery and strict failure verified.");
