#!/usr/bin/env node
//
// wifi-channel.js — put every MikroTik radio onto a sane, non-overlapping channel plan,
// 2.4GHz and 5GHz.
//
// 2.4GHz has exactly three non-overlapping 20MHz channels: 1, 6 and 11. Two things
// commonly break that, and both are true here by default:
//
//   * 40MHz width. It consumes two of the three channels, so with three APs in the band
//     there is no room left and overlap is guaranteed. 20MHz is the right width on 2.4GHz
//     whatever the throughput brochure says — an uncontended 20MHz channel beats a
//     contended 40MHz one in practice.
//   * auto-channel. It picks per AP with no coordination between them, so two APs can land
//     adjacent (worse than co-channel: partial overlap corrupts frames without either AP
//     backing off, whereas co-channel APs take turns via CSMA). It can also pick 12/13,
//     which are legal under ETSI but invisible to US-market phones and much IoT — a silent
//     failure, not an error.
//
// 5GHz in Sweden (ETSI) is constrained by where the AP is, not just by overlap:
//
//   * 36-48 (5150-5250) is the only block with no DFS, so no radar check (CAC) on boot and
//     no radar-forced channel moves — but it is INDOOR ONLY. It goes to the hAP, the main
//     indoor 5GHz AP, so it is back the instant it reboots.
//   * 52-64 is DFS and also indoor only: the Edimax holds it (it carries few 5GHz clients,
//     so a radar event there costs little).
//   * 100-140 is the only range legal OUTDOORS, so the pole OmniTik must live there. 120-128
//     overlaps weather radar and needs a 10-minute CAC; on auto the OmniTik landed on a
//     non-standard 128-140 block and was dark for 11 minutes after a reboot. Pinned to the
//     100-112 block instead: standard 80MHz alignment, 1-minute CAC.
//
// Hostname prefix is location: uh-* inside the house, st-* on the outdoor pole.
//
// Applying is reversible: the previous frequency/width/scan-list of every radio actually
// changed is written to a backup file, and `revert` puts them back. Radios already on plan
// are left untouched (and so do not drop their clients).
//
//   Usage:
//     ./wifi-channel.js [status]     show the current plan vs the intended one (default)
//     ./wifi-channel.js apply        set the planned channel + width where they differ
//     ./wifi-channel.js revert       restore whatever was there before the last apply
//     ./wifi-channel.js help
//
//   Environment:
//     ROUTEROS_USER / ROUTEROS_PASS / ROUTEROS_API_PORT   as the other wifi tools
//
// NOTE: changing a channel drops every client on that radio for a few seconds while they
// re-associate — and on a DFS channel the radio then stays silent for the CAC (1 min, or
// 10 min on weather-radar channels). Do not run it in the middle of something that matters.
//
// The Edimax is not managed here — it has no RouterOS API. Set its channels in the web UI;
// the plan below assumes it holds 11 (2.4GHz, 20MHz) and 52 (5GHz, 80MHz = 52-64).

const fs = require('fs');
const path = require('path');
const { RouterOS } = require('./poe-mikrotik.js');
const { parseChannel, sentenceToObj, pick } = require('./wifi-mikrotik.js');

// The intended assignment, per host then per band. Frequencies rather than channel numbers
// because that is what RouterOS wants on both stacks; for an 80MHz radio the frequency is
// the control channel and the width string picks the block around it.
//
//   2.4GHz   RB911G (pole) 1  ·  hAP (house) 6  ·  Edimax (house) 11
//   5GHz     hAP (house) 36-48  ·  Edimax (house) 52-64  ·  OmniTik (pole) 100-112
const PLAN = {
    'uh-hapbelite': {
        2.4: { freq: 2437, width: '20mhz' }, // channel 6
        5: { freq: 5180, width: '20/40/80mhz' }, // channel 36, 80MHz = 36-48, non-DFS
    },
    '192.168.0.29': {
        2.4: { freq: 2412, width: '20mhz', scanList: '2412,2437,2462' }, // channel 1 (RB911G, pole)
    },
    'st-rbomnitikpg-5hacd': {
        5: { freq: 5500, width: '20/40/80mhz-Ceee' }, // channel 100, 80MHz = 100-112 (OmniTik, pole)
    },
};

const BACKUP = path.join(__dirname, '.wifi-channel-backup.json');
const api_ = (host) => new RouterOS(host, parseInt(process.env.ROUTEROS_API_PORT || '8728', 10), process.env.ROUTEROS_USER || 'admin', process.env.ROUTEROS_PASS || '');

const bandOf = (freq) => (freq >= 2400 && freq <= 2500 ? 2.4 : freq >= 4900 && freq < 5900 ? 5 : null);
// '20/40/80mhz-Ceee' and '20/40/80mhz' both mean "up to 80": the widest figure is the width.
const widthOf = (s) => Math.max(...String(s).match(/\d+/g).map(Number));

// Find the radios and read their live channel. Returns [{kind, id, name, band, live, prev}].
// The band is judged from the frequency the radio is actually on rather than from the
// interface name, which is only a label and can say anything.
async function radios(api) {
    for (const [printPath, monitorPath, kind] of [
        ['/interface/wifi/print', '/interface/wifi/monitor', 'wave2'],
        ['/interface/wireless/print', '/interface/wireless/monitor', 'legacy'],
    ]) {
        let ifaces;
        try {
            ifaces = (await api.talk([printPath])).filter((s) => s[0] === '!re').map(sentenceToObj);
        } catch {
            continue;
        }
        if (!ifaces.length) continue;
        const out = [];
        for (const i of ifaces) {
            if (pick(i, 'master') === 'false') continue; // slave SSID / MLD, no channel of its own
            const name = pick(i, 'name');
            let chan;
            try {
                chan = pick(sentenceToObj(((await api.talk([monitorPath, `=numbers=${name}`, '=once='])).filter((s) => s[0] === '!re') || [])[0] || []), 'channel');
            } catch {
                continue;
            }
            const p = parseChannel(chan);
            const band = bandOf(p.freq);
            if (!band) continue; // not up yet, or a band this plan does not cover
            out.push({
                kind,
                id: i['.id'],
                name,
                band,
                live: p,
                // What we would have to restore. On wave2 these live under channel.*; on legacy
                // they are top-level.
                // null, not undefined: a setting absent from print() is at its DEFAULT, and
                // JSON.stringify drops undefined keys entirely — which would have left revert
                // with an empty record and silently nothing to restore. Revert sends null as the
                // empty string, which returns the setting to default rather than pinning a value.
                prev:
                    kind === 'wave2'
                        ? { 'channel.frequency': i['channel.frequency'] ?? null, 'channel.width': i['channel.width'] ?? null }
                        : { 'frequency': i.frequency ?? null, 'channel-width': i['channel-width'] ?? null, 'scan-list': i['scan-list'] ?? null },
            });
        }
        if (out.length) return out;
    }
    return [];
}

function setWords(kind, want) {
    return kind === 'wave2' ? { 'channel.frequency': String(want.freq), 'channel.width': want.width } : { 'frequency': String(want.freq), 'channel-width': want.width, ...(want.scanList ? { 'scan-list': want.scanList } : {}) };
}

// On plan = every setting apply would write is already configured that way. Judged on the
// configuration, not the live channel: a radio on auto can happen to sit on the planned
// channel today and wander off it tomorrow.
const onPlan = (r, words) => Object.entries(words).every(([k, v]) => (r.prev[k] ?? '') === v);

const fmtLive = (p) => `ch ${p.channel} (${p.freq}MHz) ${p.width}MHz`;
const fmtWant = (w) => `ch ${w.freq < 3000 ? (w.freq - 2407) / 5 : (w.freq - 5000) / 5} (${w.freq}MHz) ${widthOf(w.width)}MHz`;

async function run(mode) {
    const backup = mode === 'revert' ? JSON.parse(fs.readFileSync(BACKUP, 'utf8')) : { when: new Date().toISOString(), hosts: {} };
    const hosts = mode === 'revert' ? Object.keys(backup.hosts) : Object.keys(PLAN);
    let failed = 0,
        changed = 0;

    for (const host of hosts) {
        const api = api_(host);
        try {
            await api.connect();
            await api.login();
            const rs = await radios(api);
            if (!rs.length) {
                console.log(`  ${host}: no radio found (still starting?)`);
                continue;
            }
            for (const r of rs) {
                const now = fmtLive(r.live);
                const want = (PLAN[host] || {})[r.band];
                if (mode === 'status') {
                    const ok = want && onPlan(r, setWords(r.kind, want));
                    console.log(`  ${host.padEnd(21)} ${r.name.padEnd(22)} now: ${now.padEnd(26)} planned: ${want ? fmtWant(want) : '(not in plan)'}${ok ? '   [matches]' : ''}`);
                    continue;
                }
                let words;
                if (mode === 'revert') {
                    words = (backup.hosts[host] || {})[r.name];
                    if (!words) continue; // not touched by the last apply
                } else {
                    if (!want) continue;
                    words = setWords(r.kind, want);
                    if (onPlan(r, words)) {
                        console.log(`  ${host.padEnd(21)} ${r.name.padEnd(22)} ${now}  already on plan, left alone`);
                        continue;
                    }
                }
                await api.talk([`${r.kind === 'wave2' ? '/interface/wifi' : '/interface/wireless'}/set`, `=.id=${r.id}`, ...Object.entries(words).map(([k, v]) => `=${k}=${v ?? ''}`)]);
                // Recorded only once the set has gone through, so the backup holds exactly the
                // radios that were changed — and is still written if a later host fails, since
                // those changed radios must stay revertible.
                if (mode === 'apply') (backup.hosts[host] = backup.hosts[host] || {})[r.name] = r.prev;
                changed++;
                console.log(
                    `  ${host.padEnd(21)} ${r.name.padEnd(22)} ${now}  ->  ${Object.entries(words)
                        .map(([k, v]) => `${k}=${v ?? '(default)'}`)
                        .join(' ')}`
                );
            }
        } catch (e) {
            failed++;
            console.log(`  ${host}: FAILED — ${e.message}`);
        } finally {
            try {
                api.close();
            } catch {
                /* already closed */
            }
        }
    }

    // Only when something actually changed: an apply that found everything on plan must not
    // overwrite the backup from the apply that did the work.
    if (mode === 'apply' && changed) {
        fs.writeFileSync(BACKUP, JSON.stringify(backup, null, 2));
        console.log(`\n  previous settings saved to ${path.basename(BACKUP)} — undo with:  ./wifi-channel.js revert`);
    }
    if (mode === 'apply' && !changed && !failed) console.log('\n  everything already on plan; nothing changed.');
    if (failed) {
        console.log(`\n  ${failed} AP(s) failed.`);
        process.exit(1);
    }
}

async function main() {
    const arg = process.argv[2];
    if (['help', '-h', '--help'].includes(arg)) {
        console.log(
            fs
                .readFileSync(__filename, 'utf8')
                .split('\n')
                .slice(1, 52)
                .join('\n')
                .replace(/^\/\/ ?/gm, '')
        );
        return;
    }
    const mode = ['apply', 'revert', 'status'].includes(arg) ? arg : 'status';
    if (!process.env.ROUTEROS_PASS) {
        console.error('Error: ROUTEROS_PASS not set.');
        process.exit(1);
    }
    if (mode === 'revert' && !fs.existsSync(BACKUP)) {
        console.error(`Error: no backup at ${BACKUP} — nothing to revert to.`);
        process.exit(1);
    }
    console.log(mode === 'status' ? 'WiFi channel plan — current vs intended\n' : `WiFi channel plan — ${mode.toUpperCase()}  (clients on changed radios will re-associate)\n`);
    await run(mode);
}

main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
});
