#!/usr/bin/env node
//
// port-status.js — one view of every switch and router port on the network: link, speed,
// PoE and traffic, across all the MikroTiks, in a single table.
//
// Replaces poe-status.sh, which ran poe-mikrotik.js once per device and left you reading a
// header, a table with its own column widths and a "Total PoE draw" line per device, even
// under the ones that cannot supply PoE at all. The useful questions cut across devices —
// what is the estate drawing, which links came up at less than gigabit, which box is behind
// on RouterOS — and they are easier to answer from one table than from eight.
//
// So the port table is ONE table with a Device column. Unlike wifi-status.js it stays in
// device order rather than being sorted by name: a port is a socket on a particular box, and
// the devices are listed roughly as the cabling runs, from the router outwards.
//
//   Usage:
//     ./port-status.js              every port on every configured device
//     ./port-status.js up           only ports with the link up
//     ./port-status.js poe          only PoE-capable ports
//     ./port-status.js sw8p4s       only the named device(s), by label or host
//     ./port-status.js json         the same data as JSON, for piping
//     ./port-status.js help
//
//   The filters combine: ./port-status.js poe up omnitik
//
//   Live view:  watch -n5 ./port-status.js up
//
//   Environment:
//     POE_COMMUNITY   SNMP community (default public)
//
// Everything is read over SNMP, so no credentials are needed and the SwOS switches (CSS318,
// GPEN21) report alongside the RouterOS ones. Devices are read concurrently; one that is
// unreachable is reported in place and the rest still print.

const fs = require('fs');
const snmp = require('net-snmp');
const poe = require('./poe-mikrotik.js');

// The devices to poll, in cabling order. `label` is what appears in the Device column and
// matches wifi-status.js where a device is in both; the full host is shown once in the
// Devices table.
const DEVICES = [
    { host: 'mh-rb960pgs', label: 'rbpro' },
    { host: 'uh-sw16g2s', label: 'sw16g2s' },
    { host: 'uh-sw8p4s', label: 'sw8p4s' },
    { host: 'uh-hapbelite', label: 'hapbelite' },
    // { host: 'mh-gpen21', label: 'gpen21' },
    { host: 'st-rb911g-2hpnd', label: 'rb911g' },
    { host: 'st-rbomnitikpg-5hacd', label: 'omnitik' },
    { host: 'wh-rb750r2', label: 'rb750r2' }, // the washhouse hEX lite, what poe-bastu.sh read
];

const SYS = {
    descr: '1.3.6.1.2.1.1.1.0', // sysDescr — "RouterOS <board> <version>", or "<board> SwOS v<version>"
    uptime: '1.3.6.1.2.1.1.3.0', // sysUpTime, hundredths of a second
    version: '1.3.6.1.4.1.14988.1.1.4.4.0', // mtxrLicVersion — the RouterOS version
    firmware: '1.3.6.1.4.1.14988.1.1.7.4.0', // mtxrFirmwareVersion — RouterBOOT, the bootloader (SwOS: its own version)
    upgrade: '1.3.6.1.4.1.14988.1.1.7.7.0', // mtxrFirmwareUpgradeVersion — the RouterBOOT the installed RouterOS carries
    board: '1.3.6.1.4.1.14988.1.1.7.9.0', // mtxrBoardName — RouterOS 7 only; 6.x has it in sysDescr
};
// mtxrGaugeTable, .<col>.<row>: 2 name, 3 value, 4 unit. RouterOS lists whatever sensors the
// board has (voltage, psuN-voltage, temperature, cpu-temperature); SwOS has none.
const GAUGES = '1.3.6.1.4.1.14988.1.1.3.100.1';
const GAUGE_CELSIUS = 1;
const GAUGE_DV = 3; // deci-volts

// As in wifi-status.js: the loser of the race must be cleared, or the pending timer keeps the
// process alive after the report has printed.
function withTimeout(p, ms, what) {
    let timer;
    const limit = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: timed out after ${ms / 1000}s`)), ms);
    });
    return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------- collection

function snmpGet(session, oids) {
    return new Promise((resolve, reject) => session.get(oids, (err, varbinds) => (err ? reject(err) : resolve(varbinds.map((vb) => (snmp.isVarbindError(vb) ? null : vb.value))))));
}

async function readSystem(host) {
    const session = snmp.createSession(host, process.env.POE_COMMUNITY || 'public', { timeout: 5000, version: snmp.Version2c });
    try {
        const keys = Object.keys(SYS);
        const [values, g] = await Promise.all([snmpGet(session, Object.values(SYS)), poe.walkOid(session, GAUGES)]);
        const v = Object.fromEntries(keys.map((k, i) => [k, values[i] == null ? null : Buffer.isBuffer(values[i]) ? values[i].toString() : values[i]]));

        const rows = {};
        for (const [oid, val] of Object.entries(g)) {
            const [col, row] = oid.split('.');
            const r = (rows[row] = rows[row] || {});
            if (col === '2') r.name = val.toString();
            if (col === '3') r.value = Number(val);
            if (col === '4') r.unit = Number(val);
        }
        const gauges = Object.values(rows);

        const descr = v.descr || '';
        const swos = descr.match(/^(.*) SwOS v?(\S+)/);
        return {
            os: swos ? 'SwOS' : 'RouterOS',
            board: swos ? swos[1] : v.board || descr.replace(/^RouterOS /, '').split(' ')[0] || null,
            version: swos ? `SwOS ${swos[2]}` : v.version,
            // On SwOS the "firmware" is the SwOS version again, already in the Version column.
            firmware: swos ? null : v.firmware,
            firmwareUpgrade: swos ? null : v.upgrade,
            uptime: v.uptime,
            volts: gauges.filter((x) => x.unit === GAUGE_DV).map((x) => ({ name: x.name, volts: x.value / 10 })),
            tempC: gauges.filter((x) => x.unit === GAUGE_CELSIUS).reduce((max, x) => (max == null || x.value > max ? x.value : max), null),
        };
    } finally {
        session.close();
    }
}

async function readDevice(dev) {
    const [sys, st] = await withTimeout(Promise.all([readSystem(dev.host), poe.readStatus({ host: dev.host })]), 30000, dev.label);
    const poePorts = st.ports.filter((p) => p.poe);
    return {
        ...dev,
        ...sys,
        portsUp: st.ports.filter((p) => p.link === 'up').length,
        poePorts: poePorts.length,
        poePowered: poePorts.filter((p) => p.powered).length,
        poeW: st.totalPowerW,
        ports: st.ports.map((p) => ({ device: dev.label, ...p })),
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

function fmtBytes(b) {
    if (b == null) return null;
    if (!b) return '0B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(b) / Math.log(1024));
    return parseFloat((b / Math.pow(1024, i)).toFixed(2)) + sizes[i];
}

const fmtSpeed = (mbps) => (mbps == null ? null : mbps >= 1000 ? `${mbps / 1000}G` : `${mbps}M`);

// Same compact form RouterOS and wifi-status.js use: 5d21h28m51s.
function fmtUptime(ticks) {
    if (ticks == null) return null;
    const t = Math.floor(ticks / 100),
        d = Math.floor(t / 86400),
        h = Math.floor((t % 86400) / 3600),
        m = Math.floor((t % 3600) / 60);
    return (d ? `${d}d` : '') + (d || h ? `${h}h` : '') + (d || h || m ? `${m}m` : '') + `${t % 60}s`;
}

// One supply reads as "24.2V"; a board with several (the CRS112's two PSU inputs) names each,
// because which input is live is the point.
function fmtVolts(volts) {
    if (!volts || !volts.length) return null;
    if (volts.length === 1) return `${volts[0].volts.toFixed(1)}V`;
    return volts.map((x) => `${x.name.replace(/-?voltage$/, '')} ${x.volts.toFixed(1)}V`).join(', ');
}

// RouterOS can only say what the latest release is by asking MikroTik, so the yardstick is the
// estate itself: a device behind the newest RouterOS of its own major version (6.x against
// 6.x, 7.x against 7.x) among the devices read is due a bump, so naming one device on the
// command line leaves it nothing to compare with. SwOS is left out: its versions belong to
// each product line, so a CSS318 and a GPEN21 are not comparable.
//
// RouterBOOT, the bootloader in the board's own flash, needs no yardstick: each RouterOS
// release carries a RouterBOOT image, and the board reports both. Installing RouterOS does not
// flash it (unless /system routerboard settings auto-upgrade=yes), so it trails until someone
// runs /system routerboard upgrade and reboots.
const routerbootBehind = (r) => r.firmware && r.firmwareUpgrade && r.firmware !== r.firmwareUpgrade;
function cmpVersion(a, b) {
    const x = a.split('.').map((n) => parseInt(n, 10) || 0),
        y = b.split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
    return 0;
}

function routerosNewest(ok) {
    const newest = {};
    for (const r of ok) {
        if (r.os !== 'RouterOS' || !r.version) continue;
        const major = r.version.split('.')[0];
        if (!newest[major] || cmpVersion(r.version, newest[major].version) > 0) newest[major] = r;
    }
    // -> the device with the newer release, or null when r is level with the newest
    return (r) => {
        const n = r.os === 'RouterOS' && r.version && newest[r.version.split('.')[0]];
        return n && cmpVersion(r.version, n.version) < 0 ? n : null;
    };
}

function report(results, filter) {
    const ok = results.filter((r) => !r.error);
    const ports = ok.flatMap((r) => r.ports);
    const up = ports.filter((p) => p.link === 'up').length;
    const poeW = Math.round(ok.reduce((sum, r) => sum + r.poeW, 0) * 10) / 10;
    const powered = ok.reduce((sum, r) => sum + r.poePowered, 0);
    const aheadOf = routerosNewest(ok);

    console.log(`Port status  ·  ${ok.length}/${results.length} devices  ·  ${up}/${ports.length} ports up  ·  PoE ${poeW}W on ${powered} ports\n`);

    console.log('Devices');
    table(
        ['Device', 'Host', 'Board', 'Version', 'RouterBOOT', 'Uptime', 'Supply', 'Temp', 'Ports up', 'PoE', 'Powered'],
        results.map((r) =>
            r.error
                ? [r.label, r.host, `UNREACHABLE — ${r.error}`, '', '', '', '', '', '', '', '']
                : [
                      r.label,
                      r.host,
                      r.board,
                      aheadOf(r) ? `${r.version} → ${aheadOf(r).version}` : r.version,
                      routerbootBehind(r) ? `${r.firmware} → ${r.firmwareUpgrade}` : r.firmware,
                      fmtUptime(r.uptime),
                      fmtVolts(r.volts),
                      r.tempC != null ? `${r.tempC}°C` : null,
                      `${r.portsUp}/${r.ports.length}`,
                      r.poePorts ? `${r.poeW.toFixed(1)}W` : null,
                      r.poePorts ? `${r.poePowered}/${r.poePorts}` : null,
                  ]
        )
    );

    const shown = ports.filter((p) => (!filter.up || p.link === 'up') && (!filter.poe || p.poe));
    const which = [filter.up && 'link up', filter.poe && 'PoE-capable'].filter(Boolean).join(', ');
    console.log(`\nPorts${which ? ` (${which} only)` : ''}`);
    if (!shown.length) console.log('  (none)');
    table(
        ['Device', 'Idx', 'Port', 'Link', 'Speed', 'PoE', 'Volt', 'Curr', 'Power', 'From-dev', 'To-dev', 'Comment'],
        shown.map((p) => {
            // A port that is not powering reads 0.0V/0mA/0.0W; dashes say the same thing
            // without three columns of zeros to read past.
            const live = p.powered || p.voltage || p.current_mA || p.power_W;
            return [
                p.device,
                p.ifIndex,
                p.name,
                p.link,
                fmtSpeed(p.speedMbps),
                p.poe ? p.poeStatus.label : null,
                live && p.voltage != null ? `${p.voltage.toFixed(1)}V` : null,
                live && p.current_mA != null ? `${p.current_mA}mA` : null,
                live && p.power_W != null ? `${p.power_W.toFixed(1)}W` : null,
                fmtBytes(p.rxBytes),
                fmtBytes(p.txBytes),
                p.alias,
            ];
        })
    );

    // Things to act on, which would otherwise be one cell among a few hundred.
    const notes = [];
    // A PoE status above powered-on is a fault (overload, short-circuit, ...): the port has
    // refused to power what is plugged into it, which no other column makes obvious.
    for (const p of ports) if (p.poe && p.poeStatus.code > 3) notes.push(`${p.device} ${p.name}: PoE ${p.poeStatus.label} — the port is refusing to power the device`);
    for (const r of ok) if (aheadOf(r)) notes.push(`${r.label} runs RouterOS ${r.version}; ${aheadOf(r).label} already has ${aheadOf(r).version}`);
    const bootBehind = ok.filter(routerbootBehind);
    if (bootBehind.length) notes.push(`RouterBOOT is older than the one its RouterOS carries on ${bootBehind.map((r) => r.label).join(', ')} — /system routerboard upgrade, then reboot`);
    if (notes.length) {
        console.log('');
        for (const n of notes) console.log(`  note: ${n}`);
    }
}

async function main() {
    const args = process.argv.slice(2).map((a) => a.replace(/^--?/, ''));
    if (args.includes('help') || args.includes('h')) {
        const lines = fs.readFileSync(__filename, 'utf8').split('\n').slice(1);
        console.log(
            lines
                .slice(
                    0,
                    lines.findIndex((l) => !l.startsWith('//'))
                )
                .join('\n')
                .replace(/^\/\/ ?/gm, '')
        );
        return;
    }
    const filter = { up: args.includes('up'), poe: args.includes('poe'), json: args.includes('json') };
    const wanted = args.filter((a) => !['up', 'poe', 'json'].includes(a)).map((a) => a.toLowerCase());
    const unknown = wanted.filter((w) => !DEVICES.some((d) => d.label === w || d.host.toLowerCase() === w));
    if (unknown.length) {
        console.error(`Error: no device "${unknown.join('", "')}" — known: ${DEVICES.map((d) => d.label).join(', ')}`);
        process.exit(1);
    }
    const devices = wanted.length ? DEVICES.filter((d) => wanted.includes(d.label) || wanted.includes(d.host.toLowerCase())) : DEVICES;

    const settled = await Promise.allSettled(devices.map(readDevice));
    const results = settled.map((s, i) => (s.status === 'fulfilled' ? s.value : { ...devices[i], error: s.reason.message, ports: [] }));

    if (filter.json) console.log(JSON.stringify(results, null, 2));
    else report(results, filter);

    // Exit non-zero if anything was unreachable, so `watch` and scripts can notice.
    if (results.some((r) => r.error)) process.exitCode = 1;
}

if (require.main === module)
    main().catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
    });

module.exports = { readDevice, readSystem, DEVICES };
