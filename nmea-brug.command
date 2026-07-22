#!/bin/bash
# OpenPilot NMEA-brug — dubbelklik-starter voor macOS.
# Zet dit bestand in dezelfde map als nmea-bridge.py (allebei te downloaden op de site).
cd "$(dirname "$0")"
echo "=== OpenPilot NMEA-brug ==="
if [ ! -f nmea-bridge.py ]; then echo "nmea-bridge.py niet gevonden in deze map — download 'm van de site."; read -p "Enter om te sluiten"; exit 1; fi
read -p "IP van je gateway (bijv. 192.168.0.80): " ip
read -p "Poort (Enter = 1456): " port
port=${port:-1456}
read -p "TCP of UDP? (Enter = tcp): " proto
if [ "$proto" = "udp" ]; then
  python3 nmea-bridge.py --udp "$port"
else
  python3 nmea-bridge.py --tcp "$ip:$port"
fi
