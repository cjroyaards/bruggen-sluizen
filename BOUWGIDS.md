# OpenPilot — bouwgids voor ontwikkelaars

Deze gids is voor iedereen (mens of AI-assistent) die meebouwt aan OpenPilot.
Lees hem vóór je eerste wijziging; hij beschrijft hoe de site in elkaar zit,
waar de data vandaan komt en welke afspraken we hanteren.

## Wat is het

Een statische site (GitHub Pages, geen backend) voor de recreatievaart:
bedieningstijden van alle NL-bruggen en -sluizen, actuele stremmingen,
getijden (NL + UK), stroming & wind met voorspelling, een zeekaartmodus met
eigen dieptedata, VTS-sectoren, havens en een eenvoudige plotter met
NMEA-koppeling. Tweetalig NL/EN. Live op de GitHub Pages-URL van deze repo.

## Architectuur

- **`index.html`** — de hele app: HTML, CSS én de hoofd-JavaScript in één
  bestand (~2900 regels). Bewust één bestand: simpel te deployen en te cachen.
- **`currents.js`** — getijstroomlaag, volledig op Copernicus Marine (NWShelf, 1,5 km).
  Pijlen en kleurvlakken zijn WMTS-tegels, op élk zoomniveau dezelfde laag (niet omschakelen
  bij zoomen — dat kostte eerder de pijlen). Het veld voor de deeltjes komt uit dezelfde bron
  door de uo/vo-kleurtegels via de GetLegend-colormap terug te rekenen naar m/s (alfa=0 is
  meteen het landmasker). Klik-info en de 12-uurstabel via GetFeatureInfo. Tot 6 dagen vooruit.
  Twee tests: `scripts/test_currents_decode.js` (decodering tegen echte modelwaarden) en
  `scripts/test_currents_layers.js` (laagbeheer bij zoomen en tijdsprongen).
- **`wind.js`** — windlaag (Open-Meteo-API, deeltjesanimatie, kleurlagen,
  7-daagse puntvoorspelling). Deelt de tijdbalk met `currents.js`.
- **`data/`** — alle vooraf gebouwde databestanden (zie hieronder).
- **`scripts/`** — Python-scripts die de data bouwen/verversen.
- **`assets/`** — Leaflet, markercluster, app-iconen (kompasroos).
- Kaart: **Leaflet** met `preferCanvas:true`. Lagen zitten in panes met vaste
  z-volgorde: depthPane 250 (dieptevlakken) < depthLinePane 265 < bathyPane 270
  < iencPane 300 < encPane 320 < seaPane 350 (betonning/OpenSeaMap).

## Data & pijplijnen

| Bestand | Inhoud | Bron / hoe ververst |
|---|---|---|
| `data/static.json.gz` | alle bruggen/sluizen + bedieningstijden | GitHub Action dagelijks (`scripts/build_data.py`, RWS FIS) |
| `data/strem.json` | actuele stremmingen | GitHub Action elk uur |
| `data/nltides.json`, `data/uktides.json` | getijvoorspellingen | GitHub Actions (`scripts/fetch_tides*.py`) |
| `data/depth_smooth.geojson` | gladde dieptevlakken NL+omstreken | EMODnet-bathymetrie, pijplijn hieronder |
| `data/depth_kanaalwest.geojson`, `data/depth_denemarken.geojson`, … | dieptevlakken per Europese regio, lazy geladen | `scripts/depth_region.py` |
| `data/depth.geojson`, `data/depth_lines.geojson` | dieptelijnen (1m/5m, 2m-lijn) | RWS Inland ENC (S-57), GDAL |
| `data/coast.geojson` | eigen kustlijn (COALNE) | RWS Inland ENC |
| `data/buoys_nl.geojson` | officiële NL-betonning (nu **uitgeschakeld** in de UI; OpenSeaMap toont de tekens) | RWS Inland ENC |
| `data/de_water.geojson` | Duitse Rijn als waterlint | ELWIS Inland ENC (EU-RIS, vrij gebruik) |
| `data/ukharbours.json` | gecureerde haveninfo | met de hand onderhouden |
| `data/texts_en.json` | AI-vertaalde EN-teksten (opzoektabel) | zie "Tweetaligheid" |

### Dieptevlakken (EMODnet-pijplijn)

Nieuwe Europese regio toevoegen: `python3 scripts/depth_region.py <naam> W S E N zeezaadLon zeezaadLat`
(let op: paden in de scripts wijzen naar de repo-root; draai vanuit een map waar
je schrijfrechten hebt). Het script haalt EMODnet-bathymetrie per WCS op,
haalt de OSM-kustlijn als barrière binnen (Overpass is traag/rate-limited:
cache en geduld), flood-fillt het watermasker vanaf het zeezaad, smootht
(gaussian σ1,5), maakt cumulatieve banden (−5/0/2/5/10/15/20 m, tags
`w,b0,b2,b5,b10,b15,b20`) en rondt hoeken af met buffer-trucs.
Daarna registreren in `DEPTH_REGIONS` in `index.html` (bbox + bestandsnaam);
de app laadt regio's lazy zodra de kaart erover schuift.
`depth_landclip.py` (vlakken van land/dammen afknippen met ENC-LNDARE) en
`depth_cliplines.py` (dieptelijnen van land knippen) horen bij deze pijplijn.

### ENC-data (RWS / ELWIS)

S-57-cellen (.000) omzetten met GDAL:
`OGR_S57_OPTIONS="RETURN_PRIMITIVES=OFF,RETURN_LINKAGES=OFF,LNAM_REFS=OFF,SPLIT_MULTIPOINT=ON,ADD_SOUNDG_DEPTH=ON" ogr2ogr …`
Relevante lagen: DEPARE, DEPCNT, COALNE, LNDARE, BOYLAT/BOYCAR/BOYSPP/BOYISD/
BOYSAW, BCNLAT/BCNCAR, LIGHTS. RWS-cellen zijn wekelijks vers en CC-0.

## Tweetaligheid

- UI-labels: `EN`-woordenboek + `T()` in `index.html`.
- Vrije RWS/haven-teksten: **AI-vertaalde opzoektabel** `data/texts_en.json`
  (exacte NL-tekst → EN). `xen(t)` zoekt op; **staat een tekst er niet in, dan
  toont de site gewoon het Nederlands** — er breekt dus nooit iets.
- Bijwerken na een dataverversing: `python3 scripts/vertaalcheck.py` toont wat
  er nieuw/onvertaald is (en schrijft `data/onvertaald.json`). Vertaal die
  teksten (met AI), voeg ze toe aan `data/texts_en.json`, klaar.
- Objectnamen blijven eigennamen; alleen beschrijvende delen worden vertaald
  via `enName()` ("Brug over binnenhoofd X" → "Bridge over inner head X").

## Afspraken (belangrijk!)

1. **Hoofdbouw loopt via Kees** (rechtstreeks op `main`). Bouw je mee, werk
   dan **in een eigen branch en maak een pull request**; die kijken we na en
   voegen we samen. Alles op `main` staat ±5–10 min later live
   (GitHub Pages, cache `max-age=600`).
2. **Buildstamp ophogen bij elke sitewijziging**: onderin `index.html` staat
   `<span id="buildstamp">bJJJJMMDD-N</span>`. Verhoog N (of de datum). Zo zie
   je op elk apparaat of je de nieuwste versie hebt. Data-/README-wijzigingen
   hoeven niet.
3. **Test vóór je pusht**: minstens `node --check` op het uitgeknipte
   inline-script en de site lokaal openen (`python3 -m http.server`).
   E2E kan met Playwright (headless Chromium); netwerk-API's (Open-Meteo,
   Overpass) zijn vanuit sommige sandboxes niet bereikbaar — injecteer dan
   synthetische data.
4. **Geen zware bestanden zonder reden**: data/geojson wordt met 4 decimalen
   afgerond en ontdaan van snippers; hou nieuwe regio-bestanden ≤ ~6 MB.
5. De site is **geen officiële navigatiebron** — houd de disclaimers intact.

## Bekende beperkingen / valkuilen

- **NMEA over het netwerk**: browsers kunnen géén rauwe TCP/UDP aan; alleen
  WebSocket. En `ws://` mag alleen vanaf een http-pagina — github.io is
  verplicht https, dus directe koppelingen werken pas op een eigen domein met
  http-"boordmodus", of via `wss://`, of via de losse OpenPilot NMEA-brug op
  de computer (WebSocket op `ws://localhost:8100`). YDWG-02 (recente firmware,
  `/ws`), iKommunicate en SignalK-servers kunnen direct.
- **Copernicus-stromingstegels** gaan native maar tot zoom 9; daarboven neemt
  de eigen pijlenlaag het over.
- **Overpass** (OSM) is vaak rate-limited: altijd cachen, ruime time-outs,
  mirrors afwisselen.
- **Telefoonmodus** (mediaquery max-width 640px of landscape+coarse pointer):
  eigen compacte layout — bottom-sheet-plotter met vaste 2×2, menuknoppen,
  ingeklapte legenda. Test wijzigingen dus óók op een smal scherm.
- **iOS cachet hardnekkig**: daarom de buildstamp. Privé-tabblad of
  opnieuw-toevoegen-aan-beginscherm helpt bij twijfel.

## Routeplanner (`route.js` + `scripts/build_net.py`)

Kaartknop **Route**: eerste klik = start, elke volgende klik = via-punt,
rechtsklik = bestemming. A* draait client-side over `data/net.json.gz`.

**Bron: het officiële vaarwegennetwerk van Rijkswaterstaat** (FIS
`section` + `fairway`), dezelfde dataservice als de bruggen en sluizen. Dat is
bewust gekozen na een pijnlijke omweg (zie hieronder): het bevat alleen echt
bevaarbaar water, de topologie zit er al in (elke sectie heeft start- en
eindknooppunt), en open water zit erin als de officiële betonde routes. 4630
secties, 0,15 MB gzip. Secties krijgen een voorkeursfactor uit de CEMT-klasse
en de doorvaarthoogte van de laagste vaste brug erboven.

Testen: `node scripts/test_route_graph.js` (19 controles op de echte data:
dijkpassages, Zeeland binnendoor, Friesland via het Prinses Margrietkanaal) en
`python3 scripts/audit_net.py` (meldt verbindingen die over land lopen; hoort 0
te zijn — het netwerk bevat geen zelfgemaakte lijnen meer).

### Wat hier eerder misging (niet opnieuw doen)

Het netwerk kwam eerst uit OpenStreetMap: alles met `waterway=canal|river`.
Die tag zegt niets over bevaarbaarheid, dus de planner stuurde je door
Amsterdamse grachten met bruggen van 0,63 m. Open water had geen lijnen, dus
daar lag een zelfbedacht raster over de meren, vastgeknoopt aan het lijnennet.
Dat leverde telkens routes dwars door dijken op (Durgerdam, Muiden/Krijgsman,
Broek in Waterland). Vier rondes fixes hielpen niet afdoende; de audit stond op
299 meldingen. Met de RWS-data verdween het hele probleem in één keer.

### Open punten routeplanner

1. **Lange bruggen over open water.** De RWS-data geeft één punt per brug,
   terwijl bijvoorbeeld de Zeelandbrug 5 km overspant en de vaargeul hem op
   ~1,4 km van dat punt kruist. Zo'n brug ontbreekt dan in de lijst — juist
   riskant bij een hoge mast. Eerder loste een `spans`-laag uit OSM dit op
   (zie git-geschiedenis); die kan terug als losse stap die alleen de
   objectenlijst raakt, niet de routering.
2. **Hoogte laten meewegen in de route.** De doorvaarthoogtes zitten al per
   sectie in `net.json.gz` en `findRoute()` heeft er een parameter voor, maar
   die staat uit. Aanzetten kan zodra punt 1 opgelost is, anders stuurt hij om
   voor bruggen die hij zelf niet compleet kent.
3. **Tijdsbewust plannen**: met vertrektijd en kruissnelheid per brug de
   aankomsttijd tonen en waarschuwen bij bedieningstijden.
4. **Bruggen buiten de RWS-data.** Op de kaart (OpenStreetMap) staan veel meer
   bruggen dan in het RWS-bestand; die krijgen geen statusbolletje. Op de
   officiële vaarwegen is de RWS-dekking compleet, dus binnen de scope van de
   planner speelt dit niet meer.

## Snel beginnen

```bash
git clone <repo-url> && cd bruggen-sluizen
python3 -m http.server 8000   # → http://localhost:8000
```

Vragen over waarom iets zo gebouwd is: check de commit-geschiedenis —
commitberichten beschrijven per stap wat er veranderde en waarom.
