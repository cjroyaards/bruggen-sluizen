/* OpenPilot — routeplanner over het vaarwegennetwerk (lazy geladen, zie BOUWGIDS.md).
   Data: data/net.json.gz (scripts/build_net.py, OSM-waterwegen, wekelijks ververst).
   Gebruikt globals uit index.html: map, L, DATA, cardHTML, esc, LANG, fetchGz, mastVal.
   Alleen binnenwateren (rivieren/kanalen); groot open water zit nog niet in de graaf. */
window.RoutePlanner = (function(){
"use strict";

const TXT = (typeof LANG!=="undefined" && LANG==="en") ? {
  title:"Route planner", hintStart:"Click the starting point; right-click sets the destination", hintEnd:"Now tap the destination", hintVolgende:"Click again for a via point · right-click sets the destination",
  loading:"Loading waterway network…", calc:"Calculating route…",
  none:"No route found. Tap a bit further from the bank, in open water. Still nothing: reload the page (the network is refreshed weekly). The Wadden Sea and North Sea are not included.",
  neu:"new route", total:"total", bridges:"bridges", locks:"locks", fixed:"fixed",
  viaBtn:"+ via point", hintVia:"Tap a point the route must pass through", via:"Via",
  hoogte:"air draft", hoogteHint:"Height of your boat above the water — fixed bridges that are too low are flagged.",
  lowest:"lowest fixed bridge", narrowest:"narrowest passage",
  mastwarn:(hf,m)=>`Warning: lowest fixed bridge is ${hf} m — too low for an air draft of ${m} m`,
  discTitle:"Bridge and lock planner — not a navigation route",
  disc:"This shows <b>which bridges and locks</b> lie along your way, so you can check operating times and clearances in advance. It is <b>not a sailing route</b>: the line is not a fairway, ignores depth, buoyage and channels, and on open water runs straight across. An object very close to the line may be listed without you actually passing it. Always navigate on the official chart.",
  start:"Start", end:"Destination"
} : {
  title:"Routeplanner", hintStart:"Klik het startpunt aan; rechtsklik zet de bestemming", hintEnd:"Tik nu de bestemming aan", hintVolgende:"Nog een klik = via-punt · rechtsklik zet de bestemming",
  loading:"Vaarwegennetwerk laden…", calc:"Route berekenen…",
  none:"Geen route gevonden. Tik iets verder uit de kant, midden op het water. Werkt het dan nog niet: herlaad de pagina (het netwerk wordt wekelijks bijgewerkt). Waddenzee en Noordzee zitten er niet in.",
  neu:"nieuwe route", total:"totaal", bridges:"bruggen", locks:"sluizen", fixed:"vast",
  viaBtn:"+ via-punt", hintVia:"Tik een punt aan waar de route langs moet", via:"Via",
  hoogte:"doorvaarthoogte", hoogteHint:"Hoogte van je boot boven water — te lage vaste bruggen worden gemeld.",
  lowest:"laagste vaste brug", narrowest:"smalste doorvaart",
  mastwarn:(hf,m)=>`Let op: laagste vaste brug is ${hf} m — te laag voor doorvaarthoogte ${m} m`,
  discTitle:"Bruggen- en sluizenplanner — geen vaarroute",
  disc:"Dit laat zien <b>welke bruggen en sluizen</b> op je weg liggen, zodat je bedieningstijden en doorvaarthoogtes vooraf kunt nakijken. Het is <b>geen vaarroute</b>: de lijn is geen vaargeul, houdt geen rekening met diepte, betonning of geulen, en gaat op open water rechtdoor. Een object vlak langs de lijn kan meegeteld worden zonder dat je het echt passeert. Vaar altijd op de officiële kaart.",
  start:"Start", end:"Bestemming"
};

/* ---------- graaf ---------- */
let NET = null;            // {edges:[{pts:Int32Array, len, name}], adj:Map(nodeKey->[{ei,end}])}
let netPromise = null;
let NETBUILT = null;       // wanneer het netwerkbestand gebouwd is (ms)

function key(la, lo){ return la+","+lo; }
function mPerLat(){ return 1.1132; }               // meter per 1e-5 graad
function mPerLon(la1e5){ return 1.1132*Math.cos(la1e5/1e5*Math.PI/180); }

let SPANS = [];            // lange brugoverspanningen: {pts:[[la,lo],…], ids:[…]}
function decodeSpans(raw){
  SPANS = (raw.spans||[]).map(([flat, ids])=>{
    const pts=[[flat[0],flat[1]]];
    for (let i=2;i<flat.length;i+=2) pts.push([pts[pts.length-1][0]+flat[i], pts[pts.length-1][1]+flat[i+1]]);
    return {pts, ids};
  });
}

function decodeNet(raw){
  decodeSpans(raw);
  const edges = [], adj = new Map();
  for (const [ni, flat, kf, dm] of raw.e){
    const n = flat.length/2;
    const pts = new Int32Array(flat.length);
    pts[0]=flat[0]; pts[1]=flat[1];
    for (let i=2;i<flat.length;i+=2){ pts[i]=pts[i-2]+flat[i]; pts[i+1]=pts[i-1]+flat[i+1]; }
    let len=0;
    for (let i=2;i<flat.length;i+=2){
      const kx=mPerLon((pts[i]+pts[i-2])/2);
      len += Math.hypot((pts[i+1]-pts[i-1])*kx,(pts[i]-pts[i-2])*mPerLat());
    }
    const ei = edges.length;
    /* kost = lengte × voorkeursfactor: hoofdvaarwegen tellen hun echte lengte,
       kleine wateren tellen zwaarder, zodat de route de doorgaande route kiest */
    edges.push({pts, len, kost: len*((kf||100)/100), hoogte: dm ? dm/10 : null, name: raw.names[ni]||""});
    const a = key(pts[0],pts[1]), b = key(pts[2*n-2],pts[2*n-1]);
    if(!adj.has(a)) adj.set(a,[]); adj.get(a).push({ei,end:0});
    if(!adj.has(b)) adj.set(b,[]); adj.get(b).push({ei,end:1});
  }
  return {edges, adj};
}

function loadNet(){
  if (netPromise) return netPromise;
  netPromise = fetchGz("data/net.json.gz").then(raw=>{ NETBUILT = raw.built||null; NET = decodeNet(raw); stampNet(); return NET; });
  return netPromise;
}

/* dichtstbijzijnde punt op het netwerk (bbox-voorselectie per kant) */
function snap(la1e5, lo1e5, maxM){
  maxM = maxM || 3000;
  let best = null;
  const margLat = maxM/1.1132, margLon = maxM/mPerLon(la1e5);
  for (let ei=0; ei<NET.edges.length; ei++){
    const {pts} = NET.edges[ei];
    let mnLa=1e18,mxLa=-1e18,mnLo=1e18,mxLo=-1e18;
    for (let i=0;i<pts.length;i+=2){ if(pts[i]<mnLa)mnLa=pts[i]; if(pts[i]>mxLa)mxLa=pts[i]; if(pts[i+1]<mnLo)mnLo=pts[i+1]; if(pts[i+1]>mxLo)mxLo=pts[i+1]; }
    if (la1e5<mnLa-margLat || la1e5>mxLa+margLat || lo1e5<mnLo-margLon || lo1e5>mxLo+margLon) continue;
    const kx = mPerLon(la1e5), ky = mPerLat();
    for (let i=2;i<pts.length;i+=2){
      const ax=pts[i-1]*kx, ay=pts[i-2]*ky, bx=pts[i+1]*kx, by=pts[i]*ky;
      const px=lo1e5*kx, py=la1e5*ky;
      const dx=bx-ax, dy=by-ay, L2=dx*dx+dy*dy||1e-9;
      let t=((px-ax)*dx+(py-ay)*dy)/L2; t=Math.max(0,Math.min(1,t));
      const d=Math.hypot(px-(ax+t*dx), py-(ay+t*dy));
      if (!best || d<best.d) best={d, ei, seg:i/2-1, t,
        la: pts[i-2]+(pts[i]-pts[i-2])*t, lo: pts[i-1]+(pts[i+1]-pts[i-1])*t};
    }
  }
  return (best && best.d<=maxM) ? best : null;
}

/* afstand (m) langs een kant tot snap-punt, en deelgeometrie */
function edgePartial(ei, s, fromStart){
  const {pts} = NET.edges[ei];
  const segs = pts.length/2-1;
  let d=0; const geo=[];
  const kx=i=>mPerLon((pts[2*i]+pts[2*i+2])/2);
  if (fromStart){                    // van begin van de kant tot snap-punt
    for(let i=0;i<s.seg;i++) d+=Math.hypot((pts[2*i+3]-pts[2*i+1])*kx(i),(pts[2*i+2]-pts[2*i])*1.1132);
    d+=Math.hypot((s.lo-pts[2*s.seg+1])*mPerLon(s.la),(s.la-pts[2*s.seg])*1.1132);
    for(let i=0;i<=s.seg;i++) geo.push([pts[2*i],pts[2*i+1]]);
    geo.push([s.la,s.lo]);
  } else {                           // van snap-punt tot einde van de kant
    for(let i=s.seg+1;i<segs;i++) d+=Math.hypot((pts[2*i+3]-pts[2*i+1])*kx(i),(pts[2*i+2]-pts[2*i])*1.1132);
    d+=Math.hypot((pts[2*s.seg+3]-s.lo)*mPerLon(s.la),(pts[2*s.seg+2]-s.la)*1.1132);
    geo.push([s.la,s.lo]);
    for(let i=s.seg+1;i<=segs;i++) geo.push([pts[2*i],pts[2*i+1]]);
  }
  return {d, geo};
}

function edgeGeo(ei, fromEnd){
  const {pts} = NET.edges[ei];
  const geo=[];
  for (let i=0;i<pts.length;i+=2) geo.push([pts[i],pts[i+1]]);
  if (fromEnd) geo.reverse();
  return geo;
}

/* echte afstand langs een reeks punten (de A* rekent met voorkeurskosten) */
function geoMeters(geo){
  let m=0;
  for (let i=1;i<geo.length;i++)
    m += Math.hypot((geo[i][1]-geo[i-1][1])*mPerLon(geo[i][0]), (geo[i][0]-geo[i-1][0])*mPerLat());
  return m;
}

/* A* van snap-punt naar snap-punt; retour {geo:[[la1e5,lo1e5],…], meters} of null */
function findRoute(sa, sb, nodig){
  if (sa.ei===sb.ei){                // zelfde kant: stukje ertussen
    const a = sa, b = sb;
    const first = (a.seg<b.seg || (a.seg===b.seg && a.t<=b.t)) ? a : b;
    const last  = first===a ? b : a;
    const {pts} = NET.edges[a.ei];
    const geo=[[first.la,first.lo]];
    for(let i=first.seg+1;i<=last.seg;i++) geo.push([pts[2*i],pts[2*i+1]]);
    geo.push([last.la,last.lo]);
    let m=0;
    for(let i=1;i<geo.length;i++) m+=Math.hypot((geo[i][1]-geo[i-1][1])*mPerLon(geo[i][0]),(geo[i][0]-geo[i-1][0])*1.1132);
    return {geo: first===a?geo:geo.reverse(), meters:m};
  }
  const h = k0=>{
    const [la,lo]=k0.split(",").map(Number);
    return Math.hypot((lo-sb.lo)*mPerLon(la),(la-sb.la)*1.1132);
  };
  const eA = NET.edges[sa.ei], eB = NET.edges[sb.ei];
  const nA = eA.pts.length/2, nB = eB.pts.length/2;
  const startA = key(eA.pts[0],eA.pts[1]), startB = key(eA.pts[2*nA-2],eA.pts[2*nA-1]);
  const goalA  = key(eB.pts[0],eB.pts[1]), goalB  = key(eB.pts[2*nB-2],eB.pts[2*nB-1]);
  const pA = edgePartial(sa.ei, sa, true), pB = edgePartial(sa.ei, sa, false);
  const gscore = new Map([[startA,pA.d]]), parent = new Map([[startA,{prev:null,ei:sa.ei,init:"A"}]]);
  if (!gscore.has(startB)||pB.d<gscore.get(startB)){ gscore.set(startB,pB.d); parent.set(startB,{prev:null,ei:sa.ei,init:"B"}); }
  /* simpele binaire heap */
  const heap=[[pA.d+h(startA),startA],[pB.d+h(startB),startB]];
  const up=i=>{while(i>0){const p=(i-1)>>1;if(heap[p][0]<=heap[i][0])break;[heap[p],heap[i]]=[heap[i],heap[p]];i=p;}};
  const dn=()=>{let i=0;for(;;){let s=i;const l=2*i+1,r=l+1;if(l<heap.length&&heap[l][0]<heap[s][0])s=l;if(r<heap.length&&heap[r][0]<heap[s][0])s=r;if(s===i)break;[heap[s],heap[i]]=[heap[i],heap[s]];i=s;}};
  up(1);
  const done=new Set();
  let best=null;                     // {tot, endKey, viaEnd:0|1}
  while(heap.length){
    const [f,k0]=heap[0];
    heap[0]=heap[heap.length-1]; heap.pop(); if(heap.length) dn();
    if (done.has(k0)) continue;
    done.add(k0);
    if (best && f>=best.tot) break;
    const g=gscore.get(k0);
    if (k0===goalA){ const t=g+edgePartial(sb.ei,sb,true).d; if(!best||t<best.tot) best={tot:t,endKey:k0,viaEnd:0}; }
    if (k0===goalB){ const t=g+edgePartial(sb.ei,sb,false).d; if(!best||t<best.tot) best={tot:t,endKey:k0,viaEnd:1}; }
    const nbrs = NET.adj.get(k0)||[];
    for (const {ei,end} of nbrs){
      const e=NET.edges[ei], np=e.pts.length/2;
      if (nodig!=null && e.hoogte!=null && e.hoogte < nodig) continue;   // te lage vaste brug
      const ok = end===0 ? key(e.pts[2*np-2],e.pts[2*np-1]) : key(e.pts[0],e.pts[1]);
      const ng = g+e.kost;
      if (ng < (gscore.get(ok)??1e18)){
        gscore.set(ok,ng); parent.set(ok,{prev:k0,ei});
        heap.push([ng+h(ok),ok]); up(heap.length-1);
      }
    }
  }
  if (!best) return null;
  /* terugwandelen */
  const chain=[]; let k0=best.endKey;
  for(;;){
    const p=parent.get(k0);
    if (p.prev===null){ chain.push({init:p.init}); break; }
    chain.push({ei:p.ei, to:k0}); k0=p.prev;
  }
  chain.reverse();
  const geo=[];
  const init = chain[0].init;
  const p0 = edgePartial(sa.ei, sa, init==="A");
  geo.push(...(init==="A"? p0.geo.slice().reverse() : p0.geo));
  for (let i=1;i<chain.length;i++){
    const {ei,to}=chain[i];
    const e=NET.edges[ei], np=e.pts.length/2;
    const endKey=key(e.pts[2*np-2],e.pts[2*np-1]);
    const g2=edgeGeo(ei, to!==endKey);
    geo.push(...g2.slice(1));
  }
  /* viaEnd 0: binnengekomen op kant-begin → geo van begin naar snap; viaEnd 1: van eind naar snap */
  geo.push(...(best.viaEnd===0 ? edgePartial(sb.ei,sb,true).geo.slice(1) : edgePartial(sb.ei,sb,false).geo.slice().reverse().slice(1)));
  return {geo, meters:geoMeters(geo)};
}

/* ---------- bruggen/sluizen op de route ---------- */
function objsOnRoute(geo, maxM){
  maxM = maxM||60;
  const pts=geo, n=pts.length;
  const cum=new Float64Array(n);
  for(let i=1;i<n;i++) cum[i]=cum[i-1]+Math.hypot((pts[i][1]-pts[i-1][1])*mPerLon(pts[i][0]),(pts[i][0]-pts[i-1][0])*1.1132);
  /* chunk-bboxen voor snelle voorselectie */
  const CH=40, chunks=[];
  for(let c=0;c<n-1;c+=CH){
    const e=Math.min(n-1,c+CH);
    let mnLa=1e18,mxLa=-1e18,mnLo=1e18,mxLo=-1e18;
    for(let i=c;i<=e;i++){ const p=pts[i]; if(p[0]<mnLa)mnLa=p[0]; if(p[0]>mxLa)mxLa=p[0]; if(p[1]<mnLo)mnLo=p[1]; if(p[1]>mxLo)mxLo=p[1]; }
    chunks.push([c,e,mnLa,mxLa,mnLo,mxLo]);
  }
  const out=[];
  for (const o of DATA.objs){
    if (o.t!=="B" && o.t!=="S") continue;
    const ola=Math.round(o.lat*1e5), olo=Math.round(o.lon*1e5);
    const zoek=(o.t==="S")?Math.max(maxM,400):maxM;
    const margLat=zoek/1.1132, margLon=zoek/mPerLon(ola);
    let best=null;
    for (const [c,e,mnLa,mxLa,mnLo,mxLo] of chunks){
      if (ola<mnLa-margLat||ola>mxLa+margLat||olo<mnLo-margLon||olo>mxLo+margLon) continue;
      const kx=mPerLon(ola), ky=1.1132;
      for(let i=c;i<e;i++){
        const ax=pts[i][1]*kx, ay=pts[i][0]*ky, bx=pts[i+1][1]*kx, by=pts[i+1][0]*ky;
        const px=olo*kx, py=ola*ky;
        const dx=bx-ax, dy=by-ay, L2=dx*dx+dy*dy||1e-9;
        let t=((px-ax)*dx+(py-ay)*dy)/L2; t=Math.max(0,Math.min(1,t));
        const d=Math.hypot(px-(ax+t*dx), py-(ay+t*dy));
        if(!best||d<best.d) best={d, along:cum[i]+t*(cum[i+1]-cum[i])};
      }
    }
    /* sluizen zijn grote complexen (een naviduct is honderden meters breed) en
       het RWS-punt ligt zelden precies op de vaarlijn — ruimere marge dan bruggen */
    const marge = (o.t==="S") ? Math.max(maxM, 400) : maxM;
    if (best && best.d<=marge) out.push({o, along:best.along});
  }

  /* lange bruggen over open water (Zeelandbrug, Ketelbrug, …) staan in de
     RWS-data als één punt, maar overspannen kilometers. Kruist de route de
     overspanningslijn, dan hoort de brug er hoe dan ook bij. */
  const gehad = new Set(out.map(i=>i.o.t+i.o.id));
  const kruis = (p1,p2,p3,p4)=>{
    const d=(p4[1]-p3[1])*(p2[0]-p1[0])-(p4[0]-p3[0])*(p2[1]-p1[1]);
    if (!d) return null;
    const ua=((p4[0]-p3[0])*(p1[1]-p3[1])-(p4[1]-p3[1])*(p1[0]-p3[0]))/d;
    const ub=((p2[0]-p1[0])*(p1[1]-p3[1])-(p2[1]-p1[1])*(p1[0]-p3[0]))/d;
    return (ua>=0&&ua<=1&&ub>=0&&ub<=1) ? ua : null;
  };
  for (const sp of SPANS){
    let hit = null;
    for (let i=0;i<n-1 && hit===null;i++){
      for (let j=0;j<sp.pts.length-1;j++){
        const ua = kruis(pts[i], pts[i+1], sp.pts[j], sp.pts[j+1]);
        if (ua!==null){ hit = cum[i] + ua*(cum[i+1]-cum[i]); break; }
      }
    }
    if (hit===null) continue;
    for (const id of sp.ids){
      const o = DATA.objs.find(x=> x.t==="B" && x.id===id);
      if (o && !gehad.has("B"+id)){ gehad.add("B"+id); out.push({o, along:hit, span:true}); }
    }
  }
  out.sort((a,b)=>a.along-b.along);
  return out;
}

/* benodigde doorvaarthoogte: ingevulde bootshoogte + 20 cm marge */
function nodigeHoogte(){
  const v = panel ? parseFloat(panel.querySelector("#rp-hoogte").value) : NaN;
  return isNaN(v) ? null : v + 0.2;
}

/* ---------- UI ---------- */
let mode=0;                    // 0 uit, 1 wacht start, 2 wacht eind, 3 route, 4 wacht via-punt
let punten=[];                 // [{latlng, marker}] — start, via-punten, bestemming
let eindGezet=false;           // is de bestemming al met rechtsklik gezet?
let lineBack=null, lineFront=null, panel=null, clickBound=false;

function css(){
  const s=document.createElement("style");
  s.textContent=`
#routepanel[hidden]{display:none !important}
#routepanel{position:absolute;top:56px;right:10px;z-index:1100;width:348px;max-width:calc(100vw - 20px);
  max-height:calc(100% - 76px);display:flex;flex-direction:column;background:var(--surface);
  border:1px solid var(--grid);border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.25);font-size:13.5px}
#routepanel .rp-head{display:flex;align-items:center;gap:8px;padding:8px 8px 8px 12px;border-bottom:1px solid var(--grid);font-weight:700}
#routepanel .rp-head .rp-x{margin-left:auto;cursor:pointer;color:var(--ink2);font-size:16px;line-height:1;
  padding:8px 12px;background:none;border:1px solid var(--grid);border-radius:8px;touch-action:manipulation}
#routepanel .rp-hint{padding:9px 12px;color:var(--ink2)}
#routepanel .rp-sum{padding:9px 12px;border-bottom:1px solid var(--grid);color:var(--ink);line-height:1.5}
#routepanel .rp-sum b{font-size:15px}
#routepanel .rp-warn{border-left:3px solid var(--serious);background:var(--chip-ser-bg);border-radius:6px;padding:6px 10px;margin-top:6px}
#routepanel .rp-note{margin-top:7px;color:var(--serious);font-size:11.5px;font-weight:600}
#routepanel .rp-list{overflow-y:auto;padding:4px 8px 8px;flex:1}
#routepanel .rp-item{position:relative;margin-top:8px}
#routepanel .rp-km{position:absolute;top:-7px;left:10px;z-index:5;background:var(--brand);color:#fff;border-radius:8px;
  font-size:10.5px;font-weight:700;padding:1px 7px;box-shadow:0 1px 4px rgba(0,0,0,.25)}
#routepanel .rp-list .card{margin:0;cursor:pointer}
#routepanel .rp-actions{padding:7px 12px;border-bottom:1px solid var(--grid);display:flex;
  flex-wrap:wrap;gap:7px;align-items:center}
#routepanel .rp-actions button{background:var(--surface);border:1px solid var(--grid);border-radius:8px;
  padding:5px 11px;font-size:12.5px;color:var(--ink2);cursor:pointer}
#routepanel .rp-actions button.arm{background:var(--brand);border-color:var(--brand);color:#fff}
#routepanel .rp-h{display:inline-flex;align-items:center;gap:5px;margin-left:auto;font-size:12px;color:var(--ink2)}
#routepanel .rp-h input{width:52px;padding:4px 6px;font-size:12.5px;text-align:right;
  border:1px solid var(--grid);border-radius:7px;background:var(--surface);color:var(--ink)}
#routepanel .rp-disc{padding:8px 12px 10px;color:var(--ink2);font-size:11.5px;line-height:1.45;
  border-top:1px solid var(--grid);background:var(--chip-ser-bg)}
#routepanel .rp-disc-t{display:block;color:var(--serious);font-size:12px;margin-bottom:3px}
#routepanel .rp-stamp{margin-top:5px;color:var(--muted);font-size:10.5px}
.rp-arming .leaflet-marker-pane *,.rp-arming .leaflet-shadow-pane *{pointer-events:none !important}
.rp-arming .leaflet-marker-pane,.rp-arming .leaflet-shadow-pane{pointer-events:none !important}
@media (max-width:640px){
  #routepanel{top:auto;left:0;right:0;bottom:0;width:auto;max-height:56%;border-radius:14px 14px 0 0}
}`;
  document.head.appendChild(s);
}

function el(html){ const t=document.createElement("template"); t.innerHTML=html.trim(); return t.content.firstChild; }

function initPanel(){
  if (panel) return;
  css();
  panel = el(`<div id="routepanel" hidden>
    <div class="rp-head"><span>${TXT.title}</span><button type="button" class="rp-x" aria-label="sluiten" title="sluiten">✕</button></div>
    <div class="rp-hint" id="rp-hint"></div>
    <div class="rp-actions" hidden>
      <button id="rp-new">${TXT.neu}</button>
      <button id="rp-via">${TXT.viaBtn}</button>
      <label class="rp-h">${TXT.hoogte} <input type="number" id="rp-hoogte" step="0.1" min="0" placeholder="–"> m</label>
    </div>
    <div class="rp-sum" id="rp-sum" hidden></div>
    <div class="rp-list" id="rp-list"></div>
    <div class="rp-disc"><b class="rp-disc-t">⚠ ${TXT.discTitle}</b>${TXT.disc}
      <div id="rp-stamp" class="rp-stamp"></div></div>
  </div>`);
  document.getElementById("v-kaart").appendChild(panel);
  panel.querySelector(".rp-x").addEventListener("click", e=>{ e.preventDefault(); e.stopPropagation(); off(); });
  panel.querySelector("#rp-new").onclick = restart;
  panel.querySelector("#rp-via").onclick = ()=>{
    if (mode===4){ mode=3; setCursor(false); panel.querySelector("#rp-via").classList.remove("arm"); hint(""); return; }
    mode=4; setCursor(true); panel.querySelector("#rp-via").classList.add("arm"); hint(TXT.hintVia);
  };
  /* doorvaarthoogte: gekoppeld aan het bestaande mastveld, zodat de site één waarde kent */
  const h = panel.querySelector("#rp-hoogte"), mast = document.getElementById("mast");
  if (mast && mast.value) h.value = mast.value;
  h.addEventListener("input", ()=>{
    if (mast){ mast.value = h.value; mast.dispatchEvent(new Event("input",{bubbles:true})); }
    if (punten.length>1 && lineFront) compute();
  });
  /* Escape sluit de planner — maar als het detailpaneel open is, sluit die eerst
     (capture-fase: wij kijken vóórdat index.html het detail al gesloten heeft) */
  document.addEventListener("keydown", e=>{
    if (e.key==="Escape" && mode!==0 && !document.querySelector("#panel.open")) off();
  }, true);
}

function hint(t){ const e=panel.querySelector("#rp-hint"); e.textContent=t; e.hidden=!t; }

/* netwerkdatum tonen: zo is meteen te zien of een oud tabblad nog oude data heeft */
function stampNet(){
  if (!panel || !NETBUILT) return;
  const el = panel.querySelector("#rp-stamp");
  if (!el) return;
  const d = new Intl.DateTimeFormat(LANG==="en"?"en-GB":"nl-NL",
              {day:"numeric",month:"short",year:"numeric"}).format(new Date(NETBUILT));
  const oud = (Date.now()-NETBUILT) > 21*86400000;
  el.textContent = (LANG==="en"?"waterway network of ":"vaarwegennetwerk van ") + d
                 + (oud ? (LANG==="en"?" · reload the page for the latest":" · herlaad de pagina voor de nieuwste") : "");
  el.style.color = oud ? "var(--serious)" : "";
}

function clearRoute(){
  for (const p of punten) if (p.marker) map.removeLayer(p.marker);
  punten=[];
  for (const ly of [lineBack,lineFront]) if (ly) map.removeLayer(ly);
  lineBack=lineFront=null;
  panel.querySelector("#rp-sum").hidden=true;
  panel.querySelector(".rp-actions").hidden=true;
  panel.querySelector("#rp-list").innerHTML="";
}

function restart(){ clearRoute(); eindGezet=false; mode=1; hint(TXT.hintStart); setCursor(true); }

/* via-punt invoegen op de plek waar het de minste omweg kost */
function voegVia(latlng){
  const d=(a,b)=>Math.hypot((b.lng-a.lng)*Math.cos(a.lat*Math.PI/180)*111320,(b.lat-a.lat)*111320);
  let best=1, bestKost=Infinity;
  for (let i=0;i<punten.length-1;i++){
    const k = d(punten[i].latlng,latlng)+d(latlng,punten[i+1].latlng)-d(punten[i].latlng,punten[i+1].latlng);
    if (k<bestKost){ bestKost=k; best=i+1; }
  }
  punten.splice(best,0,{latlng, marker:dot(latlng,"#7c3aed",TXT.via)});
}

function off(){
  clearRoute(); mode=0; panel.hidden=true; setCursor(false);
  const b=document.getElementById("mb-route"); if(b) b.classList.remove("on");
}

function setCursor(on){
  map.getContainer().style.cursor = on ? "crosshair" : "";
  /* tijdens het prikken moeten klikken op de kaart landen, niet op markers/clusters
     (leaflet-interactive zet zelf pointer-events:auto, dus met !important overrulen) */
  map.getContainer().classList.toggle("rp-arming", !!on);
}

/* eigen SVG-laag voor de route: de standaard canvas-renderer (preferCanvas) laat
   paden op iOS/Safari soms verdwijnen bij zoomen; SVG transformeert betrouwbaar */
let routeRenderer = null;
function renderer(){
  if (!routeRenderer){
    map.createPane("routePane");
    map.getPane("routePane").style.zIndex = 430;
    routeRenderer = L.svg({pane:"routePane"});
  }
  return routeRenderer;
}

function dot(latlng, color, label){
  return L.circleMarker(latlng,{radius:7,color:"#fff",weight:2,fillColor:color,fillOpacity:1,renderer:renderer()})
    .bindTooltip(label,{direction:"top",offset:[0,-8]}).addTo(map);
}

/* Klikken: 1e klik = start, elke volgende klik = via-punt (achteraan),
   rechtsklik (of lang indrukken op een tik-scherm) = bestemming. */
function onMapClick(e){
  if (mode===0) return;
  if (mode===4){                       // via-knop: invoegen op de beste plek
    voegVia(e.latlng);
    mode=3; setCursor(false);
    panel.querySelector("#rp-via").classList.remove("arm");
    compute();
    return;
  }
  if (!punten.length){
    punten=[{latlng:e.latlng, marker:dot(e.latlng,"#0ca30c",TXT.start)}];
    mode=2; hint(TXT.hintVolgende);
    return;
  }
  if (mode===3 && eindGezet){          // route af: klik voegt een via-punt toe
    punten.splice(punten.length-1, 0, {latlng:e.latlng, marker:dot(e.latlng,"#7c3aed",TXT.via)});
    compute();
    return;
  }
  punten.push({latlng:e.latlng, marker:dot(e.latlng,"#7c3aed",TXT.via)});
  hint(TXT.hintVolgende);
}

/* rechtsklik / lang indrukken zet de bestemming en rekent de route */
function onMapEnd(e){
  if (mode===0 || !punten.length) return;
  if (eindGezet){                      // bestemming verplaatsen
    const laatste = punten.pop();
    if (laatste.marker) map.removeLayer(laatste.marker);
  }
  punten.push({latlng:e.latlng, marker:dot(e.latlng,"#d03b3b",TXT.end)});
  eindGezet=true; mode=3; setCursor(false);
  compute();
}

async function compute(){
  hint(NET ? TXT.calc : TXT.loading);
  try { await loadNet(); } catch(err){ hint("net.json.gz: "+err.message); return; }
  /* per traject tussen opeenvolgende punten zoeken en aan elkaar plakken */
  const geo=[];
  for (let i=0;i<punten.length-1;i++){
    const a=punten[i].latlng, b=punten[i+1].latlng;
    const sa = snap(Math.round(a.lat*1e5), Math.round(a.lng*1e5));
    const sb = snap(Math.round(b.lat*1e5), Math.round(b.lng*1e5));
    /* nodigeHoogte() nog niet meegeven: het netwerk kent de doorvaarthoogtes al
       (data/net.json.gz), maar de bruggenlijst werkt op nabijheid en meldt dan
       bruggen die je niet echt passeert. Eerst objecten per vaarwegvak koppelen,
       daarna kan de planner ook echt om te lage bruggen heen zoeken. */
    const deel = (sa && sb) ? findRoute(sa, sb, null) : null;
    if (!deel){ hint(TXT.none); panel.querySelector(".rp-actions").hidden=false; return; }
    geo.push(...(i===0 ? deel.geo : deel.geo.slice(1)));
  }
  const r = {geo, meters: geoMeters(geo)};
  if (lineBack) map.removeLayer(lineBack);
  if (lineFront) map.removeLayer(lineFront);
  hint("");
  const latlngs = r.geo.map(p=>[p[0]/1e5, p[1]/1e5]);
  lineBack  = L.polyline(latlngs,{color:"#fff",weight:8,opacity:.85,renderer:renderer()}).addTo(map);
  lineFront = L.polyline(latlngs,{color:"#7c3aed",weight:4,opacity:.95,renderer:renderer()}).addTo(map);
  map.fitBounds(lineFront.getBounds(), innerWidth<=640
    ? {paddingTopLeft:[30,90], paddingBottomRight:[30, Math.round(innerHeight*0.60)]}
    : {paddingTopLeft:[70,90], paddingBottomRight:[Math.min(370,innerWidth*.4),40]});
  render(r);
}

function render(r){
  const items = objsOnRoute(r.geo);
  const km = x=> (x/1000).toFixed(1).replace(".", LANG==="en"?".":",");
  const bruggen = items.filter(i=>i.o.t==="B"), sluizen = items.filter(i=>i.o.t==="S");
  const vast = bruggen.filter(i=>!i.o.open);
  const fixedH = bruggen.filter(i=>!i.o.open && i.o.hf!=null);
  const lowest = fixedH.length ? fixedH.reduce((m,i)=> i.o.hf<m.o.hf?i:m) : null;
  const widths = items.map(i=> i.o.t==="B" ? (i.o.wm ?? i.o.w) : i.o.w).filter(w=>w!=null);
  const narrow = widths.length ? Math.min(...widths) : null;
  const mv = (typeof mastVal==="function") ? mastVal() : null;
  const fmt1 = x=> (+x).toFixed(1).replace(".", LANG==="en"?".":",");
  let sum = `<b>${km(r.meters)} km</b> · ${bruggen.length} ${TXT.bridges}`
          + (vast.length?` (${vast.length} ${TXT.fixed})`:"") + ` · ${sluizen.length} ${TXT.locks}`;
  if (lowest) sum += `<br>${TXT.lowest}: ${fmt1(lowest.o.hf)} m (${esc(lowest.o.n)})`;
  if (narrow!=null) sum += ` · ${TXT.narrowest}: ${fmt1(narrow)} m`;
  if (mv!=null && lowest && lowest.o.hf < mv+0.2)
    sum += `<div class="rp-warn">${esc(TXT.mastwarn(fmt1(lowest.o.hf), fmt1(mv)))}</div>`;
  sum += `<div class="rp-note">${TXT.discTitle}</div>`;
  const sm = panel.querySelector("#rp-sum"); sm.innerHTML=sum; sm.hidden=false;
  panel.querySelector(".rp-actions").hidden=false;
  panel.querySelector("#rp-list").innerHTML = items.map(i=>
    `<div class="rp-item"><div class="rp-km">km ${km(i.along)}</div>${cardHTML(i.o)}</div>`).join("");
}

function toggle(){
  initPanel();
  if (!clickBound){ map.on("click", onMapClick); map.on("contextmenu", onMapEnd); clickBound=true; }
  if (mode!==0){ off(); return; }
  panel.hidden=false;
  loadNet();                       // vast beginnen met laden
  restart();
  const b=document.getElementById("mb-route"); if(b) b.classList.add("on");
}

return {
  toggle,
  armed: ()=> mode===1 || mode===2,
  active: ()=> mode!==0,
  _test: {decodeNet, snapFn: ()=>snap, findRoute, objsOnRoute, loadRaw: raw=>{ NET=decodeNet(raw); }, net: ()=>NET}
};
})();
