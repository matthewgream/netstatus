#!/usr/bin/env node
//
// wifi-ft.js — turn 802.11r Fast Transition on or off across the MikroTik APs.
//
// 802.11r lets a client re-authenticate to the next AP without redoing the full
// handshake, so a roam costs milliseconds instead of a visible stall. It is off by
// default on RouterOS (security.ft=false).
//
// Scripted rather than clicked because this is a change you may well want to REVERSE:
// a handful of older clients refuse to associate to an SSID advertising FT, and the
// symptom (one device silently missing) is easy to misattribute days later. `off`
// restores exactly what `on` changed, on every AP at once.
//
//   Usage:
//     ./wifi-ft.js [status]        show the current FT state on each AP (default)
//     ./wifi-ft.js on              enable FT + FT-over-DS
//     ./wifi-ft.js off             disable both
//     ./wifi-ft.js <cmd> host...   act on specific hosts instead of the defaults
//     ./wifi-ft.js help
//
//   Environment:
//     WIFI_FT_HOSTS      space-separated AP list (default: the WifiWave2 boxes below)
//     ROUTEROS_USER      API username          (default admin)
//     ROUTEROS_PASS      API password          (required)
//     ROUTEROS_API_PORT  RouterOS API port     (default 8728)
//
// SCOPE — this only touches APs on the WifiWave2 stack (/interface/wifi). The RB911G
// runs the legacy /interface/wireless stack, which has no FT at all, and the Edimax is
// a different vendor entirely. Cross-vendor FT does not interoperate in practice: FT
// needs a shared key hierarchy and mobility domain, so roams to and from those two stay
// "hard" regardless. They are skipped with a note rather than silently ignored.
//
// FT also requires the APs to share SSID, passphrase and security config — which yours
// already do. `status` prints those alongside so a mismatch is visible.

const { RouterOS } = require('./poe-mikrotik.js');

const DEFAULT_HOSTS = (process.env.WIFI_FT_HOSTS || 'uh-hapbelite st-rbomnitikpg-5hacd').split(/\s+/).filter(Boolean);

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

// The radios themselves, not the slave SSID interfaces bound to them: a slave inherits its
// master's security, and setting FT on it is at best redundant and at worst a second, conflicting
// definition.
async function masterRadios(api) {
    const rows = (await api.talk(['/interface/wifi/print'])).filter((s) => s[0] === '!re').map(sentenceToObj);
    return rows.filter((r) => r.master !== 'false');
}

async function applyHost(host, mode) {
    const api = new RouterOS(host, parseInt(process.env.ROUTEROS_API_PORT || '8728', 10), process.env.ROUTEROS_USER || 'admin', process.env.ROUTEROS_PASS || '');
    await api.connect();
    try {
        await api.login();
        let radios;
        try {
            radios = await masterRadios(api);
        } catch (e) {
            // "no such command prefix" = the /interface/wifi menu does not exist at all (ROS 6).
            console.log(`  ${host}: no /interface/wifi menu (RouterOS 6 / legacy) — FT not supported here, skipping`);
            return;
        }
        if (!radios.length) {
            // The menu can EXIST and be empty while the radio is driven by the legacy `wireless`
            // package — ROS 7 still ships that for hardware with no wave2 driver (an OmniTIK 5 ac
            // without qcom-ac, say). Distinguish that from an AP that simply has not finished
            // starting, because the two need opposite responses: one is permanent, one is "wait".
            let legacy = [];
            try {
                legacy = (await api.talk(['/interface/wireless/print'])).filter((s) => s[0] === '!re');
            } catch {
                /* no legacy menu either */
            }
            if (legacy.length) console.log(`  ${host}: radio runs on the legacy 'wireless' driver (no wave2/qcom package) — FT not supported here, skipping`);
            else console.log(`  ${host}: no radios reported yet — still booting, or performing DFS radar detection (CAC). Retry shortly.`);
            return;
        }
        for (const r of radios) {
            const before = { ft: r['security.ft'], ftDs: r['security.ft-over-ds'] };
            const ssid = r['configuration.ssid'] || r.ssid || '?';
            if (mode === 'status') {
                console.log(`  ${host}  ${r.name.padEnd(22)} ssid=${String(ssid).padEnd(12)} ft=${before.ft ?? '?'}  ft-over-ds=${before.ftDs ?? '?'}`);
                continue;
            }
            const want = mode === 'on' ? 'yes' : 'no';
            // Sequentially, one interface at a time: this RouterOS client does not multiplex
            // tagged commands, so concurrent calls on one connection race.
            await api.talk(['/interface/wifi/set', `=.id=${r['.id']}`, `=security.ft=${want}`, `=security.ft-over-ds=${want}`]);
            console.log(`  ${host}  ${r.name.padEnd(22)} ft: ${before.ft ?? '?'} -> ${want}   ft-over-ds: ${before.ftDs ?? '?'} -> ${want}`);
        }
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
                .slice(1, 36)
                .join('\n')
                .replace(/^\/\/ ?/gm, '')
        );
        return;
    }
    const mode = ['on', 'off', 'status'].includes(args[0]) ? args[0] : 'status';
    const hosts = args.filter((a) => !['on', 'off', 'status'].includes(a));
    const targets = hosts.length ? hosts : DEFAULT_HOSTS;

    if (!process.env.ROUTEROS_PASS) {
        console.error('Error: ROUTEROS_PASS not set (and ROUTEROS_USER, default "admin").');
        process.exit(1);
    }

    console.log(mode === 'status' ? '802.11r Fast Transition — current state\n' : `802.11r Fast Transition — turning ${mode.toUpperCase()}\n`);
    let failed = 0;
    for (const host of targets) {
        try {
            await applyHost(host, mode);
        } catch (e) {
            // One unreachable AP must not stop the rest: a half-applied change across a roaming
            // domain is worse than none, so report loudly and carry on, then exit non-zero.
            failed++;
            console.log(`  ${host}: FAILED — ${e.message}`);
        }
    }
    if (mode !== 'status') {
        console.log(`\nRe-check with:  ./wifi-ft.js status`);
        if (mode === 'on') console.log(`If a device stops connecting, undo with:  ./wifi-ft.js off`);
    }
    if (failed) {
        // Only a failed on/off leaves things half-applied; a failed status changed nothing, so
        // saying "inconsistent" there would be alarming and wrong.
        if (mode === 'status') console.log(`\n${failed} AP(s) unreachable — state above is incomplete.`);
        else console.log(`\n${failed} AP(s) failed — the roaming domain is now INCONSISTENT (some APs changed, some did not). Re-run once they are reachable.`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
});
