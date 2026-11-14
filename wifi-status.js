#!/usr/bin/env node
//
// wifi-status.js — one view of every AP on the network: what each radio is doing, and
// every associated client in a single table.
//
// Replaces wifi-status.sh, which ran wifi-mikrotik.js and wifi-edimax.js back to back and
// left you reading four separate headers and four separate client tables. The useful
// questions cut across APs — where is this client, which AP is it on, is it on the band I
// expect, is the same client associated to two APs at once — and none of them are easy to
// answer from output that is grouped by AP.
//
// So the client table is ONE table with a Device column, sorted by client name. Sorting by
// name rather than by AP is deliberate: it puts a client that appears on two APs on adjacent
// rows, which is how a ping-ponging client becomes visible rather than something you have to
// notice across two screens of output.
//
//   Usage:
//     ./wifi-status.js            radios and clients across all configured APs
//     ./wifi-status.js json       the same data as JSON, for piping
//     ./wifi-status.js help
//
//   Live view:  watch -n5 ./wifi-status.js
//
//   Environment:
//     ROUTEROS_USER / ROUTEROS_PASS   RouterOS API credentials (required)
//     WIFI_USER / WIFI_PASS           Edimax CLI credentials (only for its dBm reading)
//     DEVICES_KNOWN                   devices-known.conf
//
// Each AP is read concurrently — they are separate connections, so nothing races. Within a
// single RouterOS box the reads stay sequential, for the reason wifi-mikrotik.js documents.
//
// An AP that is unreachable is reported in place and the rest still print: a box being down
// is exactly when you want to see what the others are carrying.

const mikrotik = require('./wifi-mikrotik.js');
const edimax = require('./wifi-edimax.js');
const { nameFor, loadKnownDevices } = require('./devices-known.js');

// The APs to poll. `label` is what appears in the Device column — short on purpose, because
// it repeats on every client row; the full host is shown once in the Devices table.
const DEVICES = [
    { host: 'uh-hapbelite', label: 'hapbelite', kind: 'mikrotik' },
    { host: 'st-rbomnitikpg-5hacd', label: 'omnitik', kind: 'mikrotik' },
    { host: '192.168.0.29', label: 'rb911g', kind: 'mikrotik' },
    // rssi costs an SSH login to a 2008-vintage dropbear (~12s) and is the only way to get
    // dBm out of this box; worth it here because dBm is the column being compared across APs.
    { host: 'AP74DA38682014', label: 'edimax', kind: 'edimax', rssi: true },
];

// The loser of the race must be cleared. A pending setTimeout keeps the event loop alive, so
// leaving it behind means the process sits there after the report has printed, until the
// longest timeout expires — which looks exactly like a hang.
function withTimeout(p, ms, what) {
    let timer;
    const limit = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: timed out after ${ms / 1000}s`)), ms);
    });
    return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

// A channel number is more use than a frequency when comparing APs, but the Edimax reports
// only the channel and MikroTik only the frequency, so derive whichever is missing.
const freqOf = (channel, band) => (band === 2.4 ? 2407 + 5 * channel : 5000 + 5 * channel);
// The Edimax station table spells uptime out ("16 hours 57 min 8 secs") while RouterOS uses
// "16h57m1s". Two formats in one column is unreadable, so normalise onto the compact one.
function compactUptime(v) {
    if (!v) return null;
    const s = String(v);
    if (/^\d+[dhms]/.test(s)) return s; // already compact
    const g = (re) => {
        const m = s.match(re);
        return m ? Number(m[1]) : 0;
    };
    const d = g(/(\d+)\s*day/),
        h = g(/(\d+)\s*hour/),
        m = g(/(\d+)\s*min/),
        sec = g(/(\d+)\s*sec/);
    return (d ? `${d}d` : '') + (d || h ? `${h}h` : '') + (d || h || m ? `${m}m` : '') + `${sec}s`;
}

const bandOf = (freq) => (freq >= 2400 && freq < 2500 ? 2.4 : freq >= 5900 ? 6 : freq >= 5000 ? 5 : null);

// ---------------------------------------------------------------- collection

async function readMikrotik(dev) {
    const r = await withTimeout(mikrotik.readClients({ host: dev.host }), 45000, dev.label);
    const byIface = {};
    for (const radio of r.radios) if (radio.freq) byIface[radio.name] = radio;
    // An extra SSID rides on its master's radio: the band comes from the master, the SSID is its own.
    for (const radio of r.radios) if (radio.slave && byIface[radio.master]) byIface[radio.name] = { ...byIface[radio.master], ssid: radio.ssid };

    return {
        ...dev,
        board: r.sys.board,
        version: r.sys.version ? r.sys.version.replace(/ \(.*\)/, '') : null,
        uptime: r.sys.uptime,
        stack: r.stack || (r.path || '').replace('/print', ''),
        radios: r.radios.map((radio) => ({
            name: radio.name,
            mac: radio.mac,
            channel: radio.channel,
            freq: radio.freq,
            band: radio.freq ? bandOf(radio.freq) : null,
            width: radio.width,
            proto: radio.proto,
            power: radio.txPower,
            noise: radio.noise,
            ccq: radio.ccq,
            peers: radio.peers,
            slave: radio.slave,
            disabled: radio.disabled,
        })),
        clients: r.clients.map((c) => {
            const mac = mikrotik.pick(c, 'mac-address');
            const iface = mikrotik.pick(c, 'interface');
            const radio = byIface[iface];
            return {
                device: dev.label,
                name: nameFor(mac, r.known),
                mac,
                radio: iface,
                band: radio ? bandOf(radio.freq) : null,
                // The legacy registration table has no ssid field, so fall back to the one the
                // radio itself advertises rather than printing '-' for every legacy-stack client.
                ssid: (mikrotik.pick(c, 'ssid') ?? '') || (radio ? radio.ssid : null) || null,
                signal: mikrotik.fmtSignal(mikrotik.pick(c, 'signal', 'signal-strength', 'rx-signal')),
                tx: mikrotik.fmtRate(mikrotik.pick(c, 'tx-rate')),
                rx: mikrotik.fmtRate(mikrotik.pick(c, 'rx-rate')),
                uptime: mikrotik.pick(c, 'uptime'),
            };
        }),
    };
}

async function readEdimax(dev) {
    // Longer budget than the MikroTiks: the dBm reading is an interactive SSH session with
    // fixed delays between commands, not a query.
    const r = await withTimeout(edimax.readClients({ host: dev.host, rssi: dev.rssi }), dev.rssi ? 90000 : 30000, dev.label);
    return {
        ...dev,
        board: (r.sysDescr || 'Edimax').split(/[,(]/)[0].trim(),
        version: null,
        uptime: compactUptime(r.uptime),
        stack: 'snmp',
        radios: r.radios.map((radio) => ({
            name: radio.name,
            mac: radio.mac,
            channel: radio.channel || null,
            freq: radio.channel ? freqOf(radio.channel, radio.band_ghz) : null,
            band: radio.band_ghz,
            // Width, protocol, tx power, noise floor and CCQ are simply not in this firmware's
            // MIB — blank here means unavailable, not zero. See wifi-edimax.js.
            width: null,
            proto: null,
            power: null,
            noise: null,
            ccq: null,
            peers: r.clients.filter((c) => c.radio === radio.name).length,
            disabled: radio.disabled,
        })),
        clients: r.clients.map((c) => ({
            device: dev.label,
            name: c.name,
            mac: c.mac,
            radio: c.radio,
            band: c.band_ghz === '2' ? 2.4 : Number(c.band_ghz) || null,
            ssid: c.ssid || null,
            // Prefer real dBm when the SSH reading got it; the SNMP percentage is a vendor
            // scale that is not comparable with the MikroTiks' dBm, so it is labelled as %.
            signal: c.rssi_dbm != null ? `${c.rssi_dbm}dBm` : c.signal_pct != null ? `${c.signal_pct}%` : '-',
            tx: '-', // not exposed by this firmware, by any route
            rx: '-',
            uptime: compactUptime(c.uptime),
        })),
    };
}

// ---------------------------------------------------------------- output

function table(head, rows, indent = '  ') {
    if (!rows.length) return;
    const all = [head, ...rows].map((r) => r.map((c) => (c === null || c === undefined || c === '' ? '-' : String(c))));
    const w = head.map((_, i) => Math.max(...all.map((r) => (r[i] || '').length)));
    for (const r of all)
        console.log(
            indent +
                r
                    .map((c, i) => c.padEnd(w[i]))
                    .join('  ')
                    .trimEnd()
        );
}

function report(results) {
    const ok = results.filter((r) => !r.error);
    const clients = ok.flatMap((r) => r.clients);

    console.log(`WiFi status  ·  ${ok.length}/${results.length} devices  ·  ${clients.length} clients\n`);

    console.log('Devices');
    table(
        ['Device', 'Host', 'Board', 'Version', 'Uptime', 'Stack'],
        results.map((r) => (r.error ? [r.label, r.host, `UNREACHABLE — ${r.error}`, '', '', ''] : [r.label, r.host, r.board, r.version, r.uptime, r.stack]))
    );

    console.log('\nRadios');
    table(
        ['Device', 'Radio', 'BSSID', 'Channel', 'Width', 'Proto', 'Power', 'Noise', 'CCQ', 'Peers'],
        ok.flatMap((r) =>
            r.radios.map((radio) => {
                // A disabled radio, or a slave SSID sharing a master's radio, has no figures of
                // its own — say which it is rather than printing a row of dashes that reads like
                // a fault.
                if (radio.disabled) return [r.label, radio.name, radio.mac, 'DISABLED', '', '', '', '', '', ''];
                if (radio.slave) return [r.label, radio.name, radio.mac, '(extra BSSID on a shared radio)', '', '', '', '', '', ''];
                return [
                    r.label,
                    radio.name,
                    radio.mac,
                    radio.channel != null ? `${radio.channel} (${radio.freq}MHz)` : null,
                    radio.width ? `${radio.width}MHz` : null,
                    radio.proto,
                    radio.power ? `${radio.power}dBm` : null,
                    radio.noise ? `${radio.noise}dBm` : null,
                    radio.ccq ? `${radio.ccq}%` : null,
                    radio.peers,
                ];
            })
        )
    );

    console.log('\nClients');
    if (!clients.length) {
        console.log('  (none associated on any device)');
        return;
    }
    // By name, then device: a client on two APs lands on adjacent rows.
    const sorted = [...clients].sort((a, b) => (a.name === b.name ? String(a.device).localeCompare(b.device) : String(a.name).localeCompare(String(b.name))));
    table(
        ['Device', 'Name', 'MAC', 'Radio', 'Band', 'SSID', 'Signal', 'TX-Rate', 'RX-Rate', 'Uptime'],
        sorted.map((c) => [c.device, c.name, c.mac, c.radio, c.band ? `${c.band}G` : null, c.ssid, c.signal, c.tx, c.rx, c.uptime])
    );

    // The same MAC on two APs at once means the client is mid-flap, not that it is connected
    // twice — the registration tables just have not aged out yet. It is the signature of the
    // ping-pong problem, so it is worth calling out rather than leaving to be spotted.
    const seen = {};
    for (const c of clients) (seen[c.mac] = seen[c.mac] || []).push(c.device);
    const dup = Object.entries(seen).filter(([, d]) => d.length > 1);
    if (dup.length) {
        console.log('');
        for (const [mac, devs] of dup) {
            const c = clients.find((x) => x.mac === mac);
            console.log(`  note: ${c.name} (${mac}) is registered on ${devs.length} APs at once — ${devs.join(', ')}; a client mid-roam, not two connections`);
        }
    }
}

async function main() {
    const args = process.argv.slice(2);
    if (args.includes('help') || args.includes('-h') || args.includes('--help')) {
        console.log(
            require('fs')
                .readFileSync(__filename, 'utf8')
                .split('\n')
                .slice(1, 32)
                .join('\n')
                .replace(/^\/\/ ?/gm, '')
        );
        return;
    }
    if (!process.env.ROUTEROS_PASS && DEVICES.some((d) => d.kind === 'mikrotik')) {
        console.error('Error: ROUTEROS_PASS not set (needed for the MikroTik APs).');
        process.exit(1);
    }
    loadKnownDevices(); // fail early and once if devices-known.conf is unreadable

    const settled = await Promise.allSettled(DEVICES.map((d) => (d.kind === 'edimax' ? readEdimax(d) : readMikrotik(d))));
    const results = settled.map((s, i) => (s.status === 'fulfilled' ? s.value : { ...DEVICES[i], error: s.reason.message, radios: [], clients: [] }));

    if (args.includes('json')) console.log(JSON.stringify(results, null, 2));
    else report(results);

    // Exit non-zero if anything was unreachable, so `watch` and scripts can notice.
    if (results.some((r) => r.error)) process.exitCode = 1;
}

if (require.main === module)
    main().catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
    });

module.exports = { readMikrotik, readEdimax, DEVICES };
