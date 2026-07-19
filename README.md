# ⛵ Bruggen & Sluizen

Persoonlijke website met de bedieningstijden van alle bedienbare bruggen en sluizen
in Nederland, plus doorvaarthoogtes, marifoonkanalen, telefoonnummers, actuele
stremmingen en een kaart.

**Databronnen**
- Rijkswaterstaat — Fairway Information Services (vaarweginformatie.nl): objecten & bedieningstijden
- Scheepvaartberichten (NtS/FTM) via vaarweginformatie.nl: actuele stremmingen
- Kaartondergrond: © OpenStreetMap-bijdragers

**Automatische verversing** (GitHub Actions, `.github/workflows/refresh.yml`)
- elk uur: actuele scheepvaartberichten → `data/strem.json`
- dagelijks 02:42 UTC: volledige dataset → `data/static.json.gz`

Handmatig verversen: tabblad *Actions* → *Ververs vaarwegdata* → *Run workflow*.

**Lokaal draaien**
```
python3 -m http.server
# open http://localhost:8000
```

**Publiceren via GitHub Pages**
Settings → Pages → "Deploy from a branch" → branch `main`, map `/ (root)`.

Geen officiële bron — controleer bij twijfel altijd het actuele scheepvaartbericht,
of roep de brug/sluis op via marifoon of telefoon.
