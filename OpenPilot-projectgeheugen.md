# OpenPilot / bruggen-sluizen — projectgeheugen

*Bijgewerkt: 25 juli 2026 · buildstamp op dat moment: **b20260725-69**. Voeg dit toe aan de Brug&Sluis-projectkennis zodat toekomstige sessies context hebben.*

## Wat is het
Open vaarkaart-webapp voor de recreatievaart: brug-/sluis-bedieningstijden, stremmingen, getij (NL+UK), stroming & wind (7 dagen, Windfinder-kleuren), zeekaartmodus met eigen EMODnet/RWS-dieptedata, havens, VTS, routeplanner. (Plotter/NMEA/AIS zijn er in aug 2026 uitgehaald — browsers kunnen geen rauwe TCP/UDP en `ws://` mag niet vanaf https; alleen *Volg mij* op telefoon-GPS bleef.) Tweetalig NL/EN, licht/donker. Gebouwd door Kees (niet-programmeur) samen met Claude.

## Waar alles staat
- **Repo:** GitHub `cjroyaards/bruggen-sluizen` — enige bron. Live via **GitHub Pages**: cjroyaards.github.io/bruggen-sluizen (~5–10 min na push live).
- Lokaal op Kees' Mac in de map **"Output Claude/bruggen-sluizen"** (iCloud Drive), gekoppeld als Cowork-map.
- `BOUWGIDS.md` = ontwikkelaarsgids (eerst lezen bij bouwwerk). `app/` = Capacitor-app (iOS+Android): dun jasje om de live site (de meegeleverde TCP/UDP NMEA-plugin wordt sinds aug 2026 niet meer gebruikt).
- **Bijna alle logica zit in `index.html`**; stroming in `currents.js`, wind in `wind.js`.

## Werkafspraken
- Hoofdbouw Kees+Claude **direct op `main`** (eerst `git pull --rebase`, autostash aan). Anderen (Rob) via branch+PR.
- **Buildstamp** onderin `index.html` (span#buildstamp) bij elke sitewijziging ophogen — formaat `bYYYYMMDD-NN`.
- Testen vóór push: `node --check` op het JS (inline app-script uit index.html extraheren; de JSON-LD is geen JS) + waar mogelijk Playwright.
- Engelse versie: `STATIC_EN`-map in index.html (data-i18n-keys); ontbrekende keys vallen terug op NL.

## Git-push setup (belangrijk)
- Claude pusht **direct** naar main met een **fine-grained token** dat in de remote-URL van de repo staat (`git remote set-url origin https://<token>@github.com/...`). Alleen scope: deze repo, Contents read/write.
- De Cowork-map blokkeert standaard **verwijderen**; per sessie kan één keer toestemming nodig zijn (`allow_cowork_file_delete`) zodat git lockbestanden e.d. kan opruimen.
- Er staat een `push-weerpaneel.command`- en `setup-git-token.command`-script in de Output Claude-map als noodremedie.

## Databronnen (per functie)
- **Getij/waterstanden:** Rijkswaterstaat (officieel) — sterke kant.
- **Weer (locatiedetail):** Open-Meteo forecast-API, model **ECMWF** (`ecmwf_ifs025`), knopen, `timezone=auto`. Temp = temperature_2m op dichtstbijzijnde uur; icoon = weather_code (WMO) → emoji; wind = wind_speed/direction_10m + gusts → Beaufort/kompas/pijl.
- **Wind-detailpaneel:** zelfde Open-Meteo-bron, ECMWF **én** GFS naast elkaar met keuzeknop (strip + 7-daagse uurtabel schakelen samen).
- **Stroming:** Copernicus Marine **NWShelf** (product 004_013, 1,5 km, mét getij, aangedreven met ECMWF-weer). Twee kanalen: (1) numeriek veld via **Open-Meteo Marine-API** (`ocean_current_velocity/direction`) op een eigen raster → vloeiende pijlen/deeltjes/klikinfo, met bilineaire + tijd-interpolatie; (2) **Copernicus-WMTS-tegels** (native 1,5 km) voor scherpe pijlen op afstand + intern land/zee-masker.
- **Regenradar:** RainViewer (gratis tegels, geanimeerd). Onweer-⚡ uit Open-Meteo weercode 95/96/99 (modelmatig, geen echte inslagen).
- **Diepte:** EMODnet. **Zeekaart:** OpenSeaMap. **Basiskaart:** OSM / CARTO.

## Nauwkeurigheid stroming (belangrijke nuance)
- Copernicus 1,5 km smoothet nauwe geulen/haveningangen/zeegaten; kentering-timing kan lokaal tientallen minuten schelen. Het is modelverwachting, geen meting.
- De grootste beperking wás het eigen grove raster (0,4°/0,6° ≈ 25–40 km). **Fase 1 gedaan:** fijn 1,5 km-veld nu al vanaf **zoom 10** (was 12) en tot **600 punten** (was 300) — dichter bemonsterd waar je detail bekijkt. Fijn veld is zichtgebied-gebonden, debounced, ontdubbeld.
- "geen navigatiebron"-disclaimer staat terecht in de app.

## Wat er deze sessie (juli 2026) is gedaan
- Weerpaneel in locatiedetails (b…-54/55); wind-details met 6-daagse strip + 7-daagse tabel, ECMWF/GFS-keuzeknop (b…-56/57).
- Locatiepaneel terug naar 1 model (ECMWF, benoemd) — geen dubbele waardes.
- Regenradar + onweer-laag toegevoegd (b…-60), radar `maxNativeZoom:7` tegen RainViewer "zoomlevel not supported" bij inzoomen (b…-61).
- Kaartmenu-items als blauw/wit **pill** i.p.v. checkbox-vinkjes (b…-59).
- Telefoon: **kopbalk onversleepbaar** (`touch-action:none`) ook in mobiele browser; detailpaneel-overscroll-slot (b…-58/63).
- Windpijlen (kaart): diepere lage-windkleuren (b…-62).
- **Play/pauze-bug gefixt:** afspeelstatus gecentraliseerd in één `flowPlaying`; engines resetten `playing` bij geen laag; `loadScriptOnce` idempotent (b…-64).
- Stroom-sectie opgeschoond: kleurlaag verwijderd; Copernicus-pijlen faden in één keer in na tile-load; twee pijl-opties samengevoegd tot één **"Stroompijlen"** (scherp op afstand, vloeiend vanaf zoom 11); witte casing + diepere kleuren + iets grotere pijlen (b…-65 t/m 68).
- Stroming Fase 1 (fijn veld eerder/fijner) (b…-69).

## Openstaande roadmap / beslissingen
- **RWS-meetstations (stroming) als nieuwe laag** — gewenst: markers in havens/getijstations-stijl, laag aan → pijlen (snelheid/richting), klik → detailpagina met grafiek. Data: RWS **WaterWebservices** (open, geen auth; POST-JSON; WFS `locatiesmetlaatstewaarneming` geeft locatie+laatste waarde; coördinaten EPSG:25831 → herprojecteren; grootheidcodes stroomsnelheid/-richting nog live bevestigen, waarschijnlijk STROOMSHD/STROOMRTG). **Blokker:** vrijwel zeker geen CORS → **kleine proxy nodig** (Cloudflare Worker) die filtert, herprojecteert, cachet en CORS toevoegt. Dekking is dun (weinig stations meten stroming).
- **Hosting-keuze (open):** overweeg hele site naar **Cloudflare Pages** (statisch + functies same-origin → proxy wordt `/api/...`, geen CORS-gedoe; git-push-deploy blijft). Gotcha: URL verandert → Capacitor-app-URL bijwerken + evt. opnieuw indienen. Combineren met **openpilot.nl**-domein (Cloudflare = ook DNS).
- **DCSM-FM (echt geul-fijn veld)** via MATROOS/Deltares = groter traject: MATROOS vereist account bij RWS-datacentrum, mogelijk licentie/kosten, plus proxy. Als Fase 3.
- **iOS App Store:** app is webwrapper → risico op afwijzing richtlijn **4.2** (minimum functionality). Tegengif = native NMEA-plugin, mits gedemonstreerd in App Review Notes + demo/mock. Verder: locatie-purpose-strings, privacyverklaring-URL + App Privacy-label, nette offline-fallback. TestFlight **intern** (tot 100 testers, geen review; externe mailadressen mogen als App Store Connect-gebruiker met beperkte rol); **extern** = lichte Beta App Review.
- Overig uit oude projectstatus: iOS-build (Apple Developer €99/jr, Xcode, TestFlight), in-app-aankoop NMEA (RevenueCat), Open-Meteo commercieel (~$29/mnd) vóór betaald, CARTO-basemap evt. vervangen, Admiralty-UK-getij checken, wekelijkse ENC-verversing automatiseren.

## Kees' voorkeuren
- Werkt snel en iteratief; wil vaak eerst een kort voorstel/keuze vóór grotere wijzigingen ("eerst voorleggen").
- Waardeert eerlijke inschattingen incl. onzekerheden en kosten.
