# Lokale LAN-Verbindung (nur lesend)

Zurück zur [deutschen README](../README.de.md) · [English](LOCAL-LAN.md)

## Umfang und feste Sicherheitsgrenze

Version 0.2.0 ergänzt einen **experimentellen, inoffiziellen lokalen Transport** für Home-Connect-Geräte. Node-RED verbindet sich direkt mit einer privaten/link-lokalen LAN-Adresse des Geräts. Normale lokale Reads und Events benötigen zur Laufzeit keine Home-Connect-Cloud.

Das lokale Protokoll ist keine offizielle öffentliche API. Gerätefirmware kann es ohne Ankündigung ändern. Deshalb gilt technisch erzwungen:

- lokale Ressourcen werden **nur gelesen**;
- der lokale Client besitzt keine Schreibimplementierung;
- ein Write-Node an einer lokalen Verbindung liefert immer `LOCAL_READ_ONLY`, bevor Validierung oder Netzwerkzugriff stattfinden;
- lokal werden keine Programme, Optionen, Einstellungen, Befehle, Pairing-/Registrierungs-/Deregistrierungs-, Firmware- oder Update-Anfragen gesendet.

Der bestehende Cloud-Client bleibt unverändert: vertraulicher OAuth-Authorization-Code-Flow ohne PKCE, Rate-Limit-Schutz, SSE, Health/Warnungen, Dry-Run und abgesicherte Cloud-Schreibzugriffe funktionieren über separate Cloud-Config-Nodes weiter.

## Unterstützte Transporte

`connectionType` und Schlüssel stammen aus dem Geräteprofil:

| Profil | Endpunkt | Schutz |
|---|---|---|
| `AES` mit IV | `ws://<privater-host>:80/homeconnect` | fortlaufender AES-256-CBC-Stream plus verketteter, gekürzter HMAC-SHA256 |
| `TLS`/`PSK` | `wss://<privater-host>:443/homeconnect` | TLS 1.2 PSK (Profilidentität oder `HCCOM_Local_App`; PSK-Cipher-Suites) |

Beide Varianten verwenden RFC-6455-WebSocket-Frames und den lokalen Home-Connect-Session-Handshake. Der Upgrade-Request entspricht den hcpy/homeconnect-websocket-Clients: exakt `GET /homeconnect HTTP/1.1`, `Upgrade: websocket`, `Connection: Upgrade`, `Host`, URL-abgeleitetes `Origin`, RFC-6455-Key und Version 13. Ping/Pong läuft alle 20 Sekunden. Nach einem Abbruch wird eine vollständig neue Session samt frischem AES-/HMAC-Zustand aufgebaut; exponentieller Backoff mit Jitter wächst von ungefähr einer bis höchstens 60 Sekunden. Beim ersten HMAC-, Padding- oder UTF-8-Fehler wird die AES-Verbindung sofort geschlossen, weil sich der fortlaufende Stream nicht sicher resynchronisieren lässt.

## Profile beschaffen

Den Community-[Home Connect Profile Downloader](https://github.com/bruestel/homeconnect-profile-downloader) verwenden. Er meldet sich einmalig am Konto an und lädt je registriertem Gerät:

- `<seriennummer>.json` — Host-/Gerätedaten und PSK/IV;
- `<seriennummer>_DeviceDescription.xml`;
- `<seriennummer>_FeatureMapping.xml`.

Cloud/Konto wird nur zum Erzeugen oder Aktualisieren der Profile benötigt. Die lokale Node-RED-Runtime automatisiert keinen Konto-Login, liest keine Passwörter aus und lädt Profile nicht selbst herunter.

Die Dateien sind Geheimnisse. Nie committen, in Flows exportieren, an Issues anhängen oder in Screenshots zeigen.

## Node-RED einrichten

1. Das Downloader-Archiv auf dem Node-RED-Host entpacken.
2. Verzeichnis auf das Node-RED-Servicekonto beschränken, z. B. `chmod 700 /data/homeconnect-profiles` und `chmod 600 /data/homeconnect-profiles/*`.
3. Eine neue Home-Connect-Konfiguration erstellen und **Local LAN (read-only)** wählen.
4. Den serverseitigen **Profilordner** eintragen und **Profile suchen / Geräte erkennen** anklicken. Gemeint ist der für den Node-RED-Prozess sichtbare Pfad; bei Docker also der Pfad im Container. Der Scanner durchsucht Unterordner und gruppiert `<basis>.json`, `<basis>_DeviceDescription.xml` und `<basis>_FeatureMapping.xml`. Liegt nur ein Geräte-JSON im Unterordner, werden auch unpräfixte XML-Namen akzeptiert.
5. Das Ergebnis lesen, zum Beispiel **3 Geräteprofile gefunden**. Ein unvollständiger Satz, ungültiges JSON/Schlüsselmaterial, eine verwaiste Begleitdatei oder eine doppelte Profil-ID wird verständlich aufgeführt und nicht als mehrdeutige Gerätekarte übernommen. Die drei Originaldateien zusammenlassen und erneut suchen.
6. In jeder Gerätekarte genau einen **Host bzw. eine IP** eintragen. Fehlende/formal falsche Werte und öffentliche IP-Literale werden sofort markiert. Ein Hostname wird beim Verbindungstest auf dem Server aufgelöst und muss ausschließlich private/link-lokale Adressen liefern. Ein im Profil gefundener Host ist nur ein Startvorschlag.
7. **Verbindungsart: Auto (empfohlen)** übernimmt zuerst die ausdrückliche Profilangabe `AES`, `TLS` oder `PSK`; nur wenn sie fehlt, bedeutet ein IV AES und kein IV TLS-PSK. Damit wird ein in einem TLS-Export verbliebenes IV nicht mehr fälschlich als AES interpretiert. AES oder TLS nur bei einem bekannten Profilproblem bewusst überschreiben.
8. In jeder Karte **Verbindung testen** anklicken. Der Test sendet die gerade sichtbare Host/IP und Auto/AES/TLS-Auswahl, legt sie über eine eventuell ältere versteckte/deployte Zuordnung und lädt ausschließlich das ausgewählte Profil. Noch leere Nachbarkarten können deshalb kein falsches `LOCAL_MAPPING_HOST_REQUIRED` mehr auslösen. Die Anzeige führt gestuft durch **IP erreichbar → Profil geladen → Transport erkannt → WebSocket verbunden → Session initialisiert → Services erkannt → Read-only-Daten empfangen**. Beim ersten Fehler stoppt sie; spätere Stufen werden übersprungen und es erscheint keine irreführende Folgemeldung `LOCAL_VALUES_UNAVAILABLE`.
9. **Fertig → Deployen**. Jede Kartenänderung aktualisiert `localDeviceMappings`; beim Speichern werden alle Karten nochmals serialisiert. Nach erneutem Öffnen/Deploy stehen daher dieselben Zuordnungen bereit. Anwender bearbeiten kein Mapping-JSON.
10. Im Read-Node nur das konfigurierte Gerät und die gewünschte Lese-Ressource auswählen; ein Host-/IP-Feld gibt es dort nicht. Im Events-Node ein konfiguriertes Gerät oder **Alle konfigurierten Geräte** wählen.

Die Zuordnung Profil zu Host/IP/Transport wird genau einmal als `localDeviceMappings` in der Config-Node gespeichert. Read- und Events-Nodes speichern nur die Profil-/Geräte-ID.

Alle Geräteauswahlen zeigen `Typ — verständlicher Name — Marke/Modell — …letzte vier ID-Zeichen`. Die vollständige technische ID bleibt unverändert der Optionswert und wird in Runtime/Requests nie gekürzt.

**Ausweichweg unter Erweitert:** **Profil-JSON manuell einfügen (optional)** nimmt ein vollständiges Profil nur dann aktiv in Betrieb, wenn kein Ordner gesetzt ist. Bei gesetztem Ordner ist der Bereich standardmäßig eingeklappt/deaktiviert und der Ordner hat Vorrang. **Aus erkannten Profilen und Zuordnungen erzeugen** erstellt das Credential-JSON nach vollständiger Kartenzuordnung. Einsteiger müssen weder Mapping-/Profil-JSON schreiben noch sehen sie einen Credential-Platzhalter als Beispieldaten.

Ebenfalls unter **Erweitert** liegt der standardmäßig ausgeschaltete **sichere Protokoll-Mitschnitt**. Ohne Dateipfad bleibt ein Ringpuffer nur im Speicher und erscheint nach dem Verbindungstest aufklappbar in der Gerätekarte. Ein absoluter serverseitiger Pfad schreibt unter POSIX JSONL mit Dateirecht `0600`; unter Windows muss der Pfad mit einer auf das Dienstkonto beschränkten NTFS-ACL geschützt werden, weil POSIX-Rechte dort nicht zuverlässig abgebildet werden. Aufgezeichnet werden entschlüsselte RX-/TX-Protokollnachrichten und Lifecycle-Ereignisse, aber PSK, IV, Schlüssel, OAuth-Daten, Nonces sowie Geräte-/Netzwerkkennungen werden entfernt. Mitschnitt nur während der Diagnose aktivieren, Datei vor Weitergabe trotzdem prüfen und anschließend wieder ausschalten.

Beispiel der zentralen Zuordnung in einer exportierten, anonymisierten Config-Node (vollständig fiktiv; Schlüssel bleiben im geschützten Profilordner und werden nicht exportiert):

```json
"localDeviceMappings": "[{\"profileId\":\"dishwasher-local\",\"host\":\"192.168.x.x\",\"connectionType\":\"auto\"}]"
```

Bei Docker den Ordner nur lesend einbinden und den Pfad im Container verwenden:

```yaml
volumes:
  - ./homeconnect-profiles:/data/homeconnect-profiles:ro
```

## Lese- und Event-Mapping

Nach dem Handshake liest der Client in dieser Reihenfolge und ausschließlich per `GET`:

- `/ro/allMandatoryValues`
- `/ro/values`
- `/ro/allDescriptionChanges`
- `/ro/activeProgram`
- `/ro/selectedProgram`

Numerische Laufzeit-UIDs werden gegen beide Profildateien aufgelöst. `FeatureMapping.xml` liefert semantische Feature-Namen und – soweit enthalten – Enum-Mitglieder; `DeviceDescription.xml` liefert hexadezimale `uid`-Werte, Kategorien, Access-/Typ-/Einheiten-Metadaten und Enum-Verweise. Der Resolver folgt sowohl direkten `enumerationType`-Attributen als auch verschachtelten `<enumerationType refENID="…"/>`-Elementen, `enid`-Verweisen und `subsetOf`-Vererbung. Manche reale Profile führen die maßgebliche Enum-Tabelle in `DeviceDescription.xml` als `<enumerationType enid="…">`; Enum- und Mitgliedsnamen stehen dort in den unmittelbar vorangestellten XML-Kommentaren. Sämtliche XML-Kennungen (`uid`, `refUID`, `enid`, `refENID`, `enumerationType`, `subsetOf`) sind hexadezimal, selbst wenn sie nur Ziffern enthalten: `2100` bedeutet deshalb dezimale UID 8448 und nicht 2100.

Es gibt keine globale Geräte-UID- oder Enum-Tabelle. Der Rohwert `0` von OperationState wird zum Beispiel nur übersetzt, wenn das ausgewählte Geräteprofil dieses Mitglied definiert. Eine profildefinierte Enum-Tabelle hat immer Vorrang vor der skalaren Behandlung. Profiltyp `Boolean` steuert die Normalisierung von RemoteControlActive, RemoteControlStartAllowed, LocalControlActive und booleschen Optionen. Jedes lokale Element behält `rawValue`; `valueResolved` ist nur bei einem tatsächlich gefundenen Enum-Mitglied, einem gültigen profildefinierten Boolean/Programm oder einem ausdrücklich typisierten Skalarwert `true`. Fehlt ein Enum-Mitglied, bleibt der Rohwert mit `valueResolved: false` sichtbar und diagnostizierbar. Status- und Event-Warnungen werden daraus nicht abgeleitet. `RemoteControlStartAllowed=false` bleibt bei einer lokalen Read-only-Verbindung ohne aktiven Steuerkontext eine neutrale Statusangabe und keine dauerhafte Warnung.

Aufgelöste Status-/Event-Features landen in `status.items`, Einstellungen in `settings.items`; jedes empfangene Element – einschließlich unaufgelöster numerischer UIDs – bleibt in `values.items`. Programmdefinitionen stammen aus den Profilmerkmalen. Werte von `BSH.Common.Root.ActiveProgram` und `BSH.Common.Root.SelectedProgram` werden auf Programmnamen aus dem Profil zurückgeführt; aktuell empfangene Optionswerte werden dem Programmzustand beigefügt. Ein 404 für den optionalen Pfad `/ro/activeProgram` oder `/ro/selectedProgram` löscht deshalb keine Programm-/Optionsdaten, die bereits über `/ro/allMandatoryValues` eingetroffen sind.

Snapshots enthalten die sichere Zusammenfassung `profileResolution` mit Anzahl der Features/Elemente/aufgelösten/unaufgelösten/Status-/Einstellungs-/Programmwerte und höchstens 20 unaufgelösten numerischen UIDs. Host, Gerätekennung, PSK, IV, Nonce und Credentials sind darin nicht enthalten. Ein abgelehnter optionaler Read steht in `refresh`; erfolgreich über einen anderen Pfad oder per Geräte-`NOTIFY` gelieferte Daten werden nicht verworfen.

Der lokale Events-Node liefert normierte `CONNECTED`-, `DISCONNECTED`- und `STATUS`-Nachrichten über dieselbe Health-/Warning-Schicht wie Cloud-Daten. Lokale Ausgaben enthalten `connection.local: true` und `connection.readOnly: true`.

Ist ein konfigurierter Host nicht erreichbar, liefern Snapshot-/Capability-Reads das Gerät mit `connected: false`, `connection.state: "offline"` und ausschließlich einem sicheren Netzwerkgrund statt eines sachfremden generischen Fehlers. Bereits in der Session bekannte Werte bleiben als veraltet markiert erhalten. Ein aktiver Events-Node verbindet mit begrenztem Backoff weiter und liefert nach Wiedererreichbarkeit automatisch neue Daten.

Der vollständige Ablauf orientiert sich an hcpy und homeconnect-websocket:

1. Das Gerät sendet `POST /ei/initialValues`. Die Antwort verwendet dieselbe `sID`, dieselbe `msgID` und die EI-versionabhängige Application-Struktur. Der nächste eigene Zähler beginnt exakt bei `data.edMsgID`.
2. `/ci/services` wird immer als `GET`, Version 1 und **ohne** `data`-Feld angefordert. Gerätecode `0`, `200` oder ein fehlender Code gilt als Erfolg.
3. Die gelieferten Versionen werden pro Service verwendet. Bei `ci < 3` wird `/ci/authentication` zuerst wie hcpy per `POST` mit 32-Byte-Nonce angefragt; nur eine konkrete Ablehnung löst den dokumentierten `GET`-Fallback aus.
4. `NOTIFY /ei/deviceReady` verwendet die ausgehandelte EI-Version und kein leeres `data`-Array.
5. Geräteinformationen werden optional über `/iz/info` angefragt, wenn `iz` gemeldet wurde, sonst über `/ci/info`; `/ni/info` wird nur bei vorhandenem `ni` verwendet. Eine Ablehnung dieser optionalen Diagnosepfade blockiert die Read-only-Session nicht.
6. Die fünf `/ro/*`-GETs verwenden die gemeldete `ro`-Version. Nicht jedes Modell unterstützt jeden Pfad: einzelne Codes 400 werden dokumentiert und die übrigen Lesepfade fortgesetzt.

Unaufgeforderte `NOTIFY`- oder `RESPONSE`-Nachrichten des Geräts werden sofort verarbeitet. Bereits vom Gerät gelieferte Initial-/Mandatory-/Value-Daten gelten als erfolgreicher Read-only-Empfang, auch wenn ein späterer Fallback-GET abgelehnt wird. Geräte-originierte `GET`-/`POST`-Housekeeping-Requests (zum Beispiel `/ei/keepAlive`) beantwortet der Client mit `RESPONSE`, derselben Session und derselben Geräte-`msgID`; dadurch wird der eigene `edMsgID`-Zähler nicht verschoben. WebSocket-Ping/Pong bleibt davon getrennt. Der Test bleibt technisch rein lesend: Nonce, `deviceReady` und Protokollantworten ändern weder Einstellungen noch Programme.

## Netzwerkbeschränkung

Vor dem Verbindungsaufbau muss der Host ausschließlich auf RFC1918-, IPv4-Link-Local-, IPv6-Unique-Local- oder IPv6-Link-Local-Adressen auflösen. Loopback, URLs, Pfade, Zugangsdaten im Hostnamen und öffentliche DNS-Ziele werden abgewiesen. Das Profilfeld kann damit nicht als beliebiges Internet-Socket-Ziel missbraucht werden.

## Fehlerbehebung

| Code/Symptom | Bedeutung/Maßnahme |
|---|---|
| `LOCAL_PROFILE_REQUIRED` | Profilordner oder optionales manuelles Profil-JSON setzen, speichern und deployen. |
| `LOCAL_PROFILE_FOLDER_REQUIRED` | Die automatische Erkennung benötigt einen Ordner statt einer einzelnen Datei. |
| `LOCAL_PROFILE_FILES_INCOMPLETE` | Geräte-JSON, `DeviceDescription.xml` und `FeatureMapping.xml` desselben Downloads zusammenlassen und neu suchen. |
| `LOCAL_PROFILE_ORPHAN_COMPANION` | Eine XML-/JSON-Begleitdatei passt nach Ordner/Basisname zu keinem Geräte-JSON; Originalnamen wiederherstellen. |
| `LOCAL_MAPPING_HOST_REQUIRED` | In der ausgewählten Karte selbst fehlt Host/IP. Leere Nachbarkarten blockieren den Einzeltest nicht. |
| `LOCAL_MAPPING_DUPLICATE` | Für jede Profil-ID genau eine zentrale Zuordnung behalten. |
| `LOCAL_MAPPING_PROFILE_NOT_FOUND` | Der Ordner wurde nach der Zuordnung geändert; neu scannen und veraltete Einträge entfernen. |
| `LOCAL_PROFILE_KEY_MISSING` / `LOCAL_PROFILE_IV_MISSING` | Vollständiges Profil neu laden; Schlüssel nicht erfinden. |
| `LOCAL_HOST_NOT_PRIVATE` | DNS/IP korrigieren; nur private/link-lokale Ziele sind zulässig. |
| `LOCAL_NETWORK_ERROR` / `LOCAL_CONNECT_TIMEOUT` | Gleiches LAN, DNS/IP, VLAN/Firewall, Geräte-WLAN und Port 80/443 prüfen. `EHOSTUNREACH` bedeutet fehlenden Netzwerkpfad; häufig sind Gerät aus/Standby, falsche IP, VLAN-Routing oder Firewall die Ursache. |
| `LOCAL_HANDSHAKE_TIMEOUT` / `LOCAL_REQUEST_TIMEOUT` | Socket geöffnet, aber Protokoll-/Leseantwort blieb aus. Profil, Transport, Firmwarekompatibilität und Paketverlust prüfen. |
| `LOCAL_TRANSPORT_UNSUPPORTED` | Auto beibehalten oder einen falschen AES-/TLS-Override korrigieren; außerdem PSK-Unterstützung von Node.js/OpenSSL prüfen. |
| `LOCAL_TLS_PSK_UNAVAILABLE` | Die Node.js/OpenSSL-Laufzeit bietet keine der benötigten TLS-1.2-PSK-Cipher-Suites; Laufzeit/OpenSSL wechseln oder korrekt bauen. |
| `LOCAL_PROFILE_KEY_REJECTED` / `LOCAL_PROFILE_AUTHENTICATION_FAILED` | Profil/Schlüssel passt nicht zu diesem Gerät oder ist unvollständig. Richtiges Profil neu laden; Schlüssel nie raten. |
| `LOCAL_PROTOCOL_REJECTED` | Das Gerät hat einen Protokollcode (z. B. 400) geliefert. Die Diagnose nennt konkret Ressource, Aktion, ausgehandelte Version und Gerätecode; bei vollständig abgelehnter Lesesequenz zusätzlich alle Versuche. Bereinigten Mitschnitt aktivieren und Transport/Profil/Firmware vergleichen. |
| `LOCAL_CONNECT_FAILED` | Verbindungsfehler ohne genauere Netzwerk-/Schlüssel-/Transportklasse; die vorherigen Punkte prüfen. |
| `LOCAL_WEBSOCKET_UPGRADE_FAILED` | TCP/TLS steht, aber das Gerät lehnt den RFC-6455-Upgrade auf `/homeconnect` ab. Profilzuordnung, Auto/AES/TLS, IP und eventuellen Proxy prüfen; ein vorhandener HTTP-Status wird ohne Header/Schlüssel angezeigt. |
| `LOCAL_CRYPTO_AUTH_FAILED` / `LOCAL_CRYPTO_PADDING_INVALID` | PSK/IV falsch oder AES-CBC/HMAC-Streamzustand verloren; der Client schließt sofort. Bei Wiederholung Profile neu laden. |
| `LOCAL_HEARTBEAT_TIMEOUT` / `LOCAL_DISCONNECTED` | Verbindung war aufgebaut, antwortet aber nicht mehr. Gerätestrom/Standby, WLAN, VLAN und Firewall prüfen; der Client baut die Session mit Backoff vollständig neu auf. |
| `LOCAL_TRACE_PATH_INVALID` | Für einen Dateimitschnitt einen absoluten Pfad im Node-RED-Host/Container angeben. Ohne Pfad ist nur der sichere Speicherpuffer aktiv. |
| TLS-Handshake-Fehler | TLS-Profil, PSK-Cipher-Suites der Node.js/OpenSSL-Laufzeit und fehlende TLS-Inspection prüfen. |
| nur numerische UIDs | XML-Mapping fehlt/passt nicht. Alle drei Downloader-Dateien zusammenlassen. |
| `LOCAL_READ_ONLY` | Erwartete Sicherheitsgrenze. Für abgesicherte Schreibvorgänge separate Cloud-Verbindung verwenden. |

## Community-Protokollreferenzen

Die Implementierung wurde für dieses Node-RED-Paket eigenständig anhand öffentlich verfügbarer Community-Beobachtungen erstellt, insbesondere:

- `chris-mc1/homeconnect_local_hass` und `chris-mc1/homeconnect_websocket`
- `hcpy2-0/hcpy`
- `zibous/homeconnect-hcpy`
- `Asmir1975/homeconnect_local_hass-UI`
- Protokollnotizen in `SukramJ/go-homeconnect2mqtt`

Im Paket befinden sich weder echte Geräteprofile/Zugangsdaten/Seriennummern/Hosts/PSK/IV noch kopierter Quellcode dieser Projekte. Hinweise zu Zuordnung und Lizenzen stehen in [NOTICE](../NOTICE).
