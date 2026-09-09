/* OpenPilot brugstatus — Cloudflare Worker
 *
 * Haalt elke minuut de open NDW-data op (actueel beeld + planningsfeed
 * brugopeningen), filtert de brugopeningen eruit, koppelt ze aan de
 * OpenPilot-objecten (static.json.gz) en serveert compacte JSON met CORS.
 * Elke opening/sluiting wordt in D1 gelogd — eigen historie, geen derde partij.
 *
 * Bron: NDW (Nationaal Dataportaal Wegverkeer), opendata.ndw.nu, CC-0/open.
 *
 * Endpoints (alle met Access-Control-Allow-Origin: *):
 *   /status.json              nu open + geplande openingen komende 2 u (klein, elke minuut opgehaald)
 *   /planned.json?sid=B1504   volledige planning (~24 u), optioneel per brug
 *   /bridges.json             register van alle bruggen die ooit in de feed zaten
 *   /history.json?sid=B1504   openingen van één brug (of ?code=<ISRS>), ?days=30
 *   /stats.json?sid=B1504     openingen per weekdag/uur, laatste 90 dagen
 *   /health                   laatste pollronde
 */

const NDW_ACTUEEL  = "https://opendata.ndw.nu/actueel_beeld.xml.gz";
const NDW_PLANNING = "https://opendata.ndw.nu/planningsfeed_brugopeningen.xml.gz";
const SITE_STATIC  = "https://cjroyaards.github.io/bruggen-sluizen/data/static.json.gz";
const MATCH_M      = 250;        // max afstand NDW-punt ↔ OpenPilot-brug
const PLAN_HOURS   = 2;          // horizon geplande openingen in status.json (volledige planning: /planned.json)

/* Klok: een Durable Object dat zichzelf elke minuut wekt (alarm). Onafhankelijk van
   Cloudflare-cron-triggers, die op dit account niet afgaan. Wordt gestart via /start
   en herstart zichzelf; elke /status.json-aanroep controleert of hij nog loopt. */
export class Poller {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(req) {
    const url = new URL(req.url);
    const cur = await this.state.storage.getAlarm();
    if (url.pathname === "/start" && cur == null) await this.state.storage.setAlarm(Date.now() + 1000);
    return new Response(JSON.stringify({ alarm: cur ? new Date(cur).toISOString() : null }), { headers: { "Content-Type": "application/json" } });
  }
  async alarm() {
    await this.state.storage.setAlarm(Date.now() + 60_000);       // eerst herplannen, dan werken
    try { await pollIfStale(this.env, 45e3); } catch (_) {}
  }
}
async function ensureClock(env) {
  if (!env.POLLER) return null;
  const stub = env.POLLER.get(env.POLLER.idFromName("klok"));
  return stub.fetch("https://klok/start");
}

export default {
  // Cloudflare-cron: draait de nachtelijke catalogus (die gaat wél af); minuutcron als extra vangnet
  async scheduled(event, env, ctx) {
    ctx.waitUntil(event.cron === "7 3 * * *" ? runPoll(env, event.cron) : pollIfStale(env, 45e3));
  },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors() });
    try {
      switch (url.pathname) {
        case "/":              return index();
        case "/start":         return json(await (await ensureClock(env)).json());
        case "/status.json":   ctx.waitUntil(Promise.all([pollIfStale(env), ensureClock(env)])); return kvJson(env, "status", 20);
        case "/bridges.json":  return kvJson(env, "bridges", 300);
        case "/planned.json":  return planned(env, url);
        case "/health":        return kvJson(env, "health", 0);
        case "/history.json":  return history(env, url);
        case "/stats.json":    return stats(env, url);
        case "/poll":          // aanstoten door GitHub Action / handmatig; slaat over als data < 45 s oud is
          await pollIfStale(env, 45e3);
          ctx.waitUntil(ensureClock(env));
          return kvJson(env, "health", 0);
        default:               return json({ error: "not found" }, 404);
      }
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};

/* vangnet: als de cron om wat voor reden niet loopt, ververst een bezoeker de data
   zodra die ouder is dan 90 s (met slot in KV zodat niet iedereen tegelijk pollt) */
async function pollIfStale(env, maxAge = 90e3) {
  const h = await env.KV.get("health", "json");
  if (h && h.ts && Date.now() - Date.parse(h.ts) < maxAge) return;
  if (await env.KV.get("lock")) return;
  await env.KV.put("lock", "1", { expirationTtl: 60 });
  await runPoll(env, "* * * * *");
}

/* ---------- pollronde ---------- */
async function runPoll(env, cron) {
  const t0 = Date.now();
  const health = (await env.KV.get("health", "json")) || {};
  try {
    if (cron === "7 3 * * *") { await refreshSiteCatalog(env); health.catalogTs = new Date().toISOString(); }
    else {
      const minute = new Date().getUTCMinutes();
      await pollActueel(env, health);
      if (minute % 5 === 0 || !health.plannedTs) await pollPlanning(env, health);
      await writeStatus(env);
    }
    health.ok = true; health.error = null;
  } catch (e) {
    health.ok = false; health.error = String(e && e.message || e);
  }
  health.ts = new Date().toISOString();
  health.ms = Date.now() - t0;
  health.by = cron;   // wie pollde: "* * * * *" = klok/cron/poll, "7 3 * * *" = catalogus
  await env.KV.put("health", JSON.stringify(health));
}

/* actueel beeld: alleen bruggen die NU open zijn staan erin */
async function pollActueel(env, health) {
  const xml = await fetchXml(NDW_ACTUEEL);
  const recs = parseBridgeRecords(xml).filter(r => r.prob !== "riskOf");
  const now = Date.now();
  const prev = (await env.KV.get("open", "json")) || {};
  const reg  = (await env.KV.get("bridges", "json")) || { bridges: {} };
  const cat  = await getSiteCatalog(env);
  const open = {};
  const closed = [];
  let changed = false;

  for (const r of recs) {
    if (!r.code) continue;
    const b = ensureBridge(reg, r, cat);
    let p = prev[r.code];
    // NDW schuift de begintijd op als de brug tussentijds dicht en weer open ging (zelfde bericht-id):
    // > 2 min later dan wat wij hadden → vorige opening afsluiten, nieuwe beginnen
    if (p && r.start && Date.parse(r.start) - Date.parse(p.since) > 120e3) { closed.push({ ...p, endAt: r.start }); p = null; }
    open[r.code] = {
      code: r.code, sid: b.sid || null, name: b.name || null, city: b.city || null,
      lat: b.lat, lon: b.lon,
      since: p ? p.since : (r.start || new Date(now).toISOString()),
      until: r.end || null, src: r.src || null, ndwId: r.id,
    };
    if (!p) { b.n = (b.n || 0) + 1; b.last = open[r.code].since; changed = true; }
  }
  // gesloten sinds vorige ronde → loggen in D1
  for (const p of Object.values(prev)) if (!open[p.code]) closed.push(p);
  if (closed.length && env.DB) {
    // sluittijd = nu; maar na een gat in het pollen (> 3 min) weten we het niet → end = null
    const gap = health.actueelTs ? now - Date.parse(health.actueelTs) : 0;
    const nowIso = gap > 180e3 ? null : new Date(now).toISOString();
    const stmt = env.DB.prepare("INSERT OR IGNORE INTO openings (code, sid, start, end, src) VALUES (?1, ?2, ?3, ?4, ?5)");
    await env.DB.batch(closed.map(p => stmt.bind(p.code, p.sid, p.since, p.endAt ? (gap > 180e3 ? null : p.endAt) : nowIso, p.src)));
    changed = true;
  }
  await env.KV.put("open", JSON.stringify(open));
  if (changed || !reg.ts) { reg.ts = new Date(now).toISOString(); await env.KV.put("bridges", JSON.stringify(reg)); }
  health.actueelTs = new Date(now).toISOString();
  health.nOpen = Object.keys(open).length;
  health.nRecords = recs.length;
}

/* planningsfeed: geplande openingen (riskOf) — vooral BMS Noord-Holland/Amsterdam */
async function pollPlanning(env, health) {
  const xml = await fetchXml(NDW_PLANNING);
  const now = Date.now();
  const recs = parseBridgeRecords(xml);
  const reg = (await env.KV.get("bridges", "json")) || { bridges: {} };
  const cat = await getSiteCatalog(env);
  const items = [];
  let regChanged = false;
  for (const r of recs) {
    if (!r.code || !r.end) continue;
    const end = Date.parse(r.end);
    if (isNaN(end) || end < now) continue;
    const before = reg.bridges[r.code];
    const b = ensureBridge(reg, r, cat);
    if (!before) regChanged = true;
    items.push({ code: r.code, sid: b.sid || null, name: b.name || null, lat: b.lat, lon: b.lon,
      start: r.start, end: r.end, planned: r.prob === "riskOf", src: r.src || null });
  }
  items.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  await env.KV.put("planned", JSON.stringify({ ts: new Date(now).toISOString(), items }));
  if (regChanged) { reg.ts = new Date(now).toISOString(); await env.KV.put("bridges", JSON.stringify(reg)); }
  health.plannedTs = new Date(now).toISOString();
  health.nPlanned = items.length;
}

/* status.json samenstellen: open + planning komende PLAN_HOURS */
async function writeStatus(env) {
  const open = (await env.KV.get("open", "json")) || {};
  const pl = (await env.KV.get("planned", "json")) || { items: [] };
  const horizon = Date.now() + PLAN_HOURS * 3600e3;
  const planned = pl.items.filter(i => i.planned && Date.parse(i.start) < horizon && !open[i.code]);
  const status = { ts: new Date().toISOString(), src: "NDW", open: Object.values(open), planned, plannedTs: pl.ts || null };
  await env.KV.put("status", JSON.stringify(status));
}

/* ---------- register & koppeling aan OpenPilot-objecten ---------- */
function ensureBridge(reg, r, cat) {
  let b = reg.bridges[r.code];
  if (!b) {
    b = reg.bridges[r.code] = { code: r.code, lat: r.lat, lon: r.lon, n: 0, last: null, first: new Date().toISOString() };
  }
  if ((b.lat == null || isNaN(b.lat)) && r.lat != null) { b.lat = r.lat; b.lon = r.lon; }
  if (!b.sid && cat && b.lat != null) {
    const m = nearest(cat, b.lat, b.lon);
    if (m) { b.sid = "B" + m.id; b.name = m.n; b.city = m.c; b.fw = m.fw; b.dist = Math.round(m.dist); }
  }
  return b;
}

async function getSiteCatalog(env) {
  let cat = await env.KV.get("sitecat", "json");
  if (!cat) { cat = await refreshSiteCatalog(env); }
  return cat;
}
async function refreshSiteCatalog(env) {
  const res = await fetch(SITE_STATIC, { cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error("static.json.gz " + res.status);
  const txt = await maybeGunzip(await res.arrayBuffer());
  const d = JSON.parse(txt);
  // alleen beweegbare bruggen; compact
  const cat = d.objs.filter(o => o.t === "B" && o.open && o.lat != null)
    .map(o => ({ id: o.id, n: o.n, c: o.c || "", fw: o.fw || "", lat: o.lat, lon: o.lon }));
  await env.KV.put("sitecat", JSON.stringify(cat));
  // bestaande registerregels alsnog koppelen (nieuwe bruggen in de site, betere match)
  const reg = (await env.KV.get("bridges", "json")) || { bridges: {} };
  let ch = false;
  for (const b of Object.values(reg.bridges)) {
    if (b.lat == null) continue;
    const m = nearest(cat, b.lat, b.lon);
    if (m && b.sid !== "B" + m.id) { b.sid = "B" + m.id; b.name = m.n; b.city = m.c; b.fw = m.fw; b.dist = Math.round(m.dist); ch = true; }
  }
  if (ch) await env.KV.put("bridges", JSON.stringify(reg));
  return cat;
}
function nearest(cat, lat, lon) {
  let best = null, bd = MATCH_M;
  const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
  for (const o of cat) {
    const dy = (o.lat - lat) * ky; if (dy > bd || dy < -bd) continue;
    const dx = (o.lon - lon) * kx; if (dx > bd || dx < -bd) continue;
    const d = Math.hypot(dx, dy);
    if (d < bd) { bd = d; best = o; }
  }
  return best ? { ...best, dist: bd } : null;
}

/* ---------- NDW DATEX II v3 parsen (regex, geen XML-lib nodig) ---------- */
async function fetchXml(url) {
  const res = await fetch(url, { cf: { cacheTtl: 0 }, headers: { "User-Agent": "OpenPilot-brugstatus (cjroyaards.github.io/bruggen-sluizen)" } });
  if (!res.ok) throw new Error(url + " → " + res.status);
  return maybeGunzip(await res.arrayBuffer());
}
async function maybeGunzip(buf) {
  const h = new Uint8Array(buf, 0, 2);
  if (h[0] === 0x1f && h[1] === 0x8b) {
    const ds = new DecompressionStream("gzip");
    return await new Response(new Blob([buf]).stream().pipeThrough(ds)).text();
  }
  return new TextDecoder().decode(buf);
}
export function parseBridgeRecords(xml) {
  const out = [];
  const parts = xml.split("<sit:situation ");
  for (let i = 1; i < parts.length; i++) {
    const s = parts[i];
    if (s.indexOf("bridgeSwingInOperation") < 0) continue;
    const g = re => { const m = re.exec(s); return m ? m[1] : null; };
    const lat = g(/<loc:latitude>([^<]+)/), lon = g(/<loc:longitude>([^<]+)/);
    out.push({
      id:    g(/^id="([^"]+)"/),
      code:  g(/externalLocationCode>([^<]+)/),
      lat:   lat != null ? +lat : null, lon: lon != null ? +lon : null,
      start: g(/overallStartTime>([^<]+)/),
      end:   g(/overallEndTime>([^<]+)/),
      prob:  g(/probabilityOfOccurrence>([^<]+)/),
      src:   g(/<com:value lang="nl">([^<]+)/),
      ver:   g(/situationVersionTime>([^<]+)/),
      status:g(/operatorActionStatus>([^<]+)/),
    });
  }
  return out;
}

/* volledige planning (komende ~24 u), optioneel gefilterd: /planned.json?sid=B1504 of ?code=… */
async function planned(env, url) {
  const pl = (await env.KV.get("planned", "json"));
  if (!pl) return json({ error: "no data yet" }, 503);
  const sid = url.searchParams.get("sid"), code = url.searchParams.get("code");
  const now = Date.now();
  let items = pl.items.filter(i => Date.parse(i.end) > now);
  if (sid) items = items.filter(i => i.sid === sid);
  if (code) items = items.filter(i => i.code === code);
  return json({ ts: pl.ts, items }, 200, 60);
}

/* ---------- historie (D1) ---------- */
async function resolveCode(env, url) {
  const code = url.searchParams.get("code");
  if (code) return code;
  const sid = url.searchParams.get("sid");
  if (!sid) return null;
  const reg = (await env.KV.get("bridges", "json")) || { bridges: {} };
  const b = Object.values(reg.bridges).find(b => b.sid === sid);
  return b ? b.code : null;
}
async function history(env, url) {
  if (!env.DB) return json({ error: "no database" }, 503);
  const code = await resolveCode(env, url);
  if (!code) return json({ error: "sid or code required" }, 400);
  const days = Math.min(365, Math.max(1, +(url.searchParams.get("days") || 30)));
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const { results } = await env.DB.prepare("SELECT start, end, src FROM openings WHERE code=?1 AND start>=?2 ORDER BY start DESC LIMIT 2000").bind(code, since).all();
  return json({ code, days, openings: results }, 200, 60);
}
async function stats(env, url) {
  if (!env.DB) return json({ error: "no database" }, 503);
  const code = await resolveCode(env, url);
  if (!code) return json({ error: "sid or code required" }, 400);
  const since = new Date(Date.now() - 90 * 86400e3).toISOString();
  const { results } = await env.DB.prepare("SELECT start, end FROM openings WHERE code=?1 AND start>=?2").bind(code, since).all();
  const byHour = new Array(24).fill(0), byDow = new Array(7).fill(0), matrix = Array.from({ length: 7 }, () => new Array(24).fill(0));
  let durSum = 0, durN = 0;
  for (const r of results) {
    const d = new Date(r.start);
    // uur/weekdag in Europe/Amsterdam
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", hour: "2-digit", weekday: "short", hour12: false }).formatToParts(d);
    const h = +p.find(x => x.type === "hour").value % 24;
    const dow = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[p.find(x => x.type === "weekday").value];
    byHour[h]++; byDow[dow]++; matrix[dow][h]++;
    if (r.end) { const dur = (Date.parse(r.end) - Date.parse(r.start)) / 60e3; if (dur > 0 && dur < 180) { durSum += dur; durN++; } }
  }
  return json({ code, days: 90, total: results.length, avgMinutes: durN ? +(durSum / durN).toFixed(1) : null, byHour, byDow, matrix }, 200, 300);
}

/* ---------- helpers ---------- */
function cors() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" };
}
function json(obj, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors(), "Content-Type": "application/json; charset=utf-8", "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store" } });
}
async function kvJson(env, key, maxAge) {
  const v = await env.KV.get(key);
  if (v == null) return json({ error: "no data yet" }, 503);
  return new Response(v, { headers: { ...cors(), "Content-Type": "application/json; charset=utf-8", "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store" } });
}
function index() {
  const html = `<!doctype html><meta charset="utf-8"><title>OpenPilot brugstatus</title>
<style>body{font:15px/1.5 system-ui;max-width:640px;margin:40px auto;padding:0 16px;color:#222}code{background:#f2f2f2;padding:1px 5px;border-radius:4px}</style>
<h1>OpenPilot brugstatus</h1>
<p>Realtime brugopeningen uit de open data van <a href="https://opendata.ndw.nu">NDW</a>, gekoppeld aan de bruggen van <a href="https://cjroyaards.github.io/bruggen-sluizen/">OpenPilot</a>.</p>
<ul>
<li><a href="/status.json"><code>/status.json</code></a> — nu open + geplande openingen (24 u)</li>
<li><a href="/planned.json"><code>/planned.json?sid=B1504</code></a> — volledige planning (~24 u)</li>
<li><a href="/bridges.json"><code>/bridges.json</code></a> — register</li>
<li><code>/history.json?sid=B1504&amp;days=30</code> — openingen per brug</li>
<li><code>/stats.json?sid=B1504</code> — patroon per weekdag/uur</li>
<li><a href="/health"><code>/health</code></a></li>
</ul><p>Bron: NDW. Vrij te gebruiken met bronvermelding.</p>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", ...cors() } });
}
