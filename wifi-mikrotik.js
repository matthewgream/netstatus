#!/usr/bin/env node
//
// wifi-clients.js — show detailed stats for WiFi clients associated to a
// MikroTik AP, over the RouterOS API (port 8728).
//
// Built for the WifiWave2 stack (`/interface/wifi`, e.g. the WiFi-7 hAP be lite
// at 192.168.0.44), but falls back to the older `/interface/wifiwave2` path and
// the legacy `/interface/wireless` stack automatically, so it also works on the
// ac/n boxes (OmniTik 5HacD, RB911G-2HPnD).
//
// The RouterOS API is the richest source for this: SNMP does not expose the
// wave2 registration table well, and /interface/wifi/print over the API returns
// EVERY property the firmware knows about each client (signal, per-stream rates,
// MLO links, CCQ, byte/packet counters), unlike the CLI which hides most of them.
//
// Reuses the exported RouterOS API client from poe-mikrotik.js — same login
// (post-6.43 plaintext, MD5-challenge fallback) and framing. Credentials come
// from the environment or CLI, never hardcoded.
//
//   Usage:
//     ./wifi-clients.js [host]            summary table of associated clients
//     ./wifi-clients.js [host] detail     full per-client dump (every field)
//     ./wifi-clients.js [host] json       raw records as JSON (for piping)
//     ./wifi-clients.js help
//
//   Live view:  watch -n2 './wifi-clients.js 192.168.0.44'
//
//   Environment:
//     WIFI_HOST          AP address            (default 192.168.0.44)
//     ROUTEROS_USER      API username          (default admin)
//     ROUTEROS_PASS      API password          (required)
//     ROUTEROS_API_PORT  RouterOS API port     (default 8728)
//     DEVICES_KNOWN      devices-known.conf    (default ../devices/devices-known.conf)
//
// A MAC listed in devices-known.conf is shown as "name (mac)"; anything unlisted
// keeps its bare MAC, which makes an unrecognised client stand out on sight.
//
// The API user only needs `api` + `read` policy to read the registration table.

const { RouterOS } = require('./poe-mikrotik.js');
const { loadKnownDevices, nameFor, macLabel } = require('./devices-known.js');

// Registration-table paths to try, richest/newest first. The first one that the
// router accepts (doesn't answer !trap "no such command") wins.
const REG_PATHS = [
    '/interface/wifi/registration-table/print', // ROS 7.13+ WifiWave2
    '/interface/wifiwave2/registration-table/print', // older WifiWave2 naming
    '/interface/wireless/registration-table/print', // legacy ac/n stack
];

function resolveOpts() {
    const hostArg = process.argv[2];
    // treat a bare sub-command in argv[2] as "no host given"
    const host = hostArg && !['detail', 'json', 'help', '-h', '--help', '-d'].includes(hostArg) ? hostArg : process.env.WIFI_HOST || '192.168.0.44';
    return {
        host,
        port: parseInt(process.env.ROUTEROS_API_PORT || '8728', 10),
        user: process.env.ROUTEROS_USER || 'admin',
        pass: process.env.ROUTEROS_PASS || '',
    };
}

// Turn a RouterOS API sentence (['!re','=mac-address=..','=signal=-52',...])
// into a plain {key: value} object. Words are `=key=value`; the value itself may
// contain '=', so split on the FIRST '=' after the leading one.
function sentenceToObj(s) {
    const o = {};
    for (const w of s) {
        if (w[0] !== '=') continue;
        const eq = w.indexOf('=', 1);
        if (eq < 0) continue;
        o[w.slice(1, eq)] = w.slice(eq + 1);
    }
    return o;
}

// Return the first present value among candidate keys ('' counts as present).
function pick(o, ...keys) {
    for (const k of keys) if (o[k] !== undefined) return o[k];
    return undefined;
}

// bytes/packets counters arrive as "rx,tx". Split into a labelled pair.
function splitPair(v) {
    if (v == null) return [null, null];
    const [a, b] = String(v).split(',');
    return [a ?? null, b ?? null];
}

function fmtBytes(b) {
    if (b == null || b === '') return '-';
    const n = Number(b);
    if (!Number.isFinite(n)) return String(b);
    if (n === 0) return '0B';
    const k = 1024,
        sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(n) / Math.log(k));
    return parseFloat((n / Math.pow(k, i)).toFixed(2)) + sizes[i];
}

// Rates come back either as a raw bit/s integer (wave2) or an already-formatted
// string like "866.7Mbps-80MHz/2S/..." (legacy). Normalise integers to Mbps.
function fmtRate(v) {
    if (v == null || v === '') return '-';
    if (/^\d+$/.test(String(v))) {
        const mbps = Number(v) / 1e6;
        return mbps >= 1 ? `${mbps.toFixed(1)}Mbps` : `${(Number(v) / 1e3).toFixed(0)}Kbps`;
    }
    return String(v); // firmware already formatted it
}

function fmtSignal(v) {
    if (v == null || v === '') return '-';
    // wave2 sometimes reports "signal@rate" or a plain dBm; keep the dBm head.
    const head = String(v).split(/[@\s]/)[0];
    return /dbm/i.test(head) ? head : `${head}dBm`;
}

async function fetchClients(api) {
    let lastErr, firstOk;
    for (const path of REG_PATHS) {
        try {
            const reply = await api.talk([path]);
            const clients = reply.filter((s) => s[0] === '!re').map(sentenceToObj);
            // A path can EXIST and be empty while the box actually runs a different stack: ROS 7
            // still ships the legacy `wireless` driver for radios with no wave2 support (e.g. an
            // OmniTIK 5 ac with no qcom-ac package), and there /interface/wifi/... answers happily
            // with zero rows. Taking that as "no clients" would silently under-report a working AP,
            // so keep looking and prefer whichever path actually has clients.
            if (clients.length) return { path, clients };
            if (!firstOk) firstOk = { path, clients };
        } catch (e) {
            lastErr = e; // "no such command" on a box without this stack -> try next
        }
    }
    // Every path was empty: legitimately no clients. Report against the first that answered.
    if (firstOk) return firstOk;
    throw lastErr || new Error('no registration-table path accepted');
}

// --- radio / system context ------------------------------------------------
// The client table says who is connected but nothing about the radio they are on, which is
// what you actually need when a client's signal is poor or a 2.4GHz device will not associate:
// the channel (and whether it collides with something else nearby), the width, and on the
// legacy stack the noise floor and CCQ.

// RouterOS reports the operating channel as a compact string, in two dialects:
//   WifiWave2  "2462/be/eC"            freq / protocol / 20MHz-subchannel map
//              "5320/be/eeeeeeeC/DI"   ...with DFS/indoor flags appended
//   legacy     "2412/20-Ce/gn(20dBm)"  freq / width-submap / protocols(txpower)
// In both, the subchannel map has one character per 20MHz slice ('C' marks the control
// channel), so its length gives the width without having to parse the width field itself.
function parseChannel(s) {
    if (!s) return {};
    const freq = Number((s.match(/^(\d+)/) || [])[1]);
    const map = (s.match(/[/-]([CcEe]+)(?:[/(]|$)/) || [])[1];
    const legacyWidth = Number((s.match(/^\d+\/(\d+)/) || [])[1]);
    const proto = (s.match(/\/([a-z]+)(?:\(|\/|$)/) || [])[1];
    const txPower = Number((s.match(/\((\d+)dBm\)/) || [])[1]);
    // 2.4GHz: channel 1 is 2412 and they step 5MHz (14 is the exception, unused here).
    // 5/6GHz: a plain (freq-5000)/5.
    let channel;
    if (freq >= 2412 && freq <= 2484) channel = freq === 2484 ? 14 : (freq - 2407) / 5;
    else if (freq >= 5000) channel = (freq - 5000) / 5;
    // No subchannel map and no explicit width means a plain single channel: wave2 prints
    // "2437/be" for 20MHz but "2462/be/eC" for 40MHz, so absence of the map IS the signal.
    const width = map ? map.length * 20 : Number.isFinite(legacyWidth) ? legacyWidth : 20;
    return { freq, channel, width, proto, txPower };
}

// Returns [] rather than throwing: the radio detail is a nicety on top of the client list,
// and a box that does not answer these paths should still print its clients.
async function fetchRadios(api) {
    for (const [printPath, monitorPath] of [
        ['/interface/wifi/print', '/interface/wifi/monitor'],
        ['/interface/wifiwave2/print', '/interface/wifiwave2/monitor'],
        ['/interface/wireless/print', '/interface/wireless/monitor'],
    ]) {
        let ifaces;
        try {
            ifaces = (await api.talk([printPath])).filter((s) => s[0] === '!re').map(sentenceToObj);
        } catch {
            continue; // wrong stack for this box
        }
        if (!ifaces.length) continue;
        const radios = [];
        for (const i of ifaces) {
            const name = pick(i, 'name');
            const mac = pick(i, 'mac-address');
            // A slave interface (master=false) is an extra SSID/MLD bound to a radio. It reports
            // the master's channel and the COMBINED peer count, so its channel and counts are not
            // its own — but it does broadcast its own BSSID, which a survey tool will show as a
            // separate network. List it for the BSSID alone, without the radio figures.
            if (pick(i, 'master') === 'false') {
                radios.push({
                    name,
                    mac,
                    slave: true,
                    master: pick(i, 'master-interface') || null,
                    ssid: pick(i, 'ssid') || pick(i, 'configuration.ssid') || null,
                });
                continue;
            }
            if (pick(i, 'disabled') === 'true') {
                radios.push({ name, mac, disabled: true });
                continue;
            }
            let m = {};
            try {
                m = sentenceToObj(((await api.talk([monitorPath, `=numbers=${name}`, '=once='])).filter((s) => s[0] === '!re') || [])[0] || []);
            } catch {
                /* not monitorable (slave interface) */
            }
            const chan = pick(m, 'channel');
            if (!chan) continue;
            radios.push({
                name,
                mac,
                ...parseChannel(chan),
                txPower: Number(pick(m, 'tx-power')) || parseChannel(chan).txPower,
                peers: pick(m, 'registered-peers') || pick(m, 'registered-clients'),
                noise: pick(m, 'noise-floor'),
                ccq: pick(m, 'overall-tx-ccq'),
                ssid: pick(i, 'ssid') || pick(i, 'configuration.ssid'),
            });
        }
        if (radios.length) return { stack: printPath.replace('/print', ''), radios };
    }
    return { stack: null, radios: [] };
}

async function fetchSystem(api) {
    try {
        const r = sentenceToObj(((await api.talk(['/system/resource/print'])).filter((s) => s[0] === '!re') || [])[0] || []);
        return { board: pick(r, 'board-name'), version: pick(r, 'version'), uptime: pick(r, 'uptime') };
    } catch {
        return {};
    }
}

function printHeader(host, path, sys, radios, stack) {
    // Prefer the stack the RADIO is on over the registration-table path: on a box whose wave2
    // menus exist but are unused (ROS 7 + legacy `wireless` driver), an empty /interface/wifi
    // table answers first and would otherwise be reported as the box's stack, which it is not.
    const bits = [sys.board, sys.version ? `RouterOS ${sys.version.replace(/ \(.*\)/, '')}` : null, sys.uptime ? `up ${sys.uptime}` : null, stack || path.replace('/print', '')].filter(Boolean);
    console.log(`WiFi clients @ ${host}   (${bits.join(' · ')})`);
    // BSSID column: this is what a survey tool (NetSpot, WiFiman, wifi analysers) shows instead
    // of a friendly name, so printing it here is what lets a walk-test reading be matched back to
    // a specific radio on a specific AP.
    const macw = Math.max(...radios.map((r) => (r.mac || '').length), 4);
    for (const r of radios) {
        if (r.disabled) {
            console.log(`  ${r.name.padEnd(24)} ${(r.mac || '-').padEnd(macw)}  radio DISABLED`);
            continue;
        }
        if (r.slave) {
            console.log(`  ${r.name.padEnd(24)} ${(r.mac || '-').padEnd(macw)}  (additional BSSID on a shared radio)`);
            continue;
        }
        const parts = [
            r.channel != null ? `ch ${r.channel} (${r.freq}MHz)` : null,
            r.width ? `${r.width}MHz` : null,
            r.proto || null,
            r.txPower ? `${r.txPower}dBm` : null,
            r.noise ? `noise ${r.noise}dBm` : null,
            r.ccq ? `ccq ${r.ccq}%` : null,
            r.peers != null ? `${r.peers} peers` : null,
        ].filter(Boolean);
        console.log(`  ${r.name.padEnd(24)} ${(r.mac || '-').padEnd(macw)}  ${parts.join('  ')}`);
    }
    console.log('');
}

function printSummary(clients, known) {
    if (!clients.length) {
        console.log('  (no associated clients)');
        return;
    }
    // Name and MAC as separate columns rather than "name (mac)" in one: the names run to 35+
    // characters, and combining them pushed every other column far enough right to be hard to
    // scan. An unmatched client shows '-' here and is spotted by that.
    const head = ['Name', 'MAC', 'Iface', 'SSID', 'Signal', 'TX-Rate', 'RX-Rate', 'Uptime', 'RX-Bytes', 'TX-Bytes'];
    const rows = [head];
    for (const c of clients) {
        const [rxB, txB] = splitPair(pick(c, 'bytes'));
        const mac = pick(c, 'mac-address');
        rows.push([
            nameFor(mac, known),
            mac || '-',
            pick(c, 'interface') || '-',
            (pick(c, 'ssid') ?? '-') || '(hidden)',
            fmtSignal(pick(c, 'signal', 'signal-strength', 'rx-signal')),
            fmtRate(pick(c, 'tx-rate')),
            fmtRate(pick(c, 'rx-rate')),
            pick(c, 'uptime') || '-',
            fmtBytes(rxB),
            fmtBytes(txB),
        ]);
    }
    const w = head.map((_, col) => Math.max(...rows.map((r) => String(r[col]).length)));
    for (const r of rows) console.log(r.map((cell, col) => String(cell).padEnd(w[col])).join('  '));
    console.log(`\n${clients.length} client(s).  Run with "detail" for every field, or "json" to pipe.`);
}

function printDetail(clients, known) {
    if (!clients.length) return console.log('  (no associated clients)');
    clients.forEach((c, i) => {
        const mac = pick(c, 'mac-address');
        const title = mac ? macLabel(mac, known) : `client ${i + 1}`;
        console.log(`── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
        const keys = Object.keys(c).sort();
        const kw = Math.max(...keys.map((k) => k.length));
        for (const k of keys) console.log(`  ${k.padEnd(kw)}  ${c[k]}`);
        console.log('');
    });
    console.log(`${clients.length} client(s).`);
}

// readClients(opts) -> {host, path, stack, sys, radios, clients, known}
//
// The single entry point for a consumer (wifi-status.js aggregates several APs with it).
// Options are explicit rather than read from argv here: a caller's own command line must not
// change what this does, which is why resolveOpts() below stays CLI-only and is passed IN.
//
// Everything is fetched sequentially, NOT with Promise.all: the RouterOS client is a minimal
// one that does not multiplex tagged commands, so two in flight on the same connection race
// and one silently loses its reply. Different hosts are independent connections and safe to
// run concurrently — that is where a caller should parallelise.
async function readClients(opts = {}) {
    const o = {
        host: process.env.WIFI_HOST || '192.168.0.44',
        port: parseInt(process.env.ROUTEROS_API_PORT || '8728', 10),
        user: process.env.ROUTEROS_USER || 'admin',
        pass: process.env.ROUTEROS_PASS || '',
        ...opts,
    };
    if (!o.pass) throw new Error('no API password (set ROUTEROS_PASS)');
    const api = new RouterOS(o.host, o.port, o.user, o.pass);
    await api.connect();
    try {
        await api.login();
        const { path, clients } = await fetchClients(api);
        const sys = await fetchSystem(api);
        const { stack, radios } = await fetchRadios(api);
        return { host: o.host, path, stack, sys, radios, clients, known: loadKnownDevices() };
    } finally {
        api.close();
    }
}

async function main() {
    const args = process.argv.slice(2);
    if (args.includes('help') || args.includes('-h') || args.includes('--help')) {
        console.log(
            require('fs')
                .readFileSync(__filename, 'utf8')
                .split('\n')
                .slice(1, 40)
                .join('\n')
                .replace(/^\/\/ ?/gm, '')
        );
        return;
    }
    const mode = args.includes('detail') || args.includes('-d') ? 'detail' : args.includes('json') ? 'json' : 'summary';

    const o = resolveOpts();
    if (!o.pass) {
        console.error('Error: no API password. Set ROUTEROS_PASS (and optionally ROUTEROS_USER, default "admin").');
        console.error('  e.g.  ROUTEROS_PASS=... ./wifi-mikrotik.js 192.168.0.44');
        process.exit(1);
    }

    const { path, stack, sys, radios, clients, known } = await readClients(o);
    if (mode === 'json') {
        // Added as a separate key rather than merged into the record, so what came from
        // RouterOS stays distinguishable from what was looked up locally.
        const withNames = clients.map((c) => {
            const name = known.get((pick(c, 'mac-address') || '').toLowerCase());
            return name ? { ...c, 'known-name': name } : c;
        });
        console.log(JSON.stringify({ host: o.host, path, clients: withNames }, null, 2));
        return;
    }
    // The radio/system context is printed for both views: knowing the channel and width is as
    // relevant when reading one client's detail as when scanning the whole table.
    printHeader(o.host, path, sys, radios, stack);
    if (mode === 'detail') printDetail(clients, known);
    else printSummary(clients, known);
}

// Guarded so this file can also be require()d for its helpers (wifi-channel.js reuses the
// channel-string parser) without running the CLI as a side effect.
if (require.main === module)
    main().catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
    });

module.exports = { readClients, parseChannel, fetchClients, fetchRadios, fetchSystem, sentenceToObj, pick, fmtSignal, fmtRate, fmtBytes, splitPair };
