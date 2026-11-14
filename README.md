# netstatus

The network's state, for alerts and at a glance: a daemon that polls the devices and publishes what it finds
to MQTT, and the command-line tools for ports, PoE and wifi that it shares its code with.

| | |
|---|---|
| **netstatusd** | polls each configured device over SNMP every 30 s and publishes its state, retained, to `network/<host>` |
| `port-status.js` | every switch and router port in one table: link, speed, PoE, traffic, RouterOS and RouterBOOT versions, supply voltage |
| `poe-mikrotik.js` | one MikroTik's ports and PoE in detail; turns PoE on, off or power-cycles it, enables and disables ports |
| `wifi-status.js` | every AP's radios and clients in one view, with signal and rates (`--rssi` for the Edimax's signal over SSH) |
| `wifi-mikrotik.js`, `wifi-edimax.js` | the per-vendor readers `wifi-status.js` uses, runnable on their own |
| `wifi-channel.js` | the channel plan: shows it against what the radios are on, applies it, reverts the last apply |
| `wifi-ft.js` | turns 802.11r (fast transition) on or off across the MikroTik APs; `off` restores what `on` changed |

Each tool has a header comment with its usage, and `help`.

## Alerts

netstatusd raises no alerts itself. mqtt-watchdog already turns JSON on MQTT into ntfy and email notifications,
with hold times, reminders and recovery notices, so each condition is a field in netstatusd's message and an
`alert.N` block in the watchdog's config. On the workshop (`mqtt-watchdog-house.cfg`):

```
alert.12.name=Router on UPS battery
alert.12.topic=network/+
alert.12.field=on_battery
alert.12.equals=true
```

with a `topic.N` watch on `network/<host>`: netstatusd publishes even for a device that does not answer
(`"reachable": false`), so that topic goes quiet only if netstatusd itself stops.

The message, one per device:

```json
{ "time": "2026-11-14 13:40:00", "host": "mh-rb960pgs", "label": "rbpro", "reachable": true,
  "os": "RouterOS", "board": "RB960PGS-PB", "version": "7.25.1", "firmware": "7.25.1", "uptime_s": 7322,
  "temperature": 43, "voltage": 23.9, "on_battery": false, "ports_up": 5, "poe_watts": 3.3,
  "ports": [ { "name": "uplink-annex", "alias": "LAN: annex (PoE out)", "link": "up", "speed_mbps": 1000,
               "poe": "powered-on", "poe_watts": 3.3, "poe_fault": false }, ... ] }
```

Fields that do not apply are left out, not null: `on_battery` only for a device with a `battery-<label>`
setting, `poe` only on a PoE port. A field absent from a message leaves mqtt-watchdog's alert on it alone.
`poe_fault` is true for any PoE state other than disabled, waiting for a load, powered on or PoE-in detected.
So it covers overload, short circuit, voltage or current too low, and so on. A PoE port watch is an array alert:
`alert.N.array=ports`, `key=name`, `field=poe_fault`, `equals=true`.

## Configuration

`netstatus.cfg`, plain `key=value`: the MQTT server and topic, the interval, the SNMP community,
`device-<label>=<host>` for each device to poll, and `battery-<label>=<volts>` for a device fed from mains and a
DC UPS at once. Installed as `/etc/default/netstatus`; a per-host `netstatus.<hostname>.cfg` is used instead when
present, and is not committed.

The tools take their credentials from the environment, as before: `ROUTEROS_USER` / `ROUTEROS_PASS` for the
RouterOS API (the wifi tools, PoE control), `WIFI_PASS` for the Edimax. netstatusd needs none: it reads over
SNMP only. Names for MACs come from `/opt/ostratakenebranna/devices/devices-known.conf` (`DEVICES_KNOWN`
overrides it).

## Install

```
make            # syntax check
make test       # one round of polling, printed
make install    # the daemon to /usr/local/lib/netstatus, the config to /etc/default/netstatus, the service
make status
```

## License

CC BY-NC-SA 4.0 — see [LICENSE](LICENSE).
