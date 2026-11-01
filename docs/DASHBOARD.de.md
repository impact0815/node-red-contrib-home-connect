# Dashboard 2.0: Übersicht und Gerätedetails

## Import

1. `@impact0815/node-red-contrib-home-connect` und `@flowfuse/node-red-dashboard` installieren.
2. In Node-RED **Import → Zwischenablage** wählen und `examples/dashboard-dishwasher-washer-oven.json` laden.
3. Deployen.
4. `/dashboard/overview` öffnen; der genaue Präfix folgt der Dashboard-Konfiguration.

Der Flow läuft sofort mit dem integrierten Simulator und enthält keine echten Geräte- oder Zugangsdaten.

## Sprache und Anzeigewerte

Das Dashboard zeigt immer genau **eine** Sprache. Die Auswahl erfolgt in dieser Reihenfolge: ein ausdrücklich in `msg.uiLocale`/`msg.locale` gesetzter Wert, die im Dashboard-Sprachwähler gespeicherte Auswahl, die Dashboard-/Vuetify-Sprache, die Sprache des HTML-Dokuments und schließlich die Browser-Sprache. Unterstützt werden `de` und `en`; ohne erkennbaren Wert wird Englisch verwendet. Der Sprachwähler auf Übersicht und Detailseite speichert die Auswahl browserlokal unter `home-connect-dashboard-language` und synchronisiert alle Karten der geöffneten Seite.

Lokalisierte Anzeige umfasst UI-Beschriftungen, Gerätetypen, Health-Zustände, Warntexte, bekannte Common- und gerätespezifische Enum-Werte sowie bekannte Programm- und Optionsnamen. Marken, Modellnummern, `haId`, VIB/E-Nummern, Home-Connect-Schlüssel und Rohwerte werden nicht verändert. Ein unbekanntes, nicht aufgelöstes Profil-Enum erscheint zum Beispiel als **Unbekannter Wert (Rohwert: 91)**; ein unbekannter, aber bereits semantischer Schlüssel wird aus seinem letzten Schlüsselteil lesbar formatiert. Diese Fallbacks ändern niemals den intern verwendeten Wert.

Die importierten Node-RED-Seiten heißen sprachneutral **Home Connect** und **Home Connect · Details**. Gruppentitel sind ausgeblendet; alle sichtbaren Karten-, Navigations- und Aktionsbeschriftungen kommen aus der Laufzeitlokalisierung.

### FlowFuse Dashboard 1.34.1

Die `ui-template`-Komponente von FlowFuse erweitert benutzerdefinierte Vue-Komponenten um eigene Template-Scope-Werte und eingebaute Methoden. Deshalb verwenden die korrigierten Templates keinen kurzen Übersetzungsfunktionsnamen wie `tr` mehr. Sämtliche sichtbaren Texte liegen in der reaktiven Computed-Eigenschaft `hcLabels`; das Template bindet nur Werte wie `hcLabels.connection`. Damit kann ein vom Dashboard-Scope bereitgestellter Wert namens `tr` die Übersetzung nicht überschreiben oder beim Rendern als Funktion aufgerufen werden. Der Regressionstest baut beide Flows mit einem absichtlich nicht aufrufbaren `tr`-Scopewert auf und wertet alle `hcLabels`-Renderbindungen aus.

## Enthaltene Seiten

### Übersicht

- eine kompakte Karte pro Geschirrspüler, Waschmaschine und Backofen
- normierter Health-Status, wichtigste Warnung in der gewählten Sprache, Betriebszustand, aktives Programm und Restzeit
- dokumentierte Geräteinformationen: Name, Marke und Typ
- responsive Anordnung für Smartphone, Tablet und Desktop
- Klick bzw. Enter auf einer Karte öffnet die Detailseite

### Gerätedetails

- getrennte Karten für Geschirrspüler, Waschmaschine und Backofen
- Health-Chip und deduplizierte Warnungen in der gewählten Sprache
- Name, Marke, Typ, `vib`/E-Nummer und Verbindungsstatus, soweit von der API geliefert
- initialer Snapshot nach dem Deploy und sparsames Polling alle 30 Minuten
- ein gemeinsamer lokaler WebSocket-/Cloud-SSE-Event-Stream; partielle `STATUS`-/`NOTIFY`-Updates werden nur in das betroffene Gerät eingemischt
- bekannte Felder bleiben bei Offline sichtbar und werden nach Reconnect automatisch aktualisiert
- Programmauswahl aus den erkannten Capabilities
- Geschirrspüler-Option VarioSpeed, Waschtemperatur und Backofen-Solltemperatur
- Start/Stopp über abgesicherte Schreib-Nodes
- Start wird bei offline/error/action_required, lokaler Bedienung oder fehlender Fernstartfreigabe deaktiviert
- Link zurück zur Übersicht
- strukturierte Fehler im Debug-Fenster

## Zustands- und Aktualisierungspfad

`Snapshot/Event → Zustand zusammenführen` ist der gemeinsame Reducer für Read-Ergebnisse, Events und strukturierte Fehler. Er hält pro unveränderter `haId` genau ein Zustandsobjekt im Flow-Kontext. Ein vollständiger Snapshot mischt Geräteinformationen, `status.items`, `settings.items`, alle `values.items`, Programme, Health und Warnungen ein. Ein Teil-Event ändert nur die in `event.data.items` enthaltenen Schlüssel; nicht enthaltene Status-, Einstellungs-, Options- und Programmfelder bleiben erhalten.

Der Inject-Node fordert nach dem Deploy die initialen Snapshots an. Lokale `STATUS`-Events mit `connection.action: "NOTIFY"` und Cloud-`STATUS`-Events verwenden denselben Reducer. `DISCONNECTED` oder ein Offline-Read markiert das Gerät als offline/veraltet, ohne die letzten Werte zu löschen. `CONNECTED` entfernt die Veraltet-Markierung; der lokale Client aktualisiert weiter und liefert neue Events. Die vier Reducer-Ausgänge versorgen Geschirrspüler, Waschmaschine, Backofen und die gemeinsame Übersicht.

Lokale Snapshots tragen `readOnly: true`. Die Detailkarten stellen diese Geräte als reine Statusansicht dar: Betriebs- und Türzustand, aktives/ausgewähltes Programm, Restzeit, die drei Fern-/Lokalbedienungs-Flags, aktuelle Optionen und verfügbare Programme. Unaufgelöste Werte werden ausdrücklich mit Rohwert angezeigt. Programmauswahl, Optionseditoren sowie Start-/Stopp-Schaltflächen werden bei lokalen Read-only-Geräten gar nicht gerendert; die Oberfläche suggeriert damit keinen verfügbaren Steuerpfad. Nur **Aktualisieren** beziehungsweise **Refresh** in der gewählten Sprache bleibt bedienbar. Simulator und Cloud-Pfad verwenden weiterhin denselben Flow; Cloud-Bedienelemente bleiben mit den abgesicherten Write-Nodes verbunden.

Eine Restzeit wird nur angezeigt, wenn das passende Element vorhanden ist. Die lokale Umrechnung verwendet die Einheit aus dem Geräteprofil; ein fehlender Wert erscheint als `—` statt als erfundene `0 min`. OperationState-Rohwert `0` erscheint als das vom jeweiligen Profil definierte semantische Mitglied. Fehlt ein Enum-Mitglied tatsächlich im Profil, zeigt die Karte den unaufgelösten Rohwert und die Health-Schicht leitet daraus keine semantische Warnung ab.

## Reproduzierbarer Dokumentations-Screenshot

`examples/dashboard-screenshot-simulated.json` ist ein separater, direkt importierbarer Flow nur für Screenshots und UI-Prüfungen. Er benötigt ausschließlich Node-RED und `@flowfuse/node-red-dashboard`; Home-Connect-Credentials, echte Geräte-IDs, IP-Adressen und lokale Profile sind weder erforderlich noch enthalten. Alle Flow-, Tab-, Page-, Group-, UI- und Demo-Node-Namen beginnen mit **Demo**. Eigene IDs mit dem Präfix `demo-hc-r9-fix1-`, die Dashboard-Basisroute `/demo-home-connect-r9-fix1` und eigene Unterseiten verhindern Verwechslungen oder Referenzen auf die produktive Installation. Ein Function-Node erzeugt bei jedem Deploy deterministisch drei klar mit **SIMULIERT**/**SIMULATED** markierte Beispielgeräte: einen laufenden Geschirrspüler, eine bereite Waschmaschine mit Warnhinweis und einen laufenden Backofen. Start-/Stopp-Bedienung wird in diesem Flow nicht angeboten.

1. `@flowfuse/node-red-dashboard` installieren.
2. `dashboard-screenshot-simulated.json` über **Import → Zwischenablage** importieren und deployen.
3. `/demo-home-connect-r9-fix1/demo-overview` öffnen.
4. Im Sprachwähler **Deutsch** oder **English** auswählen. Die Auswahl bleibt für die Detailseite gespeichert.
5. Für vergleichbare Aufnahmen ein Browserfenster von etwa 1440 × 900 Pixeln, 100 % Zoom und das mitgelieferte helle Theme verwenden. Nach dem Deploy ungefähr eine Sekunde warten und dann **Demo Übersicht** oder **Demo Gerätedetails** aufnehmen.

Alle Namen, IDs und Modellangaben dieses Flows beginnen erkennbar mit `Studio`, `simulated-` oder `DEMO-`. Der Flow führt keine Netzwerkzugriffe aus und kann über **Aktualisieren/Refresh** jederzeit auf denselben Ausgangszustand zurückgesetzt werden.

## Isolierte FlowFuse-1.34.1-Demo

`examples/demo-home-connect-flowfuse-1.34.1-scriptless.json` ist der separat importierbare, vom Benutzer bereitgestellte Demo-Flow. Er behält eigene Fix-spezifische IDs sowie Route `/demo-home-connect-ff1341-fix2`, Browserspeicher, Seiten, Gruppen, Theme und deterministische Simulationsdaten. Die `ui-template`-Nodes enthalten nur Darstellung; Lokalisierung und Zustand werden vor dem Rendern vorbereitet, sodass kein `tr(...)`-Helper mit dem Dashboard-Scope kollidieren kann. Enthalten sind weder Home-Connect-Konfigurations-Node noch Zugangsdaten, echte IDs, Adressen, Profile oder Netzwerkzugriffe.

## Enthaltene Dokumentationsaufnahmen

- `docs/images/dashboard-overview-en.png` — englische simulierte Übersicht
- `docs/images/dashboard-details-en.png` — englische simulierte Gerätedetails

Das Release-Gate prüft beide Dateien auf gültiges PNG-Format. Zusätzlich muss der vollständige Bildausschnitt vor der Veröffentlichung manuell auf private Browser-/Kontokontexte kontrolliert werden.

## Wechsel zu echten Cloud-Geräten

1. Eine eigene Production-Verbindung anlegen und vollständig autorisieren.
2. Mit dem Beispiel `01-first-steps-device-list` die echten Geräte ermitteln.
3. In allen Read-, Event- und Write-Nodes `hc-sim-config` durch die Production-Verbindung ersetzen.
4. Die drei Simulator-IDs in Read- und Write-Nodes durch die jeweils erkannte `haId` ersetzen. Einen separaten Event-Switch gibt es nicht; nach dem initialen Snapshot routet der Reducer anhand des Gerätetyps.
5. Echte IDs nicht in Screenshots, Issues oder öffentliche Flows übernehmen.
6. Schreib-Nodes im Dry-Run lassen und jeden Dashboard-Button testen.
7. Am Gerät lokale Fernsteuerungs-/Fernstart-Freigaben prüfen.
8. Dry-Run erst danach einzeln und bewusst abschalten.
9. Demonstrations-Bestätigungstoken durch einen eigenen Wert ersetzen.
10. Dashboard mit Authentifizierung, HTTPS und Netzwerkregeln schützen.

## Wechsel zu lokalen Read-only-Geräten

1. Nach der Lokale-LAN-Anleitung eine **Local LAN (read-only)**-Verbindung erstellen und deployen.
2. In den drei Read-Nodes und im gemeinsamen Events-Node `hc-sim-config` durch diese lokale Verbindung ersetzen.
3. In den Read-Nodes die drei Simulator-IDs durch die konfigurierten lokalen Profil-IDs ersetzen. Write-Nodes können entfernt werden; bleiben sie bestehen, sind die Bedienelemente wegen `readOnly: true` deaktiviert und die Runtime erzwingt zusätzlich `LOCAL_READ_ONLY`.
4. Den initialen Snapshot beim Deploy aktiviert lassen. Ein gerade nicht erreichbares Gerät erscheint offline, ohne die anderen Geräte zu blockieren.
5. Profil-IDs, Hosts, Profildateien, PSKs und IVs nicht mit einem exportierten Produktionsflow veröffentlichen.

## Scopes

Für alle angezeigten Werte werden `IdentifyAppliance` und passende gerätespezifische `*-Monitor`-Scopes benötigt. Für Start/Stopp kommen je nach Gerät `*-Control` und für Einstellungen `*-Settings` hinzu. Nach einer Scope-Änderung muss neu autorisiert werden.

## Modellunterschiede

Nicht jedes Modell bietet jedes Programm oder jede Option. Programmlisten werden dynamisch geladen. Die drei optionalen Bedienelemente verwenden verbreitete API-Keys; nicht vorhandene Optionen werden vom Write-Node sicher abgelehnt. Bei Bedarf die Optionsbildung im jeweiligen `ui-template` an die tatsächlich erkannten Capabilities anpassen.

## Health, Warnungen und Aktualisierung

Der Reducer übernimmt `payload.health` und `payload.warnings` in das kompakte View-Modell und nutzt bereits aufgelöste semantische Schlüssel; er erfindet keine Geräte-Enums. Der gemeinsame Config-Node hält den Health-Zustand pro Gerät. Events ändern nur die gelieferten Felder und lösen nicht bei jeder Änderung erneut fünf lokale Fallback-Reads aus. Kurzlebige Hinweise laufen automatisch ab; offline bleibt bis zu einem bestätigten Reconnect/Snapshot bestehen, während die letzten Anzeigewerte erhalten bleiben.

## Keine Firmwarefunktion

Das Dashboard zeigt bewusst keine Firmwareversion, Firmwarehistorie oder Update-Schaltfläche. Diese Funktionen sind nicht Teil der öffentlich dokumentierten Home-Connect-API. Es werden keine undokumentierten Endpunkte verwendet.

## Sicherheit

Start-/Stopp-Bedienung nie anonym ins Internet stellen. Vor einem Ofen-Fernstart den Garraum kontrollieren. Bei Wasch- und Spülmaschinen Türen, Wasserzufuhr und Herstellerhinweise prüfen. Die Remote-Control-/Remote-Start-Flags des Geräts bleiben maßgeblich.
