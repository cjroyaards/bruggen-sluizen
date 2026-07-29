/* Test de decodeer- en bemonsteringslogica van currents.js zonder browser.

   Haalt de échte functies uit currents.js (geen kopie!), voedt ze met echte Copernicus-tegels
   en vergelijkt de uitkomst met de officiële GetFeatureInfo-waarden van hetzelfde model.

   Voorbereiden van de testdata: scripts/maak_currents_testdata.py
   Draaien:  node scripts/test_currents_decode.js
*/
'use strict';
const fs = require('fs'), path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'currents.js'), 'utf8');

/* pak een functie letterlijk uit de bron, op naam, door de accolades te tellen */
function pluck(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('functie niet gevonden in currents.js: ' + name);
  let i = SRC.indexOf('{', start), depth = 0;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (!depth) return SRC.slice(start, j + 1); }
  }
  throw new Error('geen sluitende accolade voor ' + name);
}
function constOf(name) {
  const m = SRC.match(new RegExp('const[^;\\n]*\\b' + name + '\\s*=\\s*([^,;\\n]+)'));
  if (!m) throw new Error('constante niet gevonden: ' + name);
  return eval(m[1]);
}

const N = constOf('N'), NODATA = constOf('NODATA');
const legend = JSON.parse(fs.readFileSync('/tmp/legend.json', 'utf8')).continuous;
const cmap = legend.cmap.colorMap, vMin = legend.valueMin, vMax = legend.valueMax;
const colorMemo = new Map();
const rad = d => d * Math.PI / 180;

// de echte functies uit currents.js, in scope gebracht (als expressie, want in strict mode
// laat eval geen declaraties in de omliggende scope achter)
const decodeColor = eval('(' + pluck('decodeColor') + ')');
const decodePlane = eval('(' + pluck('decodePlane') + ')');
const gridXY = eval('(' + pluck('gridXY') + ')');

const data = JSON.parse(fs.readFileSync('/tmp/testdata.json', 'utf8'));
const Z = data.z;
const planes = new Map();
for (const t of data.tiles) {
  planes.set(t.x + '/' + t.y, {
    u: decodePlane(new Uint8Array(fs.readFileSync(t.uo))),
    v: decodePlane(new Uint8Array(fs.readFileSync(t.vo)))
  });
}

/* dezelfde index-berekening als sampleAt() in currents.js */
function sample(lat, lon) {
  const g = gridXY(lat, lon, Z), tx = Math.floor(g[0]), ty = Math.floor(g[1]);
  const f = planes.get(tx + '/' + ty); if (!f) return null;
  const i = Math.min(N - 1, ((g[0] - tx) * N) | 0), j = Math.min(N - 1, ((g[1] - ty) * N) | 0);
  const uu = f.u[j * N + i], vv = f.v[j * N + i];
  if (uu === NODATA || vv === NODATA) return null;
  return [uu * 0.0036, vv * 0.0036];              // → km/h, net als in de app
}
const dirTo = (u, v) => (Math.atan2(u, v) * 180 / Math.PI + 360) % 360;
const hoekVerschil = (a, b) => Math.abs(((a - b + 180) % 360 + 360) % 360 - 180);

const MAX_MONSTER_M = 200;      // bemonsteringsverschuiving t.o.v. het gevraagde punt
let fouten = 0, n = 0;
console.log('punt                gedecodeerd        exact (GetFeatureInfo)   afwijking');
console.log('-'.repeat(78));
for (const p of data.punten) {
  const got = sample(p.lat, p.lon);
  const zee = p.u != null && p.v != null;
  if (!zee) {
    const ok = got === null;
    console.log(`${p.naam.padEnd(18)} ${(got ? 'WAARDE!' : 'geen data').padEnd(18)} ${'geen data'.padEnd(24)} ${ok ? 'ok' : 'FOUT'}`);
    if (!ok) fouten++;
    n++; continue;
  }
  n++;
  if (!got) { console.log(`${p.naam.padEnd(18)} ${'geen data'.padEnd(18)} zee — FOUT`); fouten++; continue; }
  const ru = p.u * 3.6, rv = p.v * 3.6;
  const dd = hoekVerschil(dirTo(got[0], got[1]), dirTo(ru, rv));
  const dkn = Math.abs(Math.hypot(...got) - Math.hypot(ru, rv)) / 1.852;
  const ok = dd <= 3 && dkn <= 0.05;
  console.log(`${p.naam.padEnd(18)} ${(dirTo(got[0], got[1]).toFixed(0) + '°, ' + (Math.hypot(...got) / 1.852).toFixed(2) + ' kn').padEnd(18)} ` +
              `${(dirTo(ru, rv).toFixed(0) + '°, ' + (Math.hypot(ru, rv) / 1.852).toFixed(2) + ' kn').padEnd(24)} ` +
              `${dd.toFixed(1)}° / ${dkn.toFixed(3)} kn  ${ok ? 'ok' : 'FOUT'}`);
  if (!ok) fouten++;
}
console.log('-'.repeat(78));
const verst = Math.max(...data.punten.map(p => p.monsterAfstandM || 0));
const monsterOk = verst <= MAX_MONSTER_M;
console.log(`bemonsteringsverschuiving t.o.v. het gevraagde punt: max ${verst} m ` +
            `(grens ${MAX_MONSTER_M} m, model zelf is 1500 m) ${monsterOk ? 'ok' : 'FOUT'}`);
if (!monsterOk) fouten++;
console.log(`${n + 1 - fouten}/${n + 1} controles geslaagd`);
process.exit(fouten ? 1 : 0);
