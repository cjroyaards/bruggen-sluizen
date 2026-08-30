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

/* 4. Open water via de officiële betonde routes (RWS-vaarwegennetwerk) */
{
  const sa = snap(Math.round(52.700e5), Math.round(5.300e5));   // Enkhuizen
  const sb = snap(Math.round(52.880e5), Math.round(5.360e5));   // Stavoren
  const r = sa && sb && RP.findRoute(sa, sb);
  check("Enkhuizen->Stavoren over het IJsselmeer", !!r && r.meters > 18e3 && r.meters < 30e3,
        r ? (r.meters / 1000).toFixed(1) + " km" : "geen");
}

/* 5. Dijkcheck: de Houtribdijk mag alleen via de sluis */
{
  const sa = snap(Math.round(52.700e5), Math.round(5.300e5));
  const sb = snap(Math.round(52.517e5), Math.round(5.435e5));   // Lelystad
  const r = sa && sb && RP.findRoute(sa, sb);
  const sluizen = r ? RP.objsOnRoute(r.geo).filter(i => i.o.t === "S").map(i => i.o.n) : [];
  check("Houtribdijk via de Houtribsluizen", sluizen.some(n => /Houtrib|Krabbersgat/i.test(n)),
        sluizen.join(", ") || "geen sluizen");
}

/* 6. Zeeland: Willemstad -> Middelburg binnendoor */
{
  const sa = snap(Math.round(51.690e5), Math.round(4.436e5));
  const sb = snap(Math.round(51.500e5), Math.round(3.610e5));
  const r = sa && sb && RP.findRoute(sa, sb);
  const sluizen = r ? RP.objsOnRoute(r.geo).filter(i => i.o.t === "S").map(i => i.o.n) : [];
  check("Willemstad->Middelburg gevonden", !!r && r.meters > 60e3 && r.meters < 110e3,
        r ? (r.meters / 1000).toFixed(0) + " km" : "geen");
  check("route passeert de Volkeraksluizen", sluizen.includes("Volkeraksluizen"), sluizen.slice(0,4).join(", "));
}

/* 7. Friesland volgt het Prinses Margrietkanaal, niet de kleine vaarten */
{
  const sa = snap(Math.round(52.846e5), Math.round(5.709e5));   // Lemmer
  const sb = snap(Math.round(53.196e5), Math.round(5.795e5));   // Leeuwarden
  const r = sa && sb && RP.findRoute(sa, sb);
  check("Lemmer->Leeuwarden plausibel (40-60 km)", !!r && r.meters > 40e3 && r.meters < 60e3,
        r ? (r.meters / 1000).toFixed(1) + " km" : "geen");
}

/* 7b. Het netwerk komt uit de RWS-vaarwegdata, niet uit zelfgemaakte lijnen */
{
  const netraw = JSON.parse(require("zlib").gunzipSync(
    require("fs").readFileSync(require("path").join(root, "data/net.json.gz"))));
  check("netwerkversie 2 (RWS-secties)", netraw.v === 2, "v=" + netraw.v);
  const verzonnen = netraw.e.filter(e => e.length > 4 && e[4]).length;
  check("geen zelfgemaakte verbindingen", verzonnen === 0, verzonnen + " gevonden");
}

/* 7c. Lange overspanning: de Zeelandbrug wordt gemeld op routes die hem kruisen */
{
  const sa = snap(Math.round(51.515e5), Math.round(3.995e5));   // Wemeldinge
  const sb = snap(Math.round(51.635e5), Math.round(3.917e5));   // Zierikzee
  const r = sa && sb && RP.findRoute(sa, sb);
  const namen = r ? RP.objsOnRoute(r.geo).map(i => i.o.n) : [];
  check("Zeelandbrug gemeld via overspanning", namen.some(n => /Zeelandbrug/.test(n)),
        namen.join(", ") || "geen");
}

/* 7d. Doorvaarthoogte stuurt de route om te lage vaste bruggen heen */
{
  const sa = snap(Math.round(52.846e5), Math.round(5.709e5));   // Lemmer
  const sb = snap(Math.round(53.196e5), Math.round(5.795e5));   // Leeuwarden
  const laag = RP.findRoute(sa, sb);                            // zonder beperking
  const hoog = RP.findRoute(sa, sb, 6.7);                       // met 6,5 m + marge
  const lg = laag ? RP.objsOnRoute(laag.geo).filter(i => i.o.t === "B" && !i.o.open && i.o.hf != null) : [];
  const hg = hoog ? RP.objsOnRoute(hoog.geo).filter(i => i.o.t === "B" && !i.o.open && i.o.hf != null) : [];
  const min = a => a.length ? Math.min(...a.map(i => i.o.hf)) : 99;
  check("zonder hoogte gaat hij onder een lage brug door", min(lg) < 3, "laagste " + min(lg) + " m");
  check("met 6,5 m mijdt hij die bruggen", !!hoog && min(hg) >= 6.7 - 0.2,
        hoog ? "laagste " + min(hg) + " m" : "geen route");
}

/* 8. Onbereikbaar: punt ver op zee snapt niet */
{
  const s = snap(Math.round(54.5e5), Math.round(4.0e5));
  check("punt op open zee snapt niet", s === null);
}

process.exit(fails ? 1 : 0);
