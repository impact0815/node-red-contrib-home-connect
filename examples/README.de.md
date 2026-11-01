# Home-Connect-Beispiel-Flows

**[English](README.md) · Deutsch**

Diese Beispiele sind so erklärt, dass sie auch ohne Programmierkenntnisse nutzbar sind. Am besten mit dem integrierten Simulator beginnen: Er verwendet kein Home-Connect-Konto, keine Zugangsdaten und kein echtes Gerät.

## Vor dem Start

1. `@impact0815/node-red-contrib-home-connect` installieren.
2. Node-RED neu starten und den Editor neu laden.
3. Für die drei Dashboard-Beispiele zusätzlich `@flowfuse/node-red-dashboard` installieren:

   ```bash
   cd ~/.node-red
   npm install @flowfuse/node-red-dashboard
   ```

## Mitgeliefertes Beispiel importieren

1. Node-RED öffnen.
2. **Menü → Import → Beispiele → @impact0815/node-red-contrib-home-connect** wählen.
3. Ein Beispiel auswählen.
4. **Importieren** anklicken.
5. Oben rechts **Deployen** anklicken.

Für den Einstieg **01-first-steps-device-list** verwenden. Danach links am Inject-Node auf den Knopf drücken. In der Debug-Seitenleiste sollten drei simulierte Geräte erscheinen.

## Welches Beispiel passt?

| Beispiel | Geeignet für | Vorgehen |
|---|---|---|
| `01-first-steps-device-list.json` | Erster Test | Deployen, Inject-Knopf drücken, Geräteliste im Debug-Fenster ansehen. |
| `02-events.json` | Live-Änderungen | Deployen und simulierte Ereignisse im Debug-Fenster verfolgen. |
| `03-safe-read-write.json` | Sicherer Schreibtest | **Dry-Run** eingeschaltet lassen. Der Flow prüft einen Befehl, sendet ihn aber nicht. |
| `04-local-read-only.json` | Lokale LAN-Profile | Beispielverbindung durch die eigene lokale Read-only-Verbindung ersetzen. Der Flow enthält keinen Write-Node. |
| `dashboard-dishwasher-washer-oven.json` | Vollständiges Dashboard | Deployen und `/dashboard/overview` öffnen. Unterstützt Cloud und lokales Read-only. |
| `dashboard-screenshot-simulated.json` | Demo ohne Netzwerk | Deployen und Dashboard öffnen. Alle Geräte und Werte sind simuliert. |
| `demo-home-connect-flowfuse-1.34.1-scriptless.json` | Isolierte Oberflächen-Demo | Importieren, wenn nur das Dashboard ohne Home-Connect-Runtime-Nodes oder Netzwerkzugriff ausprobiert werden soll. |

## Vom Simulator zu den eigenen Geräten

1. Zuerst prüfen, ob der gewählte Flow mit dem Simulator funktioniert.
2. Entweder eine **Production-Cloud-Verbindung** oder eine **Local-LAN-Verbindung (read-only)** anlegen.
3. Jeden Home-Connect-Node im importierten Flow öffnen und die eigene Verbindung auswählen.
4. **Fertig**, danach **Deployen** anklicken.
5. Für Cloud-Zugriff die OAuth-Autorisierung abschließen und nur die benötigten Rechte vergeben.
6. Cloud-Write-Nodes auf **Dry-Run** lassen, bis Gerät, Befehl und Werte eindeutig geprüft sind.

Lokaler LAN-Zugriff ist immer nur lesend. Ein lokaler Schreibversuch wird vor jedem Netzwerkzugriff abgewiesen.

## Wenn nichts angezeigt wird

- Prüfen, ob Node-RED nach der Installation neu gestartet wurde.
- Prüfen, ob der Flow deployt wurde.
- Debug-Seitenleiste öffnen und kontrollieren, ob ein Filter Meldungen ausblendet.
- Bei Dashboards prüfen, ob `@flowfuse/node-red-dashboard` installiert ist.
- Bei Cloud-Flows die deployte Verbindung testen und OAuth-Rechte prüfen.
- Siehe [deutsche Troubleshooting-Anleitung](../docs/TROUBLESHOOTING.de.md) oder [englische Troubleshooting-Anleitung](../docs/TROUBLESHOOTING.md).

## Sicherheit und Datenschutz

Nie Client Secrets, Tokens, Profil-PSK/IV, echte Geräte-IDs, private Adressen oder Flows mit Zugangsdaten weitergeben. Zuerst simulierte Daten und Dry-Run verwenden. Gerätesteuerung kann Hitze, Bewegung und Wasserverbrauch auslösen.
