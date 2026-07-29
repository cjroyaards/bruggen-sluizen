/* Getijdestromen-laag voor de hoofdkaart — volledig op Copernicus Marine (NWShelf, 1,5 km).

   Databron: de WMTS van Copernicus serveert uo (oost) en vo (noord) als kleurtegels met een
   bekende colormap. Via GetLegend halen we de 256 kleurstops + het waardebereik op en decoderen
   we de tegels terug naar echte m/s. Twee PNG's = een compleet stroomveld op modelresolutie.
   De alfa-laag van diezelfde tegel is meteen het landmasker (0 = land of buiten het model).

   Eerder kwam dit veld van Open-Meteo (wereldwijd SMOC, ~8 km). Dat model kent de geulen en
   zeegaten niet: in het Marsdiep gaf het 24 uur lang de vulwaarde 0,2 km/h bij 0°, terwijl
   Copernicus daar een nette getijcyclus van 1,3–2,8 kn laat zien. Vandaar deze overstap.

   window.Currents.init(map) → daarna setLayers({arrows,particles,color,own}), setTime(tf),
   setPlaying(bool), onTime(cb), getTimes(), nowIndex(). */
(function () {
  'use strict';
  const WMTS = 'https://wmts.marine.copernicus.eu/teroWmts';
  const DS = 'NWSHELF_ANALYSISFORECAST_PHY_004_013/cmems_mod_nws_phy-cur_anfc_1.5km-2D_PT1H-i_202511/';
  const VEC = DS + 'sea_water_velocity';          // gerenderde pijlen/kleurvlakken
  const DATA_STYLE = 'cmap:balance,range:-2.5/2.5';
  const NHOURS = 144, PLAY_HPS = 1.4;             // Copernicus reikt ~6 dagen vooruit
  const RAMP = [[0, '#5f9be0'], [0.93, '#3d84d8'], [1.85, '#2f74cf'], [2.8, '#215fb0'], [3.7, '#184f95'], [4.6, '#0d366b']];
  /* gedecodeerde resolutie per tegel: 256px → 64x64. Bij dataZ = kaartzoom-1 is één datacel
     ~8 schermpixels; ruim genoeg voor pijlen (om de 50 px) en deeltjes, en 16x minder geheugen. */
  const N = 64, DZ_MIN = 6, DZ_MAX = 12, CACHE_MAX = 260, MAX_INFLIGHT = 6;
  const NODATA = -32768;

  let map = null, times = null;
  let tFloat = 0, playing = false, loading = false;
  let canvas = null, ctx = null, particles = [], rafId = 0, lastTs = 0;
  let arrowFade = null, colorFade = null, lastWmtsHour = -1;
  let want = { arrows: false, particles: false, color: false, own: false };
  let onTimeChange = null, statusCb = null;

  const isoHour = s => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
  const rad = d => d * Math.PI / 180;
  function speedColor(kmh) { for (let k = RAMP.length - 1; k >= 0; k--) if (kmh >= RAMP[k][0]) return RAMP[k][1]; return RAMP[0][1]; }

  function qs(o) { return Object.keys(o).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&'); }
  function tileURL(layer, style, z, x, y, iso) {
    return WMTS + '?' + qs({ SERVICE: 'WMTS', REQUEST: 'GetTile', VERSION: '1.0.0', LAYER: layer,
      TILEMATRIXSET: 'EPSG:3857', TILEMATRIX: z, TILEROW: y, TILECOL: x, FORMAT: 'image/png', STYLE: style, time: iso });
  }

  /* ---- gerenderde Copernicus-lagen (pijlen / kleurvlakken) ---- */
  function makeCmemsLayer(style, opacity, iso, extra) {
    // De @2x-tegelset levert 512 px per tegel en tekent de pijlen op dubbele pixelgrootte.
    // Met tileSize 512 + zoomOffset -1 vraagt Leaflet één niveau lager op, dus de kaartschaal
    // blijft gelijk maar de pijlen worden twee keer zo groot (en half zo dicht) — en scherp,
    // want het is een echte render en geen opgeschaald plaatje. Scheelt ook 3/4 van de verzoeken.
    // {z}/{x}/{y} moeten letterlijk in de template blijven, dus die zetten we er ná het encoderen bij
    const url = WMTS + '?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0'
      + '&LAYER=' + encodeURIComponent(VEC)
      + '&TILEMATRIXSET=' + encodeURIComponent('EPSG:3857@2x')
      + '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png'
      + '&STYLE=' + encodeURIComponent(style) + '&time=' + encodeURIComponent(iso);
    return L.tileLayer(url,
      // Géén maxNativeZoom: Copernicus rendert elk niveau zelf (t/m TILEMATRIX 18 nagemeten,
      // ook in het Marsdiep). Met een klem eindigde je bij maximaal inzoomen in het opschaalpad
      // van Leaflet en bleven de pijlen weg. Nu vraagt hij overal gewoon het echte niveau op.
      // Ook geen updateWhenIdle: dat stelt het laden uit tot de kaart stilligt.
      Object.assign({ opacity, tileSize: 512, zoomOffset: -1, maxZoom: 19,
        pane: 'curTilePane' }, extra || {}));
  }

  /* ---- crossfade-manager per WMTS-laag ---- */
  function makeFadeManager(style, maxOpacity) {
    const layers = new Map(); let visibleHour = -1, fadeRAF = 0, on = false;
    function layerFor(hr) {
      if (layers.has(hr)) return layers.get(hr);
      const lyr = makeCmemsLayer(style, 0, isoHour(times[hr])); lyr._allLoaded = false;
      lyr.on('load', () => { lyr._allLoaded = true; });
      lyr.addTo(map); lyr.setOpacity(0); layers.set(hr, lyr);
      // opruimen: nooit het uur dat we nét hebben aangemaakt weggooien. Bij een sprong van meer
      // dan 8 uur (dagknoppen, "nu", of de lus aan het eind van het afspelen) was hr zelf het
      // verst van visibleHour en verdween de laag meteen weer → pijlen helemaal weg.
      // Elke laag die aan de kaart hangt haalt een heel scherm tegels op, ook op opacity 0.
      // Daarom er maar drie tegelijk aanhouden (zichtbaar, vorige, volgende) — met acht liep
      // het bij elke zoom op tot honderd verzoeken en kneep Copernicus ons af.
      while (layers.size > 3) { let far = -1, fd = -1; for (const h of layers.keys()) { if (h === hr || h === visibleHour || Math.abs(h - visibleHour) <= 1) continue; const d = Math.abs(h - visibleHour); if (d > fd) { fd = d; far = h; } } if (far < 0) break; map.removeLayer(layers.get(far)); layers.delete(far); }
      return lyr;
    }
    function fadeTo(target, prev) {
      cancelAnimationFrame(fadeRAF);
      const t0 = performance.now(), dur = 380, of = target.options.opacity || 0, pf = prev ? (prev.options.opacity || 0) : 0;
      const step = now => { const k = Math.min(1, (now - t0) / dur); target.setOpacity(of + (maxOpacity - of) * k); if (prev && prev !== target) prev.setOpacity(pf * (1 - k)); if (k < 1) fadeRAF = requestAnimationFrame(step); };
      fadeRAF = requestAnimationFrame(step);
    }
    function show(hr) {
      if (!times || !on) return;
      const target = layerFor(hr), prev = layers.get(visibleHour); if (target === prev) return;
      visibleHour = hr;
      if (playing) layerFor(Math.min(NHOURS - 1, hr + 1));   // alleen vooruitladen als de tijd loopt
      layers.forEach(l => { if (l !== target && l !== prev) l.setOpacity(0); });
      // pas infaden als álle tegels binnen zijn → in één keer, geen piecemeal-gepop
      if (target._allLoaded) { fadeTo(target, prev); }
      else {
        target.once('load', () => { if (on && visibleHour === hr) fadeTo(target, prev); });
        setTimeout(() => { if (on && visibleHour === hr && (target.options.opacity || 0) < maxOpacity * 0.5) fadeTo(target, prev); }, 1500);
      }
    }
    function clear() { cancelAnimationFrame(fadeRAF); layers.forEach(l => map.removeLayer(l)); layers.clear(); visibleHour = -1; }
    return { show, clear, setOn(v) { on = v; if (!v) clear(); }, get on() { return on; }, get visibleHour() { return visibleHour; } };
  }

  /* ================= kleurtegels → echte m/s ================= */
  /* De colormap is een pad van 256 kleuren door de RGB-ruimte. Terugzoeken doen we exact
     (dichtstbijzijnde van de 256), met een memo per unieke kleur — een tegel bevat er maar
     een paar honderd, dus na de eerste tegel is het puur hash-lookup. */
  let cmap = null, vMin = 0, vMax = 0, lutPromise = null;
  const colorMemo = new Map();
  function ensureLUT() {
    if (lutPromise) return lutPromise;
    const url = WMTS + '?' + qs({ SERVICE: 'WMTS', REQUEST: 'GetLegend', LAYER: DS + 'uo', STYLE: DATA_STYLE, FORMAT: 'application/json' });
    lutPromise = fetch(url).then(r => r.json()).then(j => {
      const c = j.continuous; cmap = c.cmap.colorMap; vMin = c.valueMin; vMax = c.valueMax;
      return true;
    }).catch(() => { lutPromise = null; return false; });
    return lutPromise;
  }
  function decodeColor(r, g, b) {
    const key = (r << 16) | (g << 8) | b;
    let idx = colorMemo.get(key);
    if (idx === undefined) {
      let best = Infinity; idx = 0;
      for (let k = 0; k < cmap.length; k++) {
        const c = cmap[k], dr = c[0] - r, dg = c[1] - g, db = c[2] - b, d = dr * dr + dg * dg + db * db;
        if (d < best) { best = d; idx = k; }
      }
      if (colorMemo.size < 40000) colorMemo.set(key, idx);
    }
    return vMin + (vMax - vMin) * idx / (cmap.length - 1);
  }

  const decCanvas = document.createElement('canvas');
  decCanvas.width = decCanvas.height = 256;
  const dctx = decCanvas.getContext('2d', { willReadFrequently: true });
  dctx.imageSmoothingEnabled = false;    // nooit interpoleren: gemengde kleuren decoderen fout
  function pixelsOf(img) {
    dctx.clearRect(0, 0, 256, 256); dctx.drawImage(img, 0, 0, 256, 256);
    return dctx.getImageData(0, 0, 256, 256).data;
  }
  /* 256x256 RGBA → N x N waarden (×1000, NODATA waar de tegel doorzichtig is).
     Alfa < 250 = land, buiten het model, óf een gemengde randpixel langs de kustlijn:
     die laatste zouden een kleur buiten de ramp geven, dus we gooien ze bewust weg. */
  function decodePlane(data) {
    const out = new Int16Array(N * N), step = 256 / N, half = step >> 1;
    for (let j = 0; j < N; j++) {
      const sy = j * step + half;
      for (let i = 0; i < N; i++) {
        const p = ((sy * 256) + (i * step + half)) * 4;
        out[j * N + i] = data[p + 3] < 250 ? NODATA : Math.round(decodeColor(data[p], data[p + 1], data[p + 2]) * 1000);
      }
    }
    return out;
  }

  /* ---- tegelcache (LRU) ---- */
  const fields = new Map();          // "z/x/y/h" → {u:Int16Array, v:Int16Array} (u=null = mislukt)
  const inflight = new Set();
  const queued = new Set();          // wat er in `pending` staat, om dubbelingen te weren
  const retryAt = new Map();         // key → tijdstip waarop opnieuw proberen mag
  let pending = [], okCount = 0, misses = 0;
  const fkey = (z, x, y, h) => z + '/' + x + '/' + y + '/' + h;
  function touch(k, val) {
    if (val) { fields.delete(k); fields.set(k, val); }
    while (fields.size > CACHE_MAX) {
      const old = fields.keys().next().value;
      if (fields.get(old).u) okCount--;
      fields.delete(old); retryAt.delete(old);
    }
  }
  function loadImage(url) {
    return new Promise((res, rej) => {
      const im = new Image(); im.crossOrigin = 'anonymous';
      im.onload = () => res(im); im.onerror = rej; im.src = url;
    });
  }
  function drainQueue() {
    while (pending.length && inflight.size < MAX_INFLIGHT) {
      const nx = pending.shift(); queued.delete(fkey(nx[0], nx[1], nx[2], nx[3]));
      fetchField(nx[0], nx[1], nx[2], nx[3]);
    }
  }
  async function fetchField(z, x, y, h) {
    const k = fkey(z, x, y, h);
    if (inflight.has(k)) return;
    const f = fields.get(k);
    if (f && (f.u || Date.now() < (retryAt.get(k) || 0))) return;   // gelukt, of nog in de wachttijd
    if (inflight.size >= MAX_INFLIGHT) {
      if (!queued.has(k) && pending.length < 60) { queued.add(k); pending.push([z, x, y, h]); }
      return;
    }
    inflight.add(k);
    try {
      if (!(await ensureLUT())) throw new Error('geen legenda');
      const iso = isoHour(times[h]);
      const [iu, iv] = await Promise.all([
        loadImage(tileURL(DS + 'uo', DATA_STYLE, z, x, y, iso)),
        loadImage(tileURL(DS + 'vo', DATA_STYLE, z, x, y, iso))
      ]);
      touch(k, { u: decodePlane(pixelsOf(iu)), v: decodePlane(pixelsOf(iv)) });
      okCount++; retryAt.delete(k); misses = 0;
      if (statusCb && loading) { loading = false; statusCb(''); }
    } catch (e) {
      // mislukt: markeren en een oplopende wachttijd zetten i.p.v. per tegel een losse timer,
      // anders vuren er bij een storing honderden hertimers tegelijk af
      const n = Math.min(6, (f && f.tries || 0) + 1);
      touch(k, { u: null, v: null, tries: n });
      retryAt.set(k, Date.now() + 5000 * Math.pow(2, n - 1));
      if (statusCb && loading && ++misses >= 3) { loading = false; statusCb('Stromingsdata niet bereikbaar'); }
    } finally {
      inflight.delete(k);
      drainQueue();
    }
  }

  /* Datazoom = kaartzoom (max 12). Met N=64 is één datacel dan ~4 schermpixels; een niveau
     lager schoot het Marsdiep er 9° naast omdat de bemonstering in een buurcel van het model
     viel. Vanaf zoom 12 is de cel (~90 m) veel fijner dan het model zelf (1,5 km). */
  function dataZ() { return Math.max(DZ_MIN, Math.min(DZ_MAX, map ? map.getZoom() : DZ_MIN)); }
  function gridXY(lat, lon, z) {
    const n = Math.pow(2, z);
    return [(lon + 180) / 360 * n,
            (1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2 * n];
  }
  /* u,v in km/h op één uur; null = geen data of nog niet binnen */
  function sampleAt(lat, lon, h, z) {
    if (!times || h < 0 || h >= NHOURS) return null;
    const g = gridXY(lat, lon, z), n = Math.pow(2, z);
    if (g[0] < 0 || g[1] < 0 || g[0] >= n || g[1] >= n) return null;
    const tx = Math.floor(g[0]), ty = Math.floor(g[1]), k = fkey(z, tx, ty, h);
    const f = fields.get(k);
    if (!f) { fetchField(z, tx, ty, h); return null; }
    if (!f.u) return null;
    const i = Math.min(N - 1, ((g[0] - tx) * N) | 0), j = Math.min(N - 1, ((g[1] - ty) * N) | 0);
    const uu = f.u[j * N + i], vv = f.v[j * N + i];
    if (uu === NODATA || vv === NODATA) return null;
    return [uu * 0.0036, vv * 0.0036];        // milli-m/s → km/h
  }
  function sampleUV(lat, lon, tf) {
    const z = dataZ(), h0 = Math.floor(tf), w = tf - h0;
    const a = sampleAt(lat, lon, h0, z);
    if (w < 1e-3 || h0 >= NHOURS - 1) return a;
    const b = sampleAt(lat, lon, h0 + 1, z);
    if (!a) return b; if (!b) return a;
    return [a[0] * (1 - w) + b[0] * w, a[1] * (1 - w) + b[1] * w];
  }

  /* zichtgebied vooruit inladen: alle tegels voor het huidige én het volgende uur */
  let lastPrefetch = '';
  function prefetchView(force) {
    if (!map || !times) return;
    if (!(want.particles || want.own)) return;
    const z = dataZ(), b = map.getBounds().pad(0.25);
    const nw = gridXY(b.getNorth(), b.getWest(), z), se = gridXY(b.getSouth(), b.getEast(), z);
    const x0 = Math.floor(nw[0]), x1 = Math.floor(se[0]), y0 = Math.floor(nw[1]), y1 = Math.floor(se[1]);
    const h0 = Math.floor(tFloat), h1 = Math.min(NHOURS - 1, h0 + 1);
    const sig = z + ':' + x0 + ',' + x1 + ',' + y0 + ',' + y1 + ':' + h0;
    if (!force && sig === lastPrefetch) return;
    lastPrefetch = sig; pending = []; queued.clear();
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 42) return;      // absurd uitgezoomd: laat de tegels met rust
    if (statusCb && !okCount) { loading = true; statusCb('Stromingsdata laden…'); }
    // Tijdens afspelen verspringt het uur elke ~0,7 s. Dan alleen het lopende uur halen; het
    // volgende uur (voor de tijdinterpolatie) komt vanzelf via sampleAt, netjes afgeknepen door
    // MAX_INFLIGHT. Anders verdubbelde het aantal verzoeken en kneep Copernicus ons af.
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      fetchField(z, x, y, h0); if (!playing && h1 !== h0) fetchField(z, x, y, h1);
    }
  }

  /* ---- eigen vloeiende pijlen (zelfde veld als de gerenderde tegels) ---- */
  function drawArrows() {
    const sz = map.getSize(), step = 50;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.globalAlpha = 1;
    for (let x = step * 0.6; x < sz.x; x += step) {
      for (let y = step * 0.6; y < sz.y; y += step) {
        const ll = map.containerPointToLatLng([x, y]);
        const uv = sampleUV(ll.lat, ll.lng, tFloat); if (!uv) continue;
        const u = uv[0], v = uv[1], kmh = Math.hypot(u, v); if (kmh < 0.05) continue;
        const dx = u, dy = -v, m = Math.hypot(dx, dy) || 1, ux = dx / m, uy = dy / m;
        const len = Math.min(step * 0.58, 9 + kmh * 5);
        const hx = x + ux * len * 0.5, hy = y + uy * len * 0.5, tx = x - ux * len * 0.5, ty = y - uy * len * 0.5;
        const ah = Math.min(7, len * 0.44), ang = Math.atan2(uy, ux);
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy);
        ctx.lineTo(hx - ah * Math.cos(ang - 0.45), hy - ah * Math.sin(ang - 0.45));
        ctx.moveTo(hx, hy); ctx.lineTo(hx - ah * Math.cos(ang + 0.45), hy - ah * Math.sin(ang + 0.45));
        ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 4.0; ctx.stroke();   // witte casing → contrast op elke ondergrond
        ctx.strokeStyle = speedColor(kmh); ctx.lineWidth = 2.2; ctx.stroke();
      }
    }
  }

  /* ---- deeltjes ---- */
  function resizeCanvas() { const sz = map.getSize(); canvas.width = sz.x * devicePixelRatio; canvas.height = sz.y * devicePixelRatio; canvas.style.width = sz.x + 'px'; canvas.style.height = sz.y + 'px'; ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0); }
  // canvas tekent in container-coördinaten; plaats hem op het layer-punt van container[0,0] zodat hij met de kaart meebeweegt
  function reposition() { if (canvas && map) L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0])); }
  /* op zee zetten door te proberen: het veld zelf is nu het masker (alfa uit de tegel) */
  function spawnParticle(pt) {
    const s = map.getSize();
    for (let tries = 0; tries < 12; tries++) {
      const ll = map.containerPointToLatLng([Math.random() * s.x, Math.random() * s.y]);
      if (sampleUV(ll.lat, ll.lng, tFloat)) { pt.lat = ll.lat; pt.lon = ll.lng; pt.age = 60 + Math.random() * 140; return pt; }
    }
    pt.lat = null; pt.lon = null; pt.age = 5 + Math.random() * 25; return pt;   // niks gevonden: kort wachten
  }
  function resetParticles() { if (!canvas) return; const z = map.getZoom(); const count = Math.min(2600, Math.round(280 * Math.pow(1.5, z - 5))); particles = Array.from({ length: count }, () => spawnParticle({})); ctx.clearRect(0, 0, canvas.width, canvas.height); }

  function frame(ts) {
    rafId = requestAnimationFrame(frame);
    const dt = lastTs ? Math.min(0.08, (ts - lastTs) / 1000) : 0; lastTs = ts;
    if (playing && times) {
      tFloat += dt * PLAY_HPS; if (tFloat >= NHOURS - 1) tFloat = 0;
      updateWmtsTime(); prefetchView(); if (onTimeChange) onTimeChange(tFloat);
    }
    if (!canvas || (!want.particles && !want.own)) return;
    const sz = map.getSize();
    if (want.particles && playing) {
      ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = 'rgba(0,0,0,0.040)'; ctx.fillRect(0, 0, sz.x, sz.y);
      ctx.globalCompositeOperation = 'source-over'; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
      const speedScale = 0.00060 * Math.pow(1.18, map.getZoom() - 6);
      for (const p of particles) {
        if (--p.age <= 0 || p.lat == null) { spawnParticle(p); continue; }
        const uv = sampleUV(p.lat, p.lon, tFloat); if (!uv) { spawnParticle(p); continue; }
        const u = uv[0], v = uv[1], kmh = Math.hypot(u, v);
        const nLat = p.lat + v * speedScale / 1.5, nLon = p.lon + u * speedScale / (1.5 * Math.cos(rad(p.lat)));
        const a = map.latLngToContainerPoint([p.lat, p.lon]), b2 = map.latLngToContainerPoint([nLat, nLon]);
        if (b2.x < -20 || b2.y < -20 || b2.x > sz.x + 20 || b2.y > sz.y + 20) { spawnParticle(p); continue; }
        if (!sampleUV(nLat, nLon, tFloat)) { spawnParticle(p); continue; }     // loopt het land op
        p.lat = nLat; p.lon = nLon;
        ctx.strokeStyle = speedColor(kmh); ctx.globalAlpha = Math.min(0.95, 0.4 + kmh / 4);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b2.x, b2.y); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (!want.particles || want.own) {
      // schoon canvas als er geen bewegende deeltjes op staan. Ook bij deeltjes-in-pauze mét
      // eigen pijlen: anders stapelen de pijlen elke frame op de bevroren sporen op.
      ctx.clearRect(0, 0, sz.x, sz.y);
    }
    // (want.particles && !playing → canvas bevroren; pauze stopt de beweging zichtbaar)
    if (want.own) drawArrows();
  }

  /* ---- puntinfo ---- */
  function pointInfo(lat, lon, tf) {
    const uv = sampleUV(lat, lon, tf); if (!uv) return null;
    const u = uv[0], v = uv[1], kmh = Math.hypot(u, v);
    return { kmh, kn: kmh / 1.852, ms: kmh / 3.6, dirTo: (Math.atan2(u, v) * 180 / Math.PI + 360) % 360 };
  }
  /* exacte waarde op één punt en uur, rechtstreeks uit het model (GetFeatureInfo, ~40 ms) */
  function gfiURL(lat, lon, h) {
    const z = 12, g = gridXY(lat, lon, z), x = Math.floor(g[0]), y = Math.floor(g[1]);
    return WMTS + '?' + qs({ SERVICE: 'WMTS', REQUEST: 'GetFeatureInfo', VERSION: '1.0.0', LAYER: VEC,
      TILEMATRIXSET: 'EPSG:3857', TILEMATRIX: z, TILEROW: y, TILECOL: x, FORMAT: 'image/png',
      STYLE: 'cmap:speed,vectorStyle:vector', time: isoHour(times[h]), INFOFORMAT: 'application/json',
      I: Math.floor((g[0] - x) * 256), J: Math.floor((g[1] - y) * 256) });
  }
  async function exactAt(lat, lon, h) {
    try {
      // harde time-out: zonder dit blijft een klik op "stroom-details" hangen als Copernicus traag is
      const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const tmr = ac && setTimeout(() => ac.abort(), 6000);
      const r = await fetch(gfiURL(lat, lon, h), ac ? { signal: ac.signal } : undefined);
      if (tmr) clearTimeout(tmr);
      const j = await r.json();
      const p = j && j.features && j.features[0] && j.features[0].properties;
      if (!p || p.component1Value == null || p.component2Value == null) return null;
      const u = p.component1Value * 3.6, v = p.component2Value * 3.6, kmh = Math.hypot(u, v);
      return { kmh, kn: kmh / 1.852, ms: kmh / 3.6, dirTo: (Math.atan2(u, v) * 180 / Math.PI + 360) % 360 };
    } catch (e) { return null; }
  }
  /* reeks van `count` uren vanaf index i0 — in blokjes van 4 tegelijk, zodat de server niet knijpt */
  async function seriesExact(lat, lon, i0, count) {
    if (!times) return null;
    const idx = []; for (let i = i0; i < Math.min(NHOURS, i0 + count); i++) idx.push(i);
    const out = new Array(NHOURS).fill(null);
    for (let s = 0; s < idx.length; s += 4) {
      const chunk = idx.slice(s, s + 4);
      const rs = await Promise.all(chunk.map(i => exactAt(lat, lon, i)));
      chunk.forEach((i, k) => { out[i] = rs[k]; });
    }
    return out;
  }

  /* ---- tijd ---- */
  function defaultTimes() { const midnight = Math.floor(Date.now() / 86400000) * 86400; return Array.from({ length: NHOURS }, (_, i) => midnight + i * 3600); }
  function nowIndex() { const now = Date.now() / 1000; let best = 0; for (let i = 0; i < times.length; i++) if (Math.abs(times[i] - now) < Math.abs(times[best] - now)) best = i; return best; }
  function updateWmtsTime() { if (!times) return; const hr = Math.round(tFloat); if (hr === lastWmtsHour) return; lastWmtsHour = hr; if (arrowFade && arrowFade.on) arrowFade.show(hr); if (colorFade && colorFade.on) colorFade.show(hr); }
  function setTimeFloat(tf) { tFloat = Math.max(0, Math.min(NHOURS - 1, tf)); updateWmtsTime(); prefetchView(); }

  function sync() {
    if (!arrowFade) return;
    const hr = Math.round(tFloat);
    arrowFade.setOn(want.arrows); if (want.arrows && arrowFade.visibleHour < 0) arrowFade.show(hr);
    colorFade.setOn(want.color); if (want.color && colorFade.visibleHour < 0) colorFade.show(hr);
    lastWmtsHour = hr;
    const canvasOn = want.particles || want.own;
    if (canvas) canvas.style.display = canvasOn ? 'block' : 'none';
    prefetchView(true);
    if (want.particles) resetParticles();
  }

  const API = {
    init(m) {
      if (map) return API; map = m;
      // eigen pane: boven de tegels (z 200) en Copernicus-lagen (overlay 400), onder de markers (600)
      map.createPane('curPane');
      const pane = map.getPane('curPane');
      pane.style.zIndex = 450; pane.style.pointerEvents = 'none';
      // Copernicus-stroomtegels: boven de dieptevlakken/ENC (≤320), onder de zeekaart-symbolen (350)
      map.createPane('curTilePane');
      const tpane = map.getPane('curTilePane');
      tpane.style.zIndex = 340; tpane.style.pointerEvents = 'none';
      canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;display:none';
      pane.appendChild(canvas); ctx = canvas.getContext('2d');
      times = defaultTimes();
      ensureLUT();
      arrowFade = makeFadeManager('cmap:speed,vectorStyle:vector', 0.92);
      colorFade = makeFadeManager('cmap:speed,vectorStyle:solid', 0.55);
      // resetParticles() bemonstert het veld en trekt daarmee tegels aan: alleen doen als de
      // deeltjes ook echt aanstaan, anders haalt een pan met alleen pijlen data op voor niets
      map.on('resize', () => { resizeCanvas(); reposition(); if (want.particles) resetParticles(); prefetchView(true); });
      map.on('moveend zoomend', () => { reposition(); if (want.particles) resetParticles(); prefetchView(); });
      map.on('movestart zoomstart', () => ctx && ctx.clearRect(0, 0, canvas.width, canvas.height));
      resizeCanvas(); reposition(); setTimeFloat(nowIndex()); requestAnimationFrame(frame);
      return API;
    },
    setLayers(w) { const wasP = want.particles; want = Object.assign({}, want, w); if (want.particles && !wasP) playing = true; if (!(want.arrows || want.particles || want.color || want.own)) playing = false; sync(); if (onTimeChange) onTimeChange(tFloat); },
    anyOn() { return want.arrows || want.particles || want.color || want.own; },
    pointNow(lat, lon) { return pointInfo(lat, lon, tFloat); },
    pointNowExact(lat, lon) { return exactAt(lat, lon, Math.round(tFloat)); },
    seriesExact,
    isLoaded() { return okCount > 0; },
    setTime(tf) { playing = false; setTimeFloat(tf); if (onTimeChange) onTimeChange(tFloat); },
    setPlaying(v) { playing = v; },
    isPlaying() { return playing; },
    onTime(cb) { onTimeChange = cb; },
    onStatus(cb) { statusCb = cb; },
    getTimes() { return times; },
    getTFloat() { return tFloat; },
    nowIndex,
    NHOURS
  };
  window.Currents = API;
})();
