#!/usr/bin/env node
/* Test van de routeplanner-graaf (route.js) tegen de echte data:
   decoderen van net.json.gz, snappen, A*-route en bruggen-op-route.
   Draaien: node scripts/test_route_graph.js  (vanuit de repo-root of scripts/) */
"use strict";
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const root = path.join(__dirname, "..");

/* globals die route.js verwacht (alleen wat de pure graaffuncties nodig hebben) */
global.window = global;
global.LANG = "nl";
global.DATA = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, "data/static.json.gz"))));
global.fetchGz = () => { throw new Error("niet nodig in test"); };
global.mastVal = () => null;

eval(fs.readFileSync(path.join(root, "route.js"), "utf8"));
const RP = window.RoutePlanner._test;

const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, "data/net.json.gz"))));
RP.loadRaw(raw);
const snap = RP.snapFn();

let fails = 0;
function check(naam, cond, extra) {
  console.log((cond ? "OK  " : "FOUT") + " " + naam + (extra ? "  (" + extra + ")" : ""));
  if (!cond) fails++;
}

/* 1. Rottemeren -> Hollandsche IJssel (bekende route, met de hand geverifieerd) */
{
  const sa = snap(Math.round(52.005e5), Math.round(4.556e5));
  const sb = snap(Math.round(51.977e5), Math.round(4.656e5));
  check("snap start/eind gevonden", !!sa && !!sb);
  const r = RP.findRoute(sa, sb);
  check("route gevonden", !!r);
  if (r) {
    const km = r.meters / 1000;
    check("lengte ~13,7 km", km > 12.5 && km < 15, km.toFixed(1) + " km");
    const items = RP.objsOnRoute(r.geo);
    const namen = items.map(i => i.o.n);
    check("Snellesluis op route", namen.includes("Snellesluis"));
    check("Zevenhuizer Verlaat op route", namen.some(n => n.includes("Zevenhuizer Verlaat")));
    check("±22 objecten", items.length >= 18 && items.length <= 26, items.length + " objecten");
    const oplopend = items.every((it, i) => i === 0 || it.along >= items[i - 1].along);
    check("volgorde oplopend", oplopend);
    const sluizen = items.filter(i => i.o.t === "S").length;
    check("2 sluizen", sluizen === 2, sluizen + " sluizen");
  }
}

/* 2. Lange route dwars door het land */
{
  const sa = snap(Math.round(52.375e5), Math.round(4.905e5));   // Amsterdam Oosterdok
  const sb = snap(Math.round(53.216e5), Math.round(6.57e5));    // Groningen
  const r = sa && sb && RP.findRoute(sa, sb);
  check("Amsterdam->Groningen gevonden", !!r);
  if (r) check("lengte plausibel (150-400 km)", r.meters > 150e3 && r.meters < 400e3,
               (r.meters / 1000).toFixed(0) + " km");
}

/* 3. Zelfde kant: kort stukje op één vaarweg */
{
  const sa = snap(Math.round(51.96e5), Math.round(4.52e5));     // Rotte zuid
  const sb = snap(Math.round(51.963e5), Math.round(4.523e5));   // Rotte iets verderop
  const r = sa && sb && RP.findRoute(sa, sb);
  check("korte route zelfde vaarweg", !!r && r.meters < 2000, r ? Math.round(r.meters) + " m" : "geen");
}

/* 4-7. Open water staat uit (OPEN_WATER=False in build_net.py): routes die
   alleen over een meer kunnen, horen nu géén route op te leveren in plaats van
   een verzonnen lijn dwars over een dijk. Zet je open water weer aan, herstel
   dan ook deze controles (zie git-geschiedenis). */
{
  const sa = snap(Math.round(52.700e5), Math.round(5.300e5));   // Enkhuizen
  const sb = snap(Math.round(52.880e5), Math.round(5.360e5));   // Stavoren
  const r = sa && sb && RP.findRoute(sa, sb);
  check("IJsselmeer-oversteek geeft geen route (open water uit)", !r);
}
{
  const raw = JSON.parse(require("zlib").gunzipSync(
    require("fs").readFileSync(require("path").join(root, "data/net.json.gz"))));
  const verzonnen = raw.e.filter(e => e.length > 4 && e[4]).length;
  check("netwerk bevat geen zelfgemaakte verbindingen", verzonnen === 0, verzonnen + " gevonden");
}

/* 8. Onbereikbaar: punt ver op zee snapt niet */
{
  const s = snap(Math.round(54.5e5), Math.round(4.0e5));
  check("punt op open zee snapt niet", s === null);
}

process.exit(fails ? 1 : 0);
