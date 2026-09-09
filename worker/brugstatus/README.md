# OpenPilot brugstatus — Cloudflare Worker

Realtime brugopeningen uit de open data van **NDW** (opendata.ndw.nu), zonder
tussenpartij. De Worker pollt elke minuut, koppelt de NDW-bruggen aan de
OpenPilot-objecten en logt elke opening in een eigen database.

```
NDW actueel_beeld.xml.gz  ─┐  cron */1 min      KV: status / open / bridges
NDW planningsfeed  ────────┤─▶  Worker  ─────▶  D1: openings (historie)
OpenPilot static.json.gz ──┘  cron 03:07        ▼
                                       /status.json · /bridges.json · /history.json · /stats.json
                                                ▼
                                index.html (BRUGSTATUS_URL, elke 60 s)
```

## Eenmalige installatie (±10 minuten)

Vereist: Cloudflare-account met **Workers Paid** ($5/mnd — nodig voor de
CPU-tijd om 3,5 MB XML per minuut te verwerken) en Node.js op de Mac.

```bash
cd worker/brugstatus
npm install                                   # wrangler
npx wrangler login                            # opent browser, eenmalig

npx wrangler kv namespace create KV           # → id kopiëren
npx wrangler d1 create brugstatus             # → database_id kopiëren
#   beide id's in wrangler.toml plakken (vervang VUL_IN_…)

npm run schema                                # tabel aanmaken in D1
npm run deploy                                # → https://brugstatus.<jouw-subdomein>.workers.dev
```

**Let op — de klok.** Op dit Cloudflare-account gaat de minuut-cron-trigger
niet af (bekend Cloudflare-probleem in 2026: geregistreerd, "Next" loopt door,
maar `scheduled()` wordt nooit aangeroepen; de nachtelijke 03:07 gaat wél).
Het minuutwerk doet daarom een **Durable Object** (`Poller`, naam "klok") dat
zichzelf elke minuut wekt met een alarm. Starten: één keer `/start` openen
(elke `/status.json`- en `/poll`-aanroep doet dat ook). Vangnetten daarbovenop:
`.github/workflows/brugstatus-poll.yml` roept elke 10 min `/poll` + `/start`
aan, en `status.json` ververst zichzelf als de data ouder is dan 90 s. Alles
slaat over als de data jonger is dan 45 s, dus niets bijt elkaar.
`/health` toont in `by` wie de laatste ronde deed.

Daarna:

1. De URL uit `wrangler deploy` in `index.html` zetten bij `BRUGSTATUS_URL`
   (bovenin het blok "live brugstatus"). Buildstamp ophogen, pushen.
2. Eerste vulling: open `https://…workers.dev/poll`.
3. Controleren: `/health` (moet `ok:true` en `nOpen` tonen), `/status.json`.

## Endpoints

| Pad | Inhoud | Cache |
|---|---|---|
| `/status.json` | `open[]` (nu open: code, sid, name, since, until) + `planned[]` komende 2 u | 20 s |
| `/planned.json?sid=B1504` | volledige planning (~24 u), optioneel per brug | 1 min |
| `/poll` | pollronde aanstoten (overgeslagen als data < 45 s) | — |
| `/bridges.json` | register van alle bruggen die ooit in de feed zaten, met koppeling `sid` (B<id>) | 5 min |
| `/history.json?sid=B1504&days=30` | openingen per brug (ook `?code=<ISRS>`) | 1 min |
| `/stats.json?sid=B1504` | aantal per uur/weekdag, gemiddelde duur (90 dagen) | 5 min |
| `/health` | laatste pollronde, fouten | — |

Alle antwoorden hebben `Access-Control-Allow-Origin: *`.

## Hoe het werkt

- **actueel_beeld.xml.gz** (DATEX II v3): bevat alle situatieberichten op de
  weg; bruggen die *nu* open staan hebben `generalNetworkManagementType =
  bridgeSwingInOperation`. Bron per record: `BMS01` (bedieningscentrales,
  met geplande eindtijd), `MOS01`/`ODS01` (sensoren, zonder eindtijd).
- **planningsfeed_brugopeningen.xml.gz**: geplande openingen
  (`probabilityOfOccurrence = riskOf`), vooral Noord-Holland/Amsterdam.
  Elke 5 minuten opgehaald.
- **Koppeling**: NDW identificeert bruggen met een ISRS-code en WGS84-punt;
  de Worker zoekt de dichtstbijzijnde beweegbare OpenPilot-brug binnen 250 m
  (`sitecat` in KV, dagelijks ververst uit `static.json.gz`). De site doet
  hetzelfde als fallback voor records zonder `sid`.
- **Historie**: als een brug uit de open-lijst verdwijnt wordt de opening
  (start, eind, bron) in D1 geschreven. Groeit vanzelf; na een paar weken
  zijn `/stats.json`-patronen bruikbaar.

## Onderhoud

- Logs live: `npm run tail`
- Parser testen tegen de live feeds (zonder Cloudflare): `npm test`
- NDW wijzigt de feeds zelden; bij een lege `nOpen` langere tijd → `/health`
  bekijken en `npm test` draaien.
- Kosten: Workers Paid $5/mnd; KV en D1 blijven ruim binnen de gratis
  bundels (≈5k schrijfacties/dag op KV, D1 enkele MB/jaar).

Bron­vermelding op de site: "brugopeningen: NDW".
