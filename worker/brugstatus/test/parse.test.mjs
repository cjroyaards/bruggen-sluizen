// Snelle parsertest tegen de live NDW-feeds: node test/parse.test.mjs
import { parseBridgeRecords } from "../src/index.js";
import { gunzipSync } from "node:zlib";

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + " " + r.status);
  return gunzipSync(Buffer.from(await r.arrayBuffer())).toString("utf8");
}
const t0 = Date.now();
const ab = await get("https://opendata.ndw.nu/actueel_beeld.xml.gz");
const open = parseBridgeRecords(ab);
console.log("actueel_beeld:", ab.length, "tekens,", open.length, "open bruggen,", Date.now() - t0, "ms");
for (const r of open.slice(0, 10)) console.log("  ", r.code, r.lat, r.lon, r.start, "→", r.end, r.prob, r.src);
const t1 = Date.now();
const pf = await get("https://opendata.ndw.nu/planningsfeed_brugopeningen.xml.gz");
const pl = parseBridgeRecords(pf);
console.log("planningsfeed:", pl.length, "records,", new Set(pl.map(r => r.code)).size, "bruggen,", Date.now() - t1, "ms");
const bad = [...open, ...pl].filter(r => !r.code || r.lat == null || !r.start);
console.log("records zonder code/coördinaat/start:", bad.length);
if (bad.length > pl.length * 0.05) { console.error("PARSER FOUT?"); process.exit(1); }
console.log("OK");
