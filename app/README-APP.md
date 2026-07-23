# OpenPilot-app (Capacitor) — bouwen & TestFlight

De app is een dun native jasje om de live website (hij laadt cjroyaards.github.io/bruggen-sluizen,
dus elke site-update zit meteen ook in de app) plus een native NMEA-plugin die rauw
TCP en UDP kan — dat kan een browser niet. In het NMEA-veld van de plotter werkt in de app dus ook:
een kaal IP (probeert tcp 10110, tcp 2000, udp 10110, daarna WebSocket), `tcp://ip:poort` of `udp://poort`.

## Eenmalige voorbereiding (Mac)
1. Installeer Xcode (App Store) en start hem één keer.
2. Installeer Node (nodejs.org) en CocoaPods: `sudo gem install cocoapods`
3. `git clone` deze repo, dan: `cd app && npm install && npx cap sync ios`

## iOS bouwen
1. `npx cap open ios` (opent Xcode)
2. Eenmalig: sleep `ios/App/App/NmeaPlugin.swift` en `NmeaPlugin.m` vanuit Finder in Xcode
   in de gele map **App** (vink "App" als target aan). Bij de vraag over een bridging header: laat Xcode die maken.
3. Kies bovenin je team (Apple Developer-account, Signing & Capabilities) — bundle-id `nl.openpilot.app`.
4. Test op je eigen iPhone via een kabel (Run ▶). Werkt het: Product → Archive → Distribute → TestFlight.
5. In App Store Connect nodig je testers uit met hun Apple-mailadres; zij installeren de TestFlight-app.

## Android bouwen (optioneel, kan zonder account gedeeld worden)
`cd app && npx cap sync android && cd android && ./gradlew assembleDebug`
→ APK in `android/app/build/outputs/apk/debug/`, direct te delen/installeren.

## Nog te doen vóór betaald
- In-app-aankoop voor NMEA (RevenueCat) — plek in de site is voorbereid (NMEA werkt nu vrij)
- Open-Meteo commercieel abonnement (~$29/mnd) zodra er omzet is
- CARTO-ondergrond vervangen (bijv. OpenFreeMap)
