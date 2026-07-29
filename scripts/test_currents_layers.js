/* Test het laagbeheer van currents.js zonder browser: in- en uitzoomen mag de stroompijlen
   nooit kwijtraken.

   Stubt Leaflet, canvas en fetch, laadt het échte currents.js, en speelt de zoomwissel na die
   index.html doet (arrows t/m zoom 12, eigen pijlen daarboven).

   Draaien:  node scripts/test_currents_layers.js
*/
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

/* ---- bestuurbare klok + requestAnimationFrame ---- */
let nu = 0, rafQueue = [];
function flushRaf(rondes, stapMs) {
  for (let r = 0; r < rondes; r++) {
    nu += (stapMs || 200);
    const q = rafQueue; rafQueue = [];
    for (const cb of q) { try { cb(nu); } catch (e) { throw e; } }
  }
}

/* ---- Leaflet-stub ---- */
const opDeKaart = new Set();
let zoom = 10;
function maakLaag(url, opts) {
  const evt = {};
  const lyr = {
    url, options: Object.assign({}, opts), _tiles: {},
    addTo(m) { opDeKaart.add(lyr); return lyr; },
    setOpacity(o) { lyr.options.opacity = o; return lyr; },
    on(n, f) { (evt[n] = evt[n] || []).push(f); return lyr; },
    once(n, f) { const w = (...a) => { f(...a); evt[n] = evt[n].filter(x => x !== w); }; return lyr.on(n, w); },
    off() { return lyr; },
    vuur(n) { (evt[n] || []).slice().forEach(f => f()); }
  };
  return lyr;
}
const kaartHandlers = {};
const map = {
  createPane: () => {}, getPane: () => ({ style: {}, appendChild: () => {} }),
  on(namen, fn) { String(namen).split(' ').forEach(n => (kaartHandlers[n] = kaartHandlers[n] || []).push(fn)); },
  vuur(n) { (kaartHandlers[n] || []).forEach(f => f()); },
  removeLayer(l) { opDeKaart.delete(l); },
  getZoom: () => zoom,
  getSize: () => ({ x: 900, y: 600 }),
  getBounds: () => ({ pad: () => ({ getNorth: () => 53.1, getSouth: () => 52.9, getWest: () => 4.6, getEast: () => 4.9 }) }),
  containerPointToLatLng: () => ({ lat: 53, lng: 4.75 }),
  latLngToContainerPoint: () => ({ x: 10, y: 10 }),
  containerPointToLayerPoint: () => ({ x: 0, y: 0 })
};
const L = { tileLayer: maakLaag, DomUtil: { setPosition: () => {} } };

/* ---- canvas / document / fetch ---- */
const ctx2d = new Proxy({}, { get: (t, p) => (p === 'getImageData' ? () => ({ data: new Uint8Array(256 * 256 * 4) }) : () => {}) });
const document = { createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => ctx2d, appendChild: () => {} }) };
const legenda = JSON.parse(fs.readFileSync('/tmp/legend.json', 'utf8'));
const sandbox = {
  L, document, console, Math, Date, JSON, Object, Array, Number, String, Promise, Set, Map,
  Int16Array, Uint8Array, Float32Array, Error, isNaN, parseInt, parseFloat, setTimeout, clearTimeout,
  devicePixelRatio: 1,
  performance: { now: () => nu },
  requestAnimationFrame: cb => { rafQueue.push(cb); return rafQueue.length; },
  cancelAnimationFrame: () => {},
  fetch: () => Promise.resolve({ json: () => Promise.resolve(legenda) }),
  Image: function () { this.crossOrigin = ''; Object.defineProperty(this, 'src', { set() { setTimeout(() => this.onerror && this.onerror(), 0); } }); },
  AbortController: undefined
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'currents.js'), 'utf8'), sandbox, { filename: 'currents.js' });

const Currents = sandbox.window.Currents;
Currents.init(map);

/* ---- hulpjes ---- */
const zichtbareLagen = () => [...opDeKaart].filter(l => (l.options.opacity || 0) > 0.01);
function ladenKlaar() {                       // Leaflet meldt 'load' zodra alle tegels binnen zijn
  [...opDeKaart].forEach(l => l.vuur('load'));
  flushRaf(6);
}
/* zoomen zoals in de app: index.html schakelt niets om, Leaflet ververst de tegels zelf */
function zoomNaar(z) {
  zoom = z;
  map.vuur('zoomend');
  ladenKlaar();
}
const MAX_LAGEN = 3;      // meer lagen aan de kaart = evenredig meer tegelverzoeken

let fouten = 0;
function check(naam, ok, extra) {
  console.log(`${ok ? 'ok  ' : 'FOUT'}  ${naam}${extra ? '   (' + extra + ')' : ''}`);
  if (!ok) fouten++;
}

console.log('laag aan op zoom 10, daarna in- en uitzoomen\n');
Currents.setLayers({ arrows: true, own: false, particles: false, color: false });
zoomNaar(10);
check('zoom 10: pijlen zichtbaar', zichtbareLagen().length > 0, zichtbareLagen().length + ' laag/lagen');

for (const z of [11, 12, 13, 14, 15, 16, 17, 18]) {
  zoomNaar(z);
  check('zoom ' + z + ': pijlen nog zichtbaar', zichtbareLagen().length > 0);
}
for (const z of [12, 9, 7, 5]) {
  zoomNaar(z);
  check('uitgezoomd naar ' + z + ': pijlen nog zichtbaar', zichtbareLagen().length > 0);
}
for (let i = 0; i < 5; i++) { zoomNaar(17); zoomNaar(8); }
check('na 5x heen en weer zoomen: pijlen nog zichtbaar', zichtbareLagen().length > 0, zichtbareLagen().length + ' laag/lagen');
check('niet meer dan ' + MAX_LAGEN + ' tegellagen aan de kaart', opDeKaart.size <= MAX_LAGEN, opDeKaart.size + ' lagen');

const laag = [...opDeKaart][0];
check('grote pijlen: @2x-tegelset', /EPSG%3A3857%402x/.test(laag.url), laag.url.match(/TILEMATRIXSET=[^&]*/)[0]);
check('grote pijlen: tileSize 512 + zoomOffset -1', laag.options.tileSize === 512 && laag.options.zoomOffset === -1,
      'tileSize ' + laag.options.tileSize + ', zoomOffset ' + laag.options.zoomOffset);
check('{z}/{x}/{y} staan letterlijk in de template', /TILEMATRIX=\{z\}&TILEROW=\{y\}&TILECOL=\{x\}/.test(laag.url));

/* Welk TILEMATRIX vraagt Leaflet werkelijk op? Met de echte functies uit assets/leaflet.min.js.
   Bij maximaal inzoomen moet dat het echte niveau zijn (kaartzoom-1), niet een opgeschaalde
   lagere tegel — daar bleven de pijlen eerder op weg. */
const lsrc = fs.readFileSync(path.join(__dirname, '..', 'assets', 'leaflet.min.js'), 'utf8');
function leafletFn(naam) {
  const i = lsrc.indexOf(naam + ':function');
  let j = lsrc.indexOf('{', i), d = 0;
  for (let k = j; k < lsrc.length; k++) {
    if (lsrc[k] === '{') d++;
    else if (lsrc[k] === '}') { d--; if (!d) return eval('({' + lsrc.slice(i, k + 1) + '})')[naam]; }
  }
}
const clampZoom = leafletFn('_clampZoom'), zoomForUrl = leafletFn('_getZoomForUrl');
const o = laag.options;
console.log('\nopgevraagd TILEMATRIX per kaartzoom\n');
for (const z of [10, 14, 17, 18, 19]) {
  const tz = (o.maxZoom !== undefined && z > o.maxZoom) ? undefined : clampZoom.call({ options: o }, z);
  const u = tz === undefined ? null : zoomForUrl.call({ options: o, _tileZoom: tz });
  const schaal = tz === undefined ? Infinity : Math.pow(2, z - tz);
  check(`kaartzoom ${z}: echt niveau, niet opgeschaald`, u === z - 1 && schaal === 1,
        u === null ? 'laag uitgeschakeld' : 'TILEMATRIX ' + u + ', schaal x' + schaal);
}
check('geen maxNativeZoom-klem meer', o.maxNativeZoom === undefined);
check('updateWhenIdle op de Leaflet-standaard', o.updateWhenIdle === undefined);

console.log('\ntijdsprongen (dagknoppen, "nu", einde afspeellus)\n');
zoomNaar(10);
Currents.setTime(0); ladenKlaar();
check('aantal lagen blijft begrensd na tijdsprongen', opDeKaart.size <= MAX_LAGEN, opDeKaart.size + ' lagen');
check('sprong naar uur 0', zichtbareLagen().length > 0);
Currents.setTime(100); ladenKlaar();
check('sprong naar uur 100 (>8 u verder)', zichtbareLagen().length > 0);
Currents.setTime(24); ladenKlaar();
check('sprong terug naar uur 24', zichtbareLagen().length > 0);
Currents.setTime(Currents.NHOURS - 1); ladenKlaar();
check('sprong naar het laatste uur', zichtbareLagen().length > 0);

console.log('\nlaag uit en weer aan\n');
Currents.setLayers({ arrows: false, own: false, particles: false, color: false });
check('laag uit: niets zichtbaar', zichtbareLagen().length === 0);
Currents.setLayers({ arrows: true, own: false, particles: false, color: false }); ladenKlaar();
check('laag weer aan: pijlen terug', zichtbareLagen().length > 0);

console.log(`\n${fouten ? fouten + ' controle(s) MISLUKT' : 'alles geslaagd'}`);
process.exit(fouten ? 1 : 0);
