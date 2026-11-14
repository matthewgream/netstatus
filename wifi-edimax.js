#!/usr/bin/env node
//
// wifi-edimax.js — show stats for WiFi clients associated to an Edimax Pro access
// point (CAP1200 and relatives), over SNMP.
//
// Counterpart to wifi-mikrotik.js, which reads the RouterOS API. Edimax has no such
// API, but its firmware carries a private MIB with a full station table, which turns
// out to be richer than the standard alternatives:
//
//   * IEEE802dot11-MIB (1.2.840.10036) IS present but only exposes station-config and
//     PHY tables — the AP's own settings, no associations at all.
//   * BRIDGE-MIB dot1dTpFdbTable gives MACs per bridge port, so it identifies which
//     radio a client is on, but nothing else about it. Used here for exactly that.
//   * The Edimax private table (1.3.6.1.4.1.3822.2010.1.<col>.<mac>) has SSID, IP,
//     signal, connected time, security and byte counters. It is indexed by the client
//     MAC written as six decimal octets, so the index has to be decoded back to hex.
//
// The two are joined: the private table for the detail, the bridge table for the radio.
//
// SIGNAL IN dBm comes from the SSH CLI (--rssi), not from SNMP: the station table carries
// only Signal (%). Column 9 of that table is the CLI's "Idle Time" — identified by the two
// agreeing exactly, having first looked like a rate (720 for one client, 24 for another).
//
// TX/RX RATES are not available by any route. Neither the SNMP table nor the CLI reports a
// rate; both give byte counters only. Verified rather than assumed — if rates matter for a
// location, the MikroTik APs have them, see wifi-mikrotik.js.
//
//   Usage:
//     ./wifi-edimax.js [host]            summary table of associated clients
//     ./wifi-edimax.js [host] detail     full per-client dump (every column)
//     ./wifi-edimax.js [host] json       records as JSON (for piping)
//     ./wifi-edimax.js [host] --rssi     also fetch RSSI in dBm over the SSH CLI
//     ./wifi-edimax.js help
//
//   Live view:  watch -n5 './wifi-edimax.js 192.168.0.111'
//
//   Environment:
//     WIFI_HOST          AP address            (default 192.168.0.111)
//     WIFI_COMMUNITY     SNMP community        (default public)
//     WIFI_USER          CLI username          (default admin, --rssi only)
//     WIFI_PASS          CLI password          (required for --rssi)
//     DEVICES_KNOWN      devices-known.conf    (default ../devices/devices-known.conf)
//
// Without --rssi this needs no credentials at all and takes about a second; --rssi costs an
// SSH login (several seconds) and is therefore opt-in rather than the default.
//
// To reach the CLI by hand, the same three legacy options are required:
//   ssh -o KexAlgorithms=+diffie-hellman-group1-sha1 -o HostKeyAlgorithms=+ssh-rsa \
//       -o Ciphers=+aes128-cbc admin@192.168.0.111
//
// A MAC listed in devices-known.conf is named; anything unlisted shows '-', which makes
// an unrecognised client stand out on sight.
//
// NOTE: this reads over SNMPv2c, which is unauthenticated — the same walk works for
// anyone on the LAN. Worth a non-default community, or v3.

const snmp = require('net-snmp');
const { spawn } = require('child_process');
const { loadKnownDevices, nameFor, macLabel } = require('./devices-known.js');

// The firmware's SSH CLI reports RSSI in dBm, which the SNMP station table does not — it has
// only Signal (%). Fetching it is opt-in (--rssi) because it costs a login per run, needs the
// admin password, and the SNMP path deliberately needs no credentials at all.
//
// dropbear 0.51 (c. 2008) refuses every modern algorithm, hence the three '+' options; it also
// refuses to run a command non-interactively (exec fails) and closes immediately unless it gets
// a REAL pty — a piped stdin with -tt is not enough. `script -qc` supplies one, which avoids
// depending on sshpass or a python helper.
const SSH_LEGACY = ['-o', 'KexAlgorithms=+diffie-hellman-group1-sha1', '-o', 'HostKeyAlgorithms=+ssh-rsa', '-o', 'Ciphers=+aes128-cbc'];
const CLI_COMMANDS = ['show status wlan 5g clients', 'show status wlan 2.4g clients'];

function readRssiOverSsh(host, user, pass, timeoutMs = 60000) {
    return new Promise((resolve) => {
        const ssh = ['ssh', '-tt', ...SSH_LEGACY, '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=10', `${user}@${host}`];
        // The password reaches ssh through SSH_ASKPASS, so it is never an argv word (argv is
        // world-readable via /proc) nor written to a file.
        const askpass = `${__dirname}/.askpass-edimax.sh`;
        try {
            require('fs').writeFileSync(askpass, '#!/bin/sh\necho "$EDIMAX_PASS"\n', { mode: 0o700 });
        } catch {
            return resolve({});
        }
        const child = spawn('script', ['-qc', ssh.join(' '), '/dev/null'], {
            env: { ...process.env, EDIMAX_PASS: pass, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force' },
        });
        let out = '';
        const done = (result) => {
            try {
                require('fs').unlinkSync(askpass);
            } catch {
                /* already gone */
            }
            resolve(result);
        };
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            done(parseRssi(out));
        }, timeoutMs);
        child.stdout.on('data', (d) => (out += d.toString()));
        child.stderr.on('data', (d) => (out += d.toString()));
        child.on('close', () => {
            clearTimeout(timer);
            done(parseRssi(out));
        });
        child.on('error', () => {
            clearTimeout(timer);
            done({});
        });
        // Give the login time to complete before the first command, and each command time to
        // print: the CLI has no machine-readable prompt to synchronise on.
        let delay = 3000;
        for (const cmd of CLI_COMMANDS) {
            setTimeout(() => child.stdin.write(cmd + '\n'), delay);
            delay += 3000;
        }
        setTimeout(() => child.stdin.write('exit\n'), delay);
    });
}

// The CLI prints one label/value pair per line, clients separated by a repeating 'Interface'
// label, so pair each MAC with the RSSI that follows it in the same block.
function parseRssi(text) {
    const rssi = {};
    let mac = null;
    for (const line of text.split('\n')) {
        const m = line.match(/MAC Address\s+([0-9A-Fa-f:]{17})/);
        if (m) {
            mac = m[1].toLowerCase();
            continue;
        }
        const r = line.match(/RSSI \(dBm\)\s+(-?\d+)/);
        if (r && mac) {
            rssi[mac] = Number(r[1]);
            mac = null;
        }
    }
    return rssi;
}

// Edimax private station table. Columns established by walking a live CAP1200 (Ver2.3.0);
// there is no published MIB file, so these are empirical. Column 5 reads 2 for every client
// on ra0 and 5 for every client on ath0, i.e. the band in GHz — confirmed against the bridge
// table rather than assumed. Columns 9 and 12 have no consistent meaning yet (9 varies, 12
// reads NULL throughout) so they are carried into detail/json unnamed rather than guessed at.
const STA = '1.3.6.1.4.1.3822.2010.1';
const STA_COL = {
    1: 'mac',
    2: 'ssid',
    3: 'security',
    4: 'cipher',
    5: 'band_ghz',
    6: 'ip',
    7: 'signal_pct',
    8: 'uptime',
    9: 'idle_time',
    10: 'tx',
    11: 'rx',
};

const OID = {
    sysDescr: '1.3.6.1.2.1.1.1',
    sysUpTime: '1.3.6.1.2.1.1.3',
    fdbPort: '1.3.6.1.2.1.17.4.3.1.2', // dot1dTpFdbPort:      .<mac> = bridge port
    basePortIf: '1.3.6.1.2.1.17.1.4.1.2', // dot1dBasePortIfIndex: .<port> = ifIndex
    ifDescr: '1.3.6.1.2.1.2.2.1.2', // ifDescr:              .<ifIndex> = name
    ifPhys: '1.3.6.1.2.1.2.2.1.6', // ifPhysAddress:        .<ifIndex> = MAC (the radio's BSSID)
    radio: '1.3.6.1.4.1.3822.2000.1', // Edimax per-radio config: .<col>.<ifIndex>
};

// Edimax per-radio config table, indexed by the same ifIndex as the interface table. Columns
// are empirical, as with the station table: 4 matches the 5GHz channel the AP is actually on,
// and 10/11 hold the textbook RTS (2347) and fragmentation (2346) thresholds, which is what
// identifies the table. A radio that is administratively DISABLED reports the whole row as
// zeroes — that is how the 2.4GHz radio being switched off shows up here.
const RADIO_COL = { 4: 'channel', 8: 'beacon_interval', 10: 'rts_threshold', 11: 'frag_threshold' };

// SNMP sysUpTime is in hundredths of a second.
function fmtUptime(ticks) {
    if (!ticks) return null;
    const s = Math.floor(Number(ticks) / 100),
        d = Math.floor(s / 86400),
        h = Math.floor((s % 86400) / 3600),
        m = Math.floor((s % 3600) / 60);
    return d ? `${d}d${h}h${m}m` : `${h}h${m}m`;
}

function resolveOpts() {
    const hostArg = process.argv[2];
    // a bare sub-command or flag in argv[2] means "no host given"
    const host = hostArg && !hostArg.startsWith('-') && !['detail', 'json', 'help'].includes(hostArg) ? hostArg : process.env.WIFI_HOST || '192.168.0.111';
    return { host, community: process.env.WIFI_COMMUNITY || 'public', rssi: process.argv.includes('--rssi') };
}

// Walk a subtree, returning {<index-after-base>: value}. Values arrive typed: Buffers for
// OCTET STRING (which is how the MAC column comes back), numbers otherwise.
function walkOid(session, base) {
    return new Promise((resolve, reject) => {
        const out = {};
        session.subtree(
            base,
            20,
            (varbinds) => {
                for (const vb of varbinds) {
                    if (snmp.isVarbindError(vb)) continue;
                    const oid = Array.isArray(vb.oid) ? vb.oid.join('.') : vb.oid.toString();
                    out[oid.slice(base.length + 1)] = vb.value;
                }
            },
            (err) => (err ? reject(err) : resolve(out))
        );
    });
}

// The table index is the MAC as six decimal octets ("152.152.251.21.101.3"), which is
// also how dot1dTpFdbTable indexes itself — so decoding it once joins the two tables.
function indexToMac(index) {
    const parts = index.split('.');
    if (parts.length !== 6) return null;
    return parts.map((n) => Number(n).toString(16).padStart(2, '0')).join(':');
}

function valueToString(v) {
    if (v == null) return '';
    if (Buffer.isBuffer(v)) return v.toString('latin1').replace(/\0+$/, '');
    return String(v);
}

// readClients(opts) -> {host, sysDescr, uptime, clients: [{mac, name, radio, ssid, ...}], known, radios}
//
// Options are explicit rather than taken from argv: this is the entry point wifi-status.js
// uses, and a caller's own command line must not decide whether an SSH login happens here.
// resolveOpts() below stays CLI-only and is passed IN by main().
async function readClients(opts = {}) {
    const o = {
        host: process.env.WIFI_HOST || '192.168.0.111',
        community: process.env.WIFI_COMMUNITY || 'public',
        user: process.env.WIFI_USER || 'admin',
        pass: process.env.WIFI_PASS || process.env.EDIMAX_PASS || '',
        rssi: false,
        ...opts,
    };
    const session = snmp.createSession(o.host, o.community, { timeout: 5000, version: snmp.Version2c });
    try {
        const [sys, upTime, sta, fdb, portIf, ifName, radioCfg, ifPhys] = await Promise.all([
            walkOid(session, OID.sysDescr),
            walkOid(session, OID.sysUpTime).catch(() => ({})),
            walkOid(session, STA),
            walkOid(session, OID.fdbPort).catch(() => ({})),
            walkOid(session, OID.basePortIf).catch(() => ({})),
            walkOid(session, OID.ifDescr).catch(() => ({})),
            walkOid(session, OID.radio).catch(() => ({})),
            walkOid(session, OID.ifPhys).catch(() => ({})),
        ]);

        // bridge port -> interface name, so a client's MAC can be attributed to a radio.
        // The wired uplink appears here too and is left in: naming it is more useful than
        // guessing which port is "the" uplink, and a wired MAC never reaches this table.
        const portName = {};
        for (const [port, idx] of Object.entries(portIf)) portName[port] = valueToString(ifName[String(idx)]) || `ifIndex ${idx}`;

        const macRadio = {};
        for (const [index, port] of Object.entries(fdb)) {
            const mac = indexToMac(index);
            if (mac) macRadio[mac] = portName[String(port)] || `port ${port}`;
        }

        // Rows arrive column-major (<col>.<mac>); pivot to one record per client.
        const byMac = {};
        for (const [key, value] of Object.entries(sta)) {
            const dot = key.indexOf('.');
            if (dot < 0) continue;
            const col = key.slice(0, dot);
            const mac = indexToMac(key.slice(dot + 1));
            if (!mac) continue;
            const rec = (byMac[mac] = byMac[mac] || { mac });
            const name = STA_COL[col];
            if (name === 'mac') continue; // the index already carries it, and more reliably
            if (name) rec[name] = valueToString(value);
            else rec[`col${col}`] = valueToString(value); // unidentified column, carried not dropped
        }

        const known = loadKnownDevices();
        let rssi = {};
        if (o.rssi) {
            if (!o.pass) console.error('note: --rssi needs the admin password in WIFI_PASS; continuing without dBm');
            else rssi = await readRssiOverSsh(o.host, o.user, o.pass);
        }
        const clients = Object.values(byMac)
            .map((c) => ({ ...c, name: nameFor(c.mac, known), radio: macRadio[c.mac] || '-', ...(rssi[c.mac] != null ? { rssi_dbm: rssi[c.mac] } : {}) }))
            .sort((a, b) => (a.name === b.name ? a.mac.localeCompare(b.mac) : a.name.localeCompare(b.name)));

        // Per-radio config, keyed by the interface name so it lines up with what the clients
        // report as their radio. An all-zero row means the radio is administratively disabled.
        const radios = [];
        for (const [ifIndex, name] of Object.entries(ifName)) {
            const cols = {};
            for (const [col, field] of Object.entries(RADIO_COL)) {
                const v = radioCfg[`${col}.${ifIndex}`];
                if (v != null) cols[field] = Number(v);
            }
            if (!Object.keys(cols).length) continue;
            const nm = valueToString(name);
            if (!/^(ra|ath|wlan)/.test(nm)) continue; // radios only, not eth/bridge/wds
            // ifPhysAddress is the radio's own MAC, i.e. the BSSID a survey tool shows for it —
            // which is how a walk-test reading gets matched back to a specific radio.
            const raw = ifPhys[ifIndex];
            const mac = Buffer.isBuffer(raw) && raw.length === 6 ? [...raw].map((b) => b.toString(16).padStart(2, '0')).join(':') : null;
            radios.push({ name: nm, mac, band_ghz: nm.startsWith('ra') ? 2.4 : 5, disabled: !cols.channel, ...cols });
        }

        return { host: o.host, sysDescr: valueToString(sys['0']), uptime: fmtUptime(upTime['0']), clients, known, radios };
    } finally {
        session.close();
    }
}

function printHeader({ host, sysDescr, uptime, clients, radios }) {
    console.log(`WiFi clients @ ${host}   (${[sysDescr || 'Edimax', uptime ? `up ${uptime}` : null].filter(Boolean).join(' · ')})`);
    const macw = Math.max(...(radios || []).map((r) => (r.mac || '').length), 4);
    for (const r of radios || []) {
        const label = `${r.name} (${r.band_ghz}GHz)`.padEnd(16) + (r.mac || '-').padEnd(macw) + '  ';
        if (r.disabled) {
            // Worth stating outright rather than showing a blank row: a disabled radio is the
            // reason a band's client list is empty, and is easy to leave switched off by mistake.
            console.log(`  ${label} radio DISABLED`);
            continue;
        }
        const n = clients.filter((c) => c.radio === r.name).length;
        const bits = [`ch ${r.channel}`, r.beacon_interval ? `beacon ${r.beacon_interval}ms` : null, `${n} client${n === 1 ? '' : 's'}`].filter(Boolean);
        console.log(`  ${label} ${bits.join('  ')}`);
    }
    console.log('');
}

function printSummary({ clients }) {
    if (!clients.length) return console.log('  (no associated clients)');
    const withRssi = clients.some((c) => c.rssi_dbm != null);
    const head = ['Name', 'MAC', 'Radio', 'SSID', 'Signal', ...(withRssi ? ['RSSI'] : []), 'IP', 'Uptime', 'Tx', 'Rx'];
    const rows = [head];
    for (const c of clients)
        rows.push([
            c.name,
            c.mac,
            // ra0 is the 2.4GHz radio and ath0 the 5GHz one, but that is only obvious to
            // someone who already knows the box, so show the band the AP itself reports.
            c.band_ghz ? `${c.radio} (${c.band_ghz === '2' ? '2.4' : c.band_ghz}GHz)` : c.radio,
            c.ssid || '-',
            c.signal_pct != null ? `${c.signal_pct}%` : '-',
            ...(withRssi ? [c.rssi_dbm != null ? `${c.rssi_dbm}dBm` : '-'] : []),
            c.ip || '-',
            c.uptime || '-',
            c.tx || '-',
            c.rx || '-',
        ]);
    const w = head.map((_, col) => Math.max(...rows.map((r) => String(r[col]).length)));
    for (const r of rows) console.log(r.map((cell, col) => String(cell).padEnd(w[col])).join('  '));
    console.log(`\n${clients.length} client(s).  Run with "detail" for every field, or "json" to pipe.`);
}

function printDetail({ clients, known }) {
    if (!clients.length) return console.log('  (no associated clients)');
    for (const c of clients) {
        const title = macLabel(c.mac, known);
        console.log(`── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
        const keys = Object.keys(c).sort();
        const kw = Math.max(...keys.map((k) => k.length));
        for (const k of keys) console.log(`  ${k.padEnd(kw)}  ${c[k]}`);
        console.log('');
    }
    console.log(`${clients.length} client(s).`);
}

async function main() {
    const args = process.argv.slice(2);
    if (args.includes('help') || args.includes('-h') || args.includes('--help')) {
        console.log(
            require('fs')
                .readFileSync(__filename, 'utf8')
                .split('\n')
                .slice(1, 38)
                .join('\n')
                .replace(/^\/\/ ?/gm, '')
        );
        return;
    }
    const mode = args.includes('detail') || args.includes('-d') ? 'detail' : args.includes('json') ? 'json' : 'summary';
    const result = await readClients(resolveOpts());
    if (mode === 'json') console.log(JSON.stringify({ host: result.host, sysDescr: result.sysDescr, clients: result.clients }, null, 2));
    else {
        printHeader(result);
        if (mode === 'detail') printDetail(result);
        else printSummary(result);
    }
}

if (require.main === module)
    main().catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
    });

module.exports = { readClients, fmtUptime, indexToMac };
