#!/usr/bin/env python3
"""Alarm bij verouderde data.

Faalt (exit 1) als de laatste succesvolle verversing te lang geleden is,
zodat de GitHub-run rood wordt en er een e-mail uitgaat:
  - stremmingen (stremTs) ouder dan 48 uur
  - volledige dataset (staticTs) ouder dan 60 uur (verversing is 1x per nacht,
    dus 60 uur = twee gemiste nachten)
"""
import json, os, sys, time

META = os.path.join(os.path.dirname(__file__), "..", "data", "meta.json")
UUR = 3600 * 1000

meta = json.load(open(META))
now = time.time() * 1000
strem_h = (now - meta.get("stremTs", 0)) / UUR
static_h = (now - meta.get("staticTs", 0)) / UUR

if strem_h > 48:
    sys.exit(f"ALARM: stremmingen al {strem_h:.0f} uur niet ververst (vaarweginformatie.nl-storing?)")
if static_h > 60:
    sys.exit(f"ALARM: volledige dataset al {static_h:.0f} uur niet ververst")
print(f"OK: stremmingen {strem_h:.1f} uur oud, volledige dataset {static_h:.1f} uur oud")
