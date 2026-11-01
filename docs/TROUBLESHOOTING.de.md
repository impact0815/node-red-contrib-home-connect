# Home Connect: Troubleshooting und FAQ

Zurück zur [deutschen README](../README.de.md).

Diese Anleitung beginnt beim sichtbaren Symptom. Zugangsdaten, Hostnamen, Geräte-IDs und OAuth-Codes gehören nie in Fehlerberichte.

## 1. Vorprüfung in zwei Minuten

1. Läuft wirklich der erwartete Build?
   ```bash
   cd ~/.node-red
   node -p "require('./node_modules/node-red-contrib-home-connect/BUILD-INFO.json')"
   ```
   Erwartet: Version `0.2.0`, Build `hc-0.2.0-final`, `pkce: false`.
2. Ist die richtige Connection ausgewählt und eindeutig benannt?
3. Wurde nach der letzten Änderung **Fertig → Deploy** ausgeführt?
4. Sind Redirect URI im Developer Portal und in Node-RED exakt gleich?
5. Ist die Node-RED-Adresse vom verwendeten Browser erreichbar?
6. Wurde OAuth bis zur Seite **Home Connect authorized** abgeschlossen?
7. Enthalten die Scopes mindestens `IdentifyAppliance` und die benötigten gerätespezifischen Rechte?

## 2. Autorisieren ist deaktiviert

Das ist Absicht: Die Config-Node prüft, ob genau diese gespeicherte Konfiguration bereits in der laufenden Node-RED-Runtime existiert.

- **Neue/änderte Verbindung:** Fertig klicken, deployen, Verbindung erneut öffnen.
- **Integrierter Simulator:** OAuth ist nicht erforderlich.
- **Weiterhin deaktiviert:** Node-RED vollständig neu starten und Browser hart neu laden. Prüfen, ob eine zweite/alte Paketinstallation existiert.

## 3. `CONFIG_NOT_FOUND`

**Bedeutung:** Die URL enthält die ID einer Config-Node, welche die laufende Runtime nicht kennt.

Typische Ursachen:

- Beispiel- oder Simulator-Config wurde referenziert.
- Verbindung wurde zwar im Editor angelegt, aber nicht deployt.
- Alter Browser-Tab enthält eine Autorisierungs-URL einer gelöschten Config.
- Nach Paket-/Flow-Wechsel läuft noch eine andere Runtime-Instanz.

**Behebung:**

1. Alten Auth-Tab schließen.
2. Im verwendeten Home-Connect-Node die richtige Connection wählen.
3. Connection eindeutig benennen.
4. Fertig → Deploy.
5. Connection erneut öffnen.
6. Autorisierung über den dortigen Knopf neu starten.

## 4. Falsche oder irreführende Verbindungsbezeichnung

Technisch steuert das Feld **Umgebung** den API-Host, nicht der Name. Ein Name wie `Simulator` bei Umgebung `Production` erhöht aber das Fehlerrisiko. Die Oberfläche zeigt deshalb eine Warnung. Name korrigieren, speichern und deployen.

## 5. Redirect URI: exakter Vergleich

Folgende Teile müssen identisch sein:

| Teil | Häufiger Fehler |
|---|---|
| Protokoll | `http` im Portal, `https` in Node-RED |
| Host | DNS-Name im Portal, IP-Adresse in Node-RED |
| Port | Port fehlt auf einer Seite |
| Pfad | Tippfehler in `/home-connect/oauth/callback` |
| Ende | zusätzlicher Slash `/callback/` |
| Groß-/Kleinschreibung | abweichende Zeichen im Pfad |

Am sichersten die vollständige URI aus einem Feld kopieren und im anderen einfügen.

## 6. Nach Login: localhost, `ERR_EMPTY_RESPONSE`, Verbindung fehlgeschlagen

`localhost` zeigt aus Sicht des Browsers auf das Browser-Gerät. Läuft Node-RED auf NAS, Server, Raspberry Pi, Home Assistant, ioBroker oder in einem anderen Rechner/Container, erreicht der Browser dort nicht Node-RED.

1. Einen vom Browser erreichbaren Hostnamen oder eine erreichbare IP-Adresse für Node-RED wählen.
2. Callback-Pfad anhängen: `/home-connect/oauth/callback`.
3. URI im Developer Portal ändern.
4. Dieselbe URI in Node-RED eintragen.
5. Fertig → Deploy.
6. OAuth neu starten.

## 7. `unauthorized_client` / `client or redirection URI not authorized`

Prüfreihenfolge:

1. Wurde Client ID aus der richtigen Developer-Portal-Application kopiert?
2. Stimmt die Redirect URI Zeichen für Zeichen?
3. Verwendet die Application den Authorization Code Grant?
4. Ist PKCE in dieser Application deaktiviert?
5. Läuft der Build `hc-0.2.0-final`?
6. Wurde nach jeder Änderung eine neue Autorisierung gestartet?

Wurde das Client Secret sichtbar, nicht weiter testen: Secret regenerieren, in Node-RED ersetzen, deployen und neu autorisieren.

## 8. Nach Update läuft alter Code

Ein Flow-Deploy lädt keinen neuen Node.js-Runtime-Code. Zusätzlich zur npm-Version BUILD-INFO prüfen, um doppelte Installationen zu erkennen.

```bash
cd ~/.node-red
npm uninstall node-red-contrib-home-connect
rm -rf node_modules/node-red-contrib-home-connect
npm install --force /absoluter/pfad/node-red-contrib-home-connect-0.2.0.tgz
node -p "require('./node_modules/node-red-contrib-home-connect/BUILD-INFO.json')"
```

Danach Node-RED/Container vollständig neu starten, Browser hart neu laden und OAuth neu beginnen. Authorization Codes und State-Links sind kurzlebig/einmalig und dürfen nicht wiederverwendet werden.

## 9. `No refresh token is stored. Complete OAuth authorization first.`

Der Refresh Token wird erst beim erfolgreichen Callback gespeichert.

- Autorisierung aus der deployten Connection starten.
- Login und Zustimmung abschließen.
- Auf **Home Connect authorized** warten.
- Erst dann Test/Discover/Read/Events ausführen.

Bleibt der Fehler, den Fehler auf der Callback-Seite notieren, aber keine Codes/Tokens veröffentlichen.

## 10. `insufficient_scope`

Der Token darf die angeforderte Ressource nicht lesen oder steuern.

1. `IdentifyAppliance` beibehalten.
2. Passenden gerätespezifischen Scope ergänzen, etwa `Dishwasher-Monitor`, `Washer-Monitor` oder `Oven-Monitor`.
3. Für Aktionen zusätzlich nur benötigtes `*-Control` und/oder `*-Settings` ergänzen.
4. Fertig → Deploy.
5. Neu autorisieren; ein alter Refresh Token erhält nicht automatisch neue Rechte.

Der allgemeine Scope `Monitor` kann je nach Application/Konto unzureichend sein.

## 11. Events zeigt dauerhaft `reconnecting`

`reconnecting` ist ein Folgezustand, nicht die eigentliche Ursache. Den zweiten Ausgang des Events-Nodes mit Debug verbinden.

Häufig:

- kein Refresh Token
- fehlender Monitor-Scope
- abgelaufene/entzogene Autorisierung
- Netzwerk-/Proxy-Unterbrechung des SSE-Streams
- zu viele parallele Event-Streams

Zuerst Geräteliste/Test reparieren, dann einen einzigen Events-Node mit Appliance ID `*` verwenden.

## 12. Erfolgsbild

Die Einrichtung ist abgeschlossen, wenn:

1. die Browserseite **Home Connect authorized** anzeigt,
2. Test ohne Fehler eine Geräteanzahl meldet,
3. **Geräte laden** die Auswahl befüllt,
4. der Events-Node nach Verbindung Events ausgibt statt dauerhaft zu reconnecten.

## 13. Sicheres Fehlerreporting

Erlaubt:

- Paketversion und Build-ID
- Node.js- und Node-RED-Version
- Umgebungstyp (Production/Simulator), ohne privaten Hostnamen
- Fehlercode und bereinigte Fehlermeldung
- Schritte zur Reproduktion mit Simulator

Nicht veröffentlichen:

- Client ID oder Client Secret
- Access-/Refresh-Token
- Authorization Code oder OAuth-State
- echte Redirect-URI/Hostname/IP
- echte `haId`, Serien-/Gerätenummern
- vollständige Events oder Debug-Ausgaben mit persönlichen Daten


## 14. Health- und Warning-Codes verstehen

Jede funktionale Ausgabe enthält das Schema `home-connect-health/v1`:

- `ok`: keine aktuelle Auffälligkeit
- `running`: Programm läuft
- `info`: nützlicher, nicht dringender Hinweis
- `warning`: Einschränkung oder pausierter/abbrechender Zustand
- `action_required`: Eingriff oder neue Autorisierung erforderlich
- `offline`: Gerät, Event-Stream oder Netzwerk nicht erreichbar
- `error`: Geräte-/API-Fehler

`warnings` ist dedupliziert. Jeder Eintrag enthält mindestens `source`, `code`, `severity`, `text.de`, `text.en` und `transient`. Kurzlebige Hinweise besitzen zusätzlich Zeitfelder und verschwinden nach Ablauf. Statusbedingungen bleiben nur so lange bestehen, wie der aktuelle Status sie bestätigt.

Wichtige Codes:

| Code | Bedeutung | Maßnahme |
|---|---|---|
| `HC_OPERATION_ACTION_REQUIRED` | Gerät fordert lokalen Eingriff | Gerätedisplay/Tür/Vorräte prüfen |
| `HC_STREAM_DISCONNECTED` | SSE-Verbindung getrennt | Reconnect abwarten; bei Dauerfehler Ausgang 2 prüfen |
| `HC_OAUTH_INSUFFICIENT_SCOPE` | Token hat zu wenige Rechte | Scope korrigieren, deployen, neu autorisieren |
| `HC_OAUTH_AUTHORIZATION_EXPIRED` | Autorisierung fehlt/abgelaufen/widerrufen | neu autorisieren |
| `HC_API_RATE_LIMITED` | HTTP 429/API-Limit | Polling reduzieren, `retryAfter` beachten |
| `HC_NETWORK_ERROR` | Netzwerk/Timeout | DNS, Proxy, TLS und Erreichbarkeit prüfen |

Der Events-Node erzeugt zusätzlich synthetische `CONNECTED`-/`DISCONNECTED`-Lebenszyklusereignisse für den tatsächlichen SSE-Stream. Sie enthalten keine Zugangsdaten.

## 15. HTTP 429 / `1000 calls in 1 day`

Der lokale Limiter verhindert standardmäßig, dass dieses Paket mehr als 900 API-Versuche in einem rollierenden 24-Stunden-Fenster sendet. In der Verbindung werden der aktuelle Verbrauch und eine eventuelle Sperrzeit angezeigt. Bei ausgeschöpftem Budget erscheint `LOCAL_RATE_LIMITED`; `retryAfter` und `resetAt` geben die verbleibende Wartezeit an.

Wenn Home Connect bereits HTTP 429 mit einer Meldung wie `remaining period of 75502 seconds` zurückgegeben hat, übernimmt das Paket diese Sperrzeit und sendet bis dahin keine weiteren API-Aufrufe. Der Zustand bleibt über Deploys und Neustarts erhalten. Nicht wiederholt auf **Test** oder Inject-Nodes klicken. Polling deutlich reduzieren, nach Möglichkeit einen All-Appliance-Event-Stream verwenden und Snapshots nicht alle 15 Sekunden abrufen. Andere Rechner oder Programme mit derselben Developer-Portal-Application separat prüfen, da sie nicht vom lokalen Zähler erfasst werden.

## 16. Firmwareversion oder Firmwareupdate fehlt

Das ist kein Konfigurationsfehler. Die öffentlich dokumentierte Home-Connect-API stellt Firmwareversion, Firmwarehistorie und Firmwareupdate nicht bereit. Das Paket verwendet keine undokumentierten Endpunkte und bietet absichtlich keinen Firmware-Button. Sichtbar sind nur dokumentierte Geräteinformationen wie Name, Marke, Typ, `vib`/E-Nummer und Verbindungsstatus, sofern geliefert. Firmware ausschließlich über offizielle Hersteller-/Home-Connect-Kanäle prüfen.

## 17. Lokale LAN-Profile und Verbindungsfehler

Bei lokalen Konfigurationen sind OAuth-, Autorisierungs-, Refresh-Token- und Cloud-Tagesbudget-Bereiche absichtlich ausgeblendet. Erfolgreich ist die Einrichtung, wenn **Verbindung testen** in jeder Gerätekarte eine lokale Read-only-Verbindung meldet und Discover/Read/Events `local: true` sowie `readOnly: true` liefern.

In dieser Reihenfolge prüfen:

1. Prüfen, ob der Profilordner im Node-RED-Host/-Container wirklich unter dem eingetragenen Pfad gemountet und für das Servicekonto lesbar ist. Dann ausdrücklich **Profile suchen / Geräte erkennen** anklicken.
2. Geräte-JSON, `DeviceDescription.xml` und `FeatureMapping.xml` desselben Profile-Downloader-Exports zusammenlassen. `LOCAL_PROFILE_FILES_INCOMPLETE` nennt die fehlende Datei; `LOCAL_PROFILE_ORPHAN_COMPANION` weist auf unpassende Ordner/Dateinamen hin.
3. Bei einer doppelten Profil-ID nennt der Scanner die betroffenen Dateien. Keine Zuordnung raten: doppelten/alten Export entfernen und erneut suchen.
4. Nach erfolgreicher Suche muss zum Beispiel **3 Geräteprofile gefunden** erscheinen. Für jedes vollständige Profil gibt es genau eine Karte. Fehlt eine Karte, die Hinweise direkt unter dem Suchergebnis lesen.
5. In jeder Karte Host/IP eintragen. Fehlende, formal falsche oder öffentliche IPs werden rot markiert. Hostnamen werden beim Test serverseitig aufgelöst. Nur private/link-lokale Ziele sind erlaubt; Loopback und öffentliche Ziele werden mit `LOCAL_HOST_NOT_PRIVATE` abgewiesen. Ein Einzeltest verwendet sofort die aktuellen Felder genau dieser Karte, benötigt noch kein Fertig/Deploy und wird nicht von leeren Nachbarkarten blockiert.
6. **Verbindungsart: Auto (empfohlen)** beibehalten. Eine ausdrückliche Profilangabe AES/TLS/PSK hat Vorrang; IV-Anwesenheit ist nur der Fallback. `LOCAL_PROFILE_IV_MISSING` bei AES-Override bedeutet, dass das Original-IV fehlt.
7. Pro Karte **Verbindung testen** anklicken und die sieben Stufen lesen. `LOCAL_NETWORK_ERROR`/Timeout stoppt bei **IP erreichbar**. `EHOSTUNREACH` ist ein fehlender Netzwerkpfad und kein Protokollfehler: Gerät aus/Standby, IP, WLAN, VLAN-Routing und Firewall prüfen. `LOCAL_TLS_PSK_UNAVAILABLE`/`LOCAL_TRANSPORT_UNSUPPORTED` stoppt bei **Transport erkannt**. `LOCAL_WEBSOCKET_UPGRADE_FAILED` bedeutet: TCP beziehungsweise TLS war erfolgreich, aber das Gerät lehnte den Upgrade auf `/homeconnect` ab. Der Test liest nur lokale Ressourcen.
8. Erst wenn alle Karten gültig sind: **Fertig → Deployen**. Dabei wird `localDeviceMappings` nochmals gespeichert und nach Deploy wiederhergestellt. Host/IP nie in Read-/Events-Nodes eintragen; dort die verständliche Bezeichnung wählen, während intern die volle ID erhalten bleibt.
9. `LOCAL_CRYPTO_AUTH_FAILED`, `LOCAL_PROFILE_KEY_REJECTED` oder `LOCAL_PROFILE_AUTHENTICATION_FAILED` bedeutet falsches/unvollständiges Profil; PSK/IV weder bearbeiten noch raten. `LOCAL_PROTOCOL_REJECTED` ist davon getrennt und nennt Ressource, Aktion, ausgehandelte Version und Gerätecode. Einzelne nicht unterstützte `/ro/*`-Pfade sind zulässig, sobald ein anderer Read oder ein Geräte-`NOTIFY` Werte geliefert hat. Werden alle fünf Pfade abgelehnt, enthält `rejectedResources` die komplette Folge. `/ci/services` muss Version 1 ohne leeres `data`-Array verwenden.
10. Werden nur numerische UIDs angezeigt, die XML-Dateien desselben Downloads wiederherstellen und neu suchen.
11. Manuelles Profil-JSON ist nur der optionale Bereich **Erweitert**. Bei gesetztem Ordner ist es deaktiviert/ignoriert. Bei Bedarf mit der Schaltfläche aus erkannten Profilen und Zuordnungen erzeugen statt selbst schreiben.
12. Für reale Firmwareabweichungen unter **Erweitert** den sicheren Protokoll-Mitschnitt kurz aktivieren. Ohne Pfad erscheint nur der begrenzte, bereinigte Speicherpuffer beim Test; ein absoluter Pfad schreibt unter POSIX JSONL mit `0600`. Unter Windows den Mitschnittpfad per NTFS-ACL auf das Node-RED-Dienstkonto beschränken, weil POSIX-Rechte dort nicht zuverlässig sind. PSK, IV, Schlüssel, Nonces sowie Geräte-/Netzwerkkennungen werden entfernt. Vor Weitergabe trotzdem prüfen, danach ausschalten und Datei löschen.
13. `LOCAL_HEARTBEAT_TIMEOUT` oder `LOCAL_DISCONNECTED` nach zunächst erfolgreicher Verbindung deutet auf Strom/Standby, WLAN-Roaming, VLAN/Firewall oder Paketverlust. Die Runtime baut Transport, Kryptozustand, `sID`, `msgID`, Services und Read-Session mit Backoff vollständig neu auf.

`LOCAL_READ_ONLY` ist kein Verbindungsfehler, sondern die erfolgreiche lokale Schreibsperre. Für abgesicherte Schreibzugriffe eine separate Cloud-Konfiguration verwenden. Siehe [Lokale LAN-Verbindung](LOCAL-LAN.de.md).
