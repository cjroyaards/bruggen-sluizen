/* Getijdestromen-laag voor de hoofdkaart (Copernicus Marine).
   window.Currents.init(map) → daarna setLayers({arrows,particles,color}), setTime(tf),
   setPlaying(bool), onTime(cb), getTimes(), nowIndex(). */
(function () {
  'use strict';
  const GRID = { lat0: 50.0, dLat: 0.4, nLat: 28, lon0: -4.0, dLon: 0.6, nLon: 23 };
  const NHOURS = 72, PLAY_HPS = 0.9;
  const CMEMS_LAYER = 'NWSHELF_ANALYSISFORECAST_PHY_004_013/cmems_mod_nws_phy-cur_anfc_1.5km-2D_PT1H-i_202511/sea_water_velocity';
  const WMTS = 'https://wmts.marine.copernicus.eu/teroWmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0'
    + '&LAYER=' + encodeURIComponent(CMEMS_LAYER)
    + '&TILEMATRIXSET=EPSG:3857&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png';
  const RAMP = [[0, '#9ec5f4'], [0.93, '#6da7ec'], [1.85, '#3987e5'], [2.8, '#256abf'], [3.7, '#184f95'], [4.6, '#0d366b']];

  let map = null, times = null, U = null, V = null, seaCells = [], seaMask = null;
  let tFloat = 0, playing = false, loaded = false, loading = false;
  let canvas = null, ctx = null, particles = [], rafId = 0, lastTs = 0;
  let arrowFade = null, colorFade = null, lastWmtsHour = -1;
  let maskLayer = null, maskData = null, maskW = 0, maskH = 0, maskT = null;
  let want = { arrows: false, particles: false, color: false, own: false };
  let onTimeChange = null, statusCb = null;

  const isoHour = s => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
  function makeCmemsLayer(style, opacity, iso, extra) {
    return L.tileLayer(WMTS + '&STYLE=' + encodeURIComponent(style) + '&time=' + encodeURIComponent(iso),
      Object.assign({ opacity, maxNativeZoom: 9, maxZoom: 13, pane: 'tilePane' }, extra || {}));
  }
  function speedColor(kmh) { for (let k = RAMP.length - 1; k >= 0; k--) if (kmh >= RAMP[k][0]) return RAMP[k][1]; return RAMP[0][1]; }

  /* ---- crossfade-manager per WMTS-laag ---- */
  function makeFadeManager(style, maxOpacity) {
    const layers = new Map(); let visibleHour = -1, fadeRAF = 0, on = false;
    function layerFor(hr) {
      if (layers.has(hr)) return layers.get(hr);
      const lyr = makeCmemsLayer(style, 0, isoHour(times[hr])).addTo(map); lyr.setOpacity(0); layers.set(hr, lyr);
      if (layers.size > 8) { let far = -1, fd = -1; for (const h of layers.keys()) { if (h === visibleHour || Math.abs(h - visibleHour) <= 1) continue; const d = Math.abs(h - visibleHour); if (d > fd) { fd = d; far = h; } } if (far >= 0) { map.removeLayer(layers.get(far)); layers.delete(far); } }
      return lyr;
    }
    function show(hr) {
      if (!times || !on) return;
      const target = layerFor(hr), prev = layers.get(visibleHour); if (target === prev) return;
      visibleHour = hr; layerFor(Math.min(NHOURS - 1, hr + 1));
      layers.forEach(l => { if (l !== target && l !== prev) l.setOpacity(0); });
      cancelAnimationFrame(fadeRAF);
      const t0 = performance.now(), dur = 380, of = target.options.opacity || 0, pf = prev ? (prev.options.opacity || 0) : 0;
      const step = now => { const k = Math.min(1, (now - t0) / dur); target.setOpacity(of + (maxOpacity - of) * k); if (prev && prev !== target) prev.setOpacity(pf * (1 - k)); if (k < 1) fadeRAF = requestAnimationFrame(step); };
      fadeRAF = requestAnimationFrame(step);
    }
    function clear() { cancelAnimationFrame(fadeRAF); layers.forEach(l => map.removeLayer(l)); layers.clear(); visibleHour = -1; }
    return { show, clear, setOn(v) { on = v; if (!v) clear(); }, get on() { return on; }, get visibleHour() { return visibleHour; } };
  }

  /* ---- kustlijnmasker uit de kleurlaag ---- */
  const maskCanvas = document.createElement('canvas');
  const mctx = maskCanvas.getContext('2d', { willReadFrequently: true });
  function ensureMask(wantMask) {
    if (wantMask && !maskLayer && times) {
      maskLayer = makeCmemsLayer('cmap:speed,vectorStyle:solid', 0, isoHour(times[Math.round(tFloat)]), { crossOrigin: 'anonymous' });
      maskLayer.addTo(map); maskLayer.on('load', scheduleMaskRedraw);
    } else if (!wantMask && maskLayer) { map.removeLayer(maskLayer); maskLayer = null; maskData = null; }
  }
  function scheduleMaskRedraw() { clearTimeout(maskT); maskT = setTimeout(redrawMask, 60); }
  function redrawMask() {
    if (!maskLayer) return;
    const sz = map.getSize();
    if (maskCanvas.width !== sz.x || maskCanvas.height !== sz.y) { maskCanvas.width = sz.x; maskCanvas.height = sz.y; }
    mctx.clearRect(0, 0, sz.x, sz.y);
    const z = map.getZoom(), tiles = maskLayer._tiles || {};
    for (const k in tiles) {
      const t = tiles[k]; if (!t || !t.el || !t.el.complete || t.el.naturalWidth === 0 || !t.coords) continue;
      const nw = map.unproject(L.point(t.coords.x * 256, t.coords.y * 256), t.coords.z);
      const p = map.latLngToContainerPoint(nw); const scale = 256 * Math.pow(2, z - t.coords.z);
      try { mctx.drawImage(t.el, p.x, p.y, scale, scale); } catch (e) {}
    }
    try { maskData = mctx.getImageData(0, 0, sz.x, sz.y).data; maskW = sz.x; maskH = sz.y; } catch (e) { maskData = null; }
  }

  /* ---- data (Open-Meteo / Copernicus SMOC) ---- */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const CHUNK = 100;
  async function fetchChunk(ch, attempt) {
    attempt = attempt || 0;
    const url = 'https://marine-api.open-meteo.com/v1/marine?latitude=' + ch.map(p => p[0]).join(',')
      + '&longitude=' + ch.map(p => p[1]).join(',')
      + '&hourly=ocean_current_velocity,ocean_current_direction&forecast_days=3&cell_selection=sea&timeformat=unixtime&timezone=GMT';
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if ((r.status === 429 || r.status >= 500) && attempt < 4) { await sleep(700 * (attempt + 1)); return fetchChunk(ch, attempt + 1); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json(); return Array.isArray(j) ? j : [j];
    } catch (e) { if (attempt < 3) { await sleep(600 * (attempt + 1)); return fetchChunk(ch, attempt + 1); } return null; }
  }
  async function loadData() {
    if (loaded || loading) return;
    loading = true; if (statusCb) statusCb('Stromingsdata laden…');
    const pts = [];
    for (let i = 0; i < GRID.nLat; i++) for (let j = 0; j < GRID.nLon; j++) pts.push([+(GRID.lat0 + i * GRID.dLat).toFixed(2), +(GRID.lon0 + j * GRID.dLon).toFixed(2)]);
    const defs = []; for (let s = 0; s < pts.length; s += CHUNK) defs.push({ start: s, pts: pts.slice(s, s + CHUNK) });
    const responses = new Array(defs.length).fill(null);
    for (let s = 0; s < defs.length; s += 2) { const batch = defs.slice(s, s + 2); const rs = await Promise.all(batch.map(d => fetchChunk(d.pts))); rs.forEach((r, i) => { responses[s + i] = r; }); }
    const okResp = responses.find(Boolean);
    if (!okResp) { loading = false; if (statusCb) statusCb('Stromingsdata niet bereikbaar'); setTimeout(loadData, 15000); return; }
    const n = GRID.nLat * GRID.nLon;
    times = okResp[0].hourly.time.slice(0, NHOURS);
    U = new Float32Array(NHOURS * n).fill(NaN); V = new Float32Array(NHOURS * n).fill(NaN); seaCells = []; seaMask = new Uint8Array(n);
    defs.forEach((d, ci) => { const resp = responses[ci]; if (!resp) return; for (let k = 0; k < d.pts.length && k < resp.length; k++) { const p = d.start + k; const h = resp[k].hourly, vel = h.ocean_current_velocity, dir = h.ocean_current_direction; let isSea = false; for (let t = 0; t < NHOURS; t++) { const sp = vel[t], dd = dir[t]; if (sp == null || dd == null) continue; const rad = dd * Math.PI / 180; U[t * n + p] = sp * Math.sin(rad); V[t * n + p] = sp * Math.cos(rad); isSea = true; } if (isSea) { seaCells.push(p); seaMask[p] = 1; } } });
    loaded = true; loading = false; if (statusCb) statusCb('');
    setTimeFloat(nowIndex()); if (onTimeChange) onTimeChange(tFloat);
  }

  /* ---- interpolatie ---- */
  function sampleUVi(lat, lon, t) {
    const n = GRID.nLat * GRID.nLon, fi = (lat - GRID.lat0) / GRID.dLat, fj = (lon - GRID.lon0) / GRID.dLon;
    const i0 = Math.floor(fi), j0 = Math.floor(fj);
    if (i0 < 0 || j0 < 0 || i0 >= GRID.nLat - 1 || j0 >= GRID.nLon - 1) return null;
    const wi = fi - i0, wj = fj - j0; let su = 0, sv = 0, sw = 0;
    for (let di = 0; di <= 1; di++) for (let dj = 0; dj <= 1; dj++) { const idx = t * n + (i0 + di) * GRID.nLon + (j0 + dj); const u = U[idx]; if (Number.isNaN(u)) continue; const w = (di ? wi : 1 - wi) * (dj ? wj : 1 - wj); su += u * w; sv += V[idx] * w; sw += w; }
    if (sw < 0.25) return null; return [su / sw, sv / sw];
  }
  function sampleUV(lat, lon, tf) {
    const t0 = Math.floor(tf), w = tf - t0, a = sampleUVi(lat, lon, t0);
    if (w < 1e-3 || t0 >= NHOURS - 1) return a; const b = sampleUVi(lat, lon, t0 + 1);
    if (!a) return b; if (!b) return a; return [a[0] * (1 - w) + b[0] * w, a[1] * (1 - w) + b[1] * w];
  }
  function isSeaAt(lat, lon) { if (!seaMask) return true; const i = Math.round((lat - GRID.lat0) / GRID.dLat), j = Math.round((lon - GRID.lon0) / GRID.dLon); if (i < 0 || j < 0 || i >= GRID.nLat || j >= GRID.nLon) return false; return seaMask[i * GRID.nLon + j] === 1; }
  function sampleUVarrow(lat, lon, tf) {
    if (!seaMask) return null;
    const fi = (lat - GRID.lat0) / GRID.dLat, fj = (lon - GRID.lon0) / GRID.dLon, i0 = Math.floor(fi), j0 = Math.floor(fj);
    if (i0 < 0 || j0 < 0 || i0 >= GRID.nLat - 1 || j0 >= GRID.nLon - 1) return null;
    for (let di = 0; di <= 1; di++) for (let dj = 0; dj <= 1; dj++) if (!seaMask[(i0 + di) * GRID.nLon + (j0 + dj)]) return null;
    return sampleUV(lat, lon, tf);
  }
  /* eigen vloeiende pijlen — uit het (in de tijd geïnterpoleerde) veld, land-gemaskeerd */
  function drawArrows() {
    const sz = map.getSize(), step = 44;
    ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.globalAlpha = 1;
    for (let x = step * 0.6; x < sz.x; x += step) {
      for (let y = step * 0.6; y < sz.y; y += step) {
        if (maskData) { const mx = x | 0, my = y | 0; if (mx < 0 || my < 0 || mx >= maskW || my >= maskH || maskData[(my * maskW + mx) * 4 + 3] <= 25) continue; }
        const ll = map.containerPointToLatLng([x, y]);
        const uv = maskData ? sampleUV(ll.lat, ll.lng, tFloat) : sampleUVarrow(ll.lat, ll.lng, tFloat);
        if (!uv) continue;
        const u = uv[0], v = uv[1], kmh = Math.hypot(u, v); if (kmh < 0.05) continue;
        const dx = u, dy = -v, m = Math.hypot(dx, dy) || 1, ux = dx / m, uy = dy / m;
        const len = Math.min(step * 0.5, 7 + kmh * 4.2);
        const hx = x + ux * len * 0.5, hy = y + uy * len * 0.5, tx = x - ux * len * 0.5, ty = y - uy * len * 0.5;
        const ah = Math.min(5.5, len * 0.42), ang = Math.atan2(uy, ux);
        ctx.strokeStyle = speedColor(kmh);
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy);
        ctx.lineTo(hx - ah * Math.cos(ang - 0.45), hy - ah * Math.sin(ang - 0.45));
        ctx.moveTo(hx, hy); ctx.lineTo(hx - ah * Math.cos(ang + 0.45), hy - ah * Math.sin(ang + 0.45));
        ctx.stroke();
      }
    }
  }

  /* ---- deeltjes ---- */
  function resizeCanvas() { const sz = map.getSize(); canvas.width = sz.x * devicePixelRatio; canvas.height = sz.y * devicePixelRatio; canvas.style.width = sz.x + 'px'; canvas.style.height = sz.y + 'px'; ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0); }
  function spawnParticle(pt) {
    if (!seaCells.length) return pt; const b = map.getBounds();
    for (let tries = 0; tries < 30; tries++) { const c = seaCells[(Math.random() * seaCells.length) | 0]; const lat = GRID.lat0 + ((c / GRID.nLon) | 0) * GRID.dLat + (Math.random() - .5) * GRID.dLat; const lon = GRID.lon0 + (c % GRID.nLon) * GRID.dLon + (Math.random() - .5) * GRID.dLon; if (b.contains([lat, lon]) && isSeaAt(lat, lon)) { pt.lat = lat; pt.lon = lon; pt.age = 60 + Math.random() * 140; return pt; } }
    const s = map.getSize(), ll = map.containerPointToLatLng([Math.random() * s.x, Math.random() * s.y]); pt.lat = ll.lat; pt.lon = ll.lng; pt.age = 20 + Math.random() * 60; return pt;
  }
  function resetParticles() { if (!canvas) return; const z = map.getZoom(); const count = Math.min(2600, Math.round(280 * Math.pow(1.5, z - 5))); particles = Array.from({ length: count }, () => spawnParticle({})); ctx.clearRect(0, 0, canvas.width, canvas.height); }

  function frame(ts) {
    rafId = requestAnimationFrame(frame);
    const dt = lastTs ? Math.min(0.08, (ts - lastTs) / 1000) : 0; lastTs = ts;
    if (playing && times) { tFloat += dt * PLAY_HPS; if (tFloat >= NHOURS - 1) tFloat = 0; updateWmtsTime(); if (onTimeChange) onTimeChange(tFloat); }
    if (!canvas || (!want.particles && !want.own) || !U) return;
    const sz = map.getSize();
    if (want.particles) {
      ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = 'rgba(0,0,0,0.040)'; ctx.fillRect(0, 0, sz.x, sz.y);
      ctx.globalCompositeOperation = 'source-over'; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
      const speedScale = 0.00060 * Math.pow(1.18, map.getZoom() - 6);
      for (const p of particles) {
        if (--p.age <= 0) { spawnParticle(p); continue; }
        const uv = sampleUV(p.lat, p.lon, tFloat); if (!uv) { spawnParticle(p); continue; }
        const u = uv[0], v = uv[1], kmh = Math.hypot(u, v);
        const nLat = p.lat + v * speedScale / 1.5, nLon = p.lon + u * speedScale / (1.5 * Math.cos(p.lat * Math.PI / 180));
        const a = map.latLngToContainerPoint([p.lat, p.lon]), b2 = map.latLngToContainerPoint([nLat, nLon]);
        if (b2.x < -20 || b2.y < -20 || b2.x > sz.x + 20 || b2.y > sz.y + 20) { spawnParticle(p); continue; }
        let onLand; if (maskData) { const mx = b2.x | 0, my = b2.y | 0; onLand = mx < 0 || my < 0 || mx >= maskW || my >= maskH || maskData[(my * maskW + mx) * 4 + 3] <= 25; } else onLand = !isSeaAt(nLat, nLon);
        if (onLand) { spawnParticle(p); continue; }
        p.lat = nLat; p.lon = nLon;
        ctx.strokeStyle = speedColor(kmh); ctx.globalAlpha = Math.min(0.95, 0.4 + kmh / 4);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b2.x, b2.y); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else {
      ctx.clearRect(0, 0, sz.x, sz.y);
    }
    if (want.own) drawArrows();
  }

  /* ---- tijd ---- */
  function defaultTimes() { const midnight = Math.floor(Date.now() / 86400000) * 86400; return Array.from({ length: NHOURS }, (_, i) => midnight + i * 3600); }
  function nowIndex() { const now = Date.now() / 1000; let best = 0; for (let i = 0; i < times.length; i++) if (Math.abs(times[i] - now) < Math.abs(times[best] - now)) best = i; return best; }
  function updateWmtsTime() { if (!times) return; const hr = Math.round(tFloat); if (hr === lastWmtsHour) return; lastWmtsHour = hr; if (arrowFade && arrowFade.on) arrowFade.show(hr); if (colorFade && colorFade.on) colorFade.show(hr); }
  function setTimeFloat(tf) { tFloat = Math.max(0, Math.min(NHOURS - 1, tf)); updateWmtsTime(); }

  function sync() {
    if (!arrowFade) return;
    const hr = Math.round(tFloat);
    arrowFade.setOn(want.arrows); if (want.arrows && arrowFade.visibleHour < 0) arrowFade.show(hr);
    colorFade.setOn(want.color); if (want.color && colorFade.visibleHour < 0) colorFade.show(hr);
    lastWmtsHour = hr;
    const canvasOn = want.particles || want.own;
    ensureMask(canvasOn); if (canvasOn) scheduleMaskRedraw();
    if (canvas) canvas.style.display = canvasOn ? 'block' : 'none';
    if (canvasOn && !loaded) loadData();
    if (want.particles) resetParticles();
  }

  const API = {
    init(m) {
      if (map) return API; map = m;
      canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:absolute;inset:0;z-index:350;pointer-events:none;display:none';
      map.getContainer().appendChild(canvas); ctx = canvas.getContext('2d');
      times = defaultTimes();
      arrowFade = makeFadeManager('cmap:speed,vectorStyle:vector', 0.92);
      colorFade = makeFadeManager('cmap:speed,vectorStyle:solid', 0.55);
      map.on('resize', () => { resizeCanvas(); resetParticles(); scheduleMaskRedraw(); });
      map.on('moveend zoomend', () => { resetParticles(); scheduleMaskRedraw(); });
      map.on('movestart zoomstart', () => ctx && ctx.clearRect(0, 0, canvas.width, canvas.height));
      resizeCanvas(); setTimeFloat(nowIndex()); requestAnimationFrame(frame);
      return API;
    },
    setLayers(w) { want = Object.assign({}, want, w); sync(); },
    anyOn() { return want.arrows || want.particles || want.color || want.own; },
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
