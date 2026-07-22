@echo off
REM OpenPilot NMEA-brug - dubbelklik-starter voor Windows.
REM Zet dit bestand in dezelfde map als nmea-bridge.py (allebei te downloaden op de site).
cd /d %~dp0
echo === OpenPilot NMEA-brug ===
if not exist nmea-bridge.py ( echo nmea-bridge.py niet gevonden in deze map — download 'm van de site. & pause & exit /b 1 )
set /p ip="IP van je gateway (bijv. 192.168.0.80): "
set /p port="Poort (Enter = 1456): "
if "%port%"=="" set port=1456
set /p proto="TCP of UDP? (Enter = tcp): "
if /i "%proto%"=="udp" ( py nmea-bridge.py --udp %port% ) else ( py nmea-bridge.py --tcp %ip%:%port% )
pause
