#!/usr/bin/env node
//
// poe-mikrotik.js — read & actuate PoE on any MikroTik (RouterOS) switch/router.
//
// Works two ways:
//   * as a MODULE   — require() it and call the exported functions, which
//                     resolve to / return plain structs (see module.exports).
//   * as a CLI      — `./poe-mikrotik.js <command>`; the CLI just calls the
//                     same exported functions and formats their structs.
//
// READS go over SNMP (read-only, same as poller.js).
// ACTUATION goes over the RouterOS API (port 8728) — RouterOS does NOT expose
// PoE control over SNMP. Credentials come from opts or the environment, never
// hardcoded.
//
// Options (all functions take an optional final `opts` object; missing fields
// fall back to env, then defaults):
//   host       POE_HOST            default 192.168.0.128
//   community  POE_COMMUNITY       default public
//   apiPort    ROUTEROS_API_PORT   default 8728
//   user       ROUTEROS_USER       (required for actuation)
//   pass       ROUTEROS_PASS       (required for actuation)
//
// ---------------------------------------------------------------------------
// Least-privilege user for the recovery service
// ---------------------------------------------------------------------------
// Actuation only needs to read interfaces and toggle poe-out. Rather than run
// the always-on recovery service as `admin`, create a dedicated RouterOS user
// limited to the API + read/write so a leaked credential can't do more than
// flip PoE. The required policies are:
//   api   — log in over the API at all (port 8728)
//   read  — /interface/ethernet/print
//   write — /interface/ethernet/set poe-out=...
//   test  — only if you also ping/bandwidth-test (optional)
// Everything not granted is denied by default.
//
// Provision it manually over SSH (`ssh admin@<switch>`):
//   /user group add name=poe-api policy=api,read,write,test
//   /user add name=poe group=poe-api password="<strong-pass>" comment="poe recovery service"
//   # optional hardening — restrict where it may log in from:
//   /user set poe address=192.168.0.0/24
//   /ip service set api address=192.168.0.0/24
//
// ...or automate it: run this script's `setup` command (or call setupUser())
// ONCE as admin, then run the recovery service as the restricted user:
//   ROUTEROS_USER=admin ROUTEROS_PASS=<admin-pass> \
//       ./poe-mikrotik.js setup poe '<strong-pass>' [allowed-address]
// setupUser() is idempotent: it updates the user if it already exists.

const snmp = require('net-snmp');
const net = require('net');
const crypto = require('crypto');

// --- OIDs -------------------------------------------------------------------
// We DISCOVER interfaces by walking the standard interface table, then JOIN the
// MikroTik PoE table onto it by ifIndex. We do NOT assume a fixed port count or
// that "row N == etherN": RouterOS interfaces are indexed per-device (loopback,
// bridge, sfp and renamed ports all shift the numbering), so hardcoding breaks
// across models. Walking makes this work on any MikroTik (5-port hEX, 8-port
// CRS, etc.) and surfaces SFP ports too — they live here even though they carry
// no PoE.
const POE = '1.3.6.1.4.1.14988.1.1.15.1.1'; // MIKROTIK-MIB PoE table (.<col>.<ifIndex>)
const OID = {
    poeName: `${POE}.2`, // DisplayString
    poeStatus: `${POE}.3`, // INTEGER (see POE_STATUS)
    poeVolt: `${POE}.4`, // deci-volts  (524 => 52.4 V)
    poeCurr: `${POE}.5`, // milli-amps
    poePower: `${POE}.6`, // deci-watts  (66 => 6.6 W)
    ifName: '1.3.6.1.2.1.31.1.1.1.1', // ifName (ifXTable) — the configured port name
    ifAlias: '1.3.6.1.2.1.31.1.1.1.18', // ifAlias — the RouterOS port comment ('' when none)
    ifSpeed: '1.3.6.1.2.1.31.1.1.1.15', // ifHighSpeed — negotiated speed, Mbps
    ifIn: '1.3.6.1.2.1.31.1.1.1.6', // ifHCInOctets  — bytes FROM the device into the switch
    ifOut: '1.3.6.1.2.1.31.1.1.1.10', // ifHCOutOctets — bytes the switch sent TO the device
    ifType: '1.3.6.1.2.1.2.2.1.3', // ifType (6 = ethernetCsmacd covers ether AND sfp)
    ifOper: '1.3.6.1.2.1.2.2.1.8', // ifOperStatus (1=up,2=down)
    ifAdmin: '1.3.6.1.2.1.2.2.1.7', // ifAdminStatus (1=up,2=down)
};

// RouterOS reports both copper ether AND sfp cages as ethernetCsmacd(6); virtual
// interfaces (loopback=24/other=1, bridge=209, vlan, etc.) get other types. We
// keep only the physical ports by default, which is exactly the set you can wire
// something into (and the only set PoE can ever apply to).
const PHYSICAL_IFTYPE = 6;

// MIKROTIK-MIB mtxrPOEStatus. 3 = delivering power, 2 = no load / not powering; 4 and up
// are the faults RouterOS shows as poe-out-status (a port refusing to power reads 5,
// short-circuit), so they are spelt out rather than left as a bare number.
const POE_STATUS = {
    1: 'disabled',
    2: 'waiting/no-load',
    3: 'powered-on',
    4: 'overload',
    5: 'short-circuit',
    6: 'voltage-too-low',
    7: 'current-too-low',
    8: 'power-reset',
    9: 'voltage-too-high',
    10: 'controller-error',
    11: 'controller-upgrade',
    12: 'poe-in-detected',
    13: 'no-valid-psu',
    14: 'controller-init',
    15: 'low-voltage-too-low',
};

// --- shared helpers ---------------------------------------------------------
function resolveOpts(opts = {}) {
    return {
        host: opts.host || process.env.POE_HOST || '192.168.0.128',
        community: opts.community || process.env.POE_COMMUNITY || 'public',
        apiPort: opts.apiPort || parseInt(process.env.ROUTEROS_API_PORT || '8728', 10),
        user: opts.user || process.env.ROUTEROS_USER,
        pass: opts.pass || process.env.ROUTEROS_PASS,
    };
}

// A literal RouterOS default-name (etherN / sfpN / combo1 ...). When a selector
// looks like one we can resolve it directly over the API; anything else is an
// ifIndex or a name and must be resolved against the device's interface list.
const DEFAULT_NAME_RE = /^(ether|sfp|sfp-sfpplus|sfpplus|combo|qsfp)\d+$/i;

function bufferToNumber(buf) {
    if (typeof buf === 'number') return buf;
    if (Buffer.isBuffer(buf)) {
        if (buf.length <= 6) return buf.readUIntBE(0, buf.length);
        let val = 0n;
        for (const byte of buf) val = (val << 8n) + BigInt(byte);
        return Number(val);
    }
    return 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Walk a single-index SNMP column (the index is the trailing ifIndex) and return
// a { ifIndex: value } map. Used to discover the interface set dynamically.
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
                    const idx = oid.slice(base.length + 1); // strip "base."
                    out[idx] = vb.value;
                }
            },
            (error) => (error ? reject(error) : resolve(out))
        );
    });
}

// ===========================================================================
// READ (SNMP)
// ===========================================================================
//
// readStatus(opts) -> Promise<{
//   host, totalPowerW,
//   ports: [{                       // one entry per PHYSICAL interface (ether + sfp)
//     ifIndex,         // SNMP ifIndex (stable per device, NOT a 1..8 port number)
//     name,            // configured port name (ifName)
//     alias,           // RouterOS port comment (ifAlias) | null when none
//     poe,             // boolean — does this interface appear in the PoE table?
//     link,            // "up" | "down" | "admin-down"
//     oper, admin,     // raw SNMP ifOper/ifAdmin status ints
//     speedMbps,       // negotiated speed (ifHighSpeed) | null while the link is down
//     powered,         // boolean — is PoE delivering power right now (false if no PoE)
//     poeStatus,       // { code, label } | { code:null, label:null } when no PoE
//     voltage,         // volts (number) | null   (null when no PoE)
//     current_mA,      // milliamps    | null
//     power_W,         // watts        | null
//     rxBytes,         // bytes FROM the attached device (into the switch) | null
//     txBytes,         // bytes TO the attached device (out of the switch)  | null
//   }, ...]
// }>
// opts.includeAll = true also returns virtual interfaces (bridge, vlan, loopback).
async function readStatus(opts) {
    const o = resolveOpts(opts);
    const includeAll = !!(opts && opts.includeAll);
    const session = snmp.createSession(o.host, o.community, { timeout: 5000, version: snmp.Version2c });
    try {
        const [names, aliases, speeds, types, opers, admins, ins, outs, pStat, pVolt, pCurr, pPow] = await Promise.all([
            walkOid(session, OID.ifName),
            walkOid(session, OID.ifAlias),
            walkOid(session, OID.ifSpeed),
            walkOid(session, OID.ifType),
            walkOid(session, OID.ifOper),
            walkOid(session, OID.ifAdmin),
            walkOid(session, OID.ifIn),
            walkOid(session, OID.ifOut),
            walkOid(session, OID.poeStatus),
            walkOid(session, OID.poeVolt),
            walkOid(session, OID.poeCurr),
            walkOid(session, OID.poePower),
        ]);

        const ports = [];
        let totalPowerW = 0;
        const indices = Object.keys(names)
            .map(Number)
            .sort((a, b) => a - b);
        for (const idx of indices) {
            const type = types[idx] != null ? Number(types[idx]) : null;
            if (!includeAll && type !== PHYSICAL_IFTYPE) continue; // skip bridge/vlan/loopback

            const oper = opers[idx] != null ? Number(opers[idx]) : null;
            const admin = admins[idx] != null ? Number(admins[idx]) : null;
            const hasPoe = pStat[idx] != null;
            const code = hasPoe ? Number(pStat[idx]) : null;
            const power = hasPoe && pPow[idx] != null ? Number(pPow[idx]) / 10 : null;
            if (power) totalPowerW += power;

            ports.push({
                ifIndex: idx,
                name: names[idx] != null ? names[idx].toString() : null,
                alias: aliases[idx] != null && aliases[idx].length ? aliases[idx].toString() : null,
                poe: hasPoe,
                link: admin === 2 ? 'admin-down' : oper === 1 ? 'up' : 'down',
                oper,
                admin,
                // Only meaningful with the link up: some ports report their maximum while down
                // (a hEX lite says 100 on every empty port), which would read as a live link.
                speedMbps: oper === 1 && speeds[idx] != null ? Number(speeds[idx]) || null : null,
                powered: code === 3,
                poeStatus: { code, label: code != null ? POE_STATUS[code] || `status-${code}` : null },
                voltage: hasPoe && pVolt[idx] != null ? Number(pVolt[idx]) / 10 : null,
                current_mA: hasPoe && pCurr[idx] != null ? Number(pCurr[idx]) : null,
                power_W: power,
                rxBytes: ins[idx] != null ? bufferToNumber(ins[idx]) : null,
                txBytes: outs[idx] != null ? bufferToNumber(outs[idx]) : null,
            });
        }
        return { host: o.host, totalPowerW: Math.round(totalPowerW * 10) / 10, ports };
    } finally {
        session.close();
    }
}

// readPort(sel, opts) -> Promise<port-struct> (one entry from readStatus).
// sel is an ifIndex number, or a substring matched case-insensitively against the
// interface name (e.g. "camera", "sfp"). Returns undefined if nothing matches.
async function readPort(sel, opts) {
    const { ports } = await readStatus(opts);
    if (/^\d+$/.test(String(sel))) return ports.find((x) => x.ifIndex === Number(sel));
    const needle = String(sel).toLowerCase();
    return ports.find((x) => (x.name || '').toLowerCase().includes(needle));
}

// ===========================================================================
// RouterOS API client (minimal, plaintext 8728)
// ===========================================================================
// Length-prefixed "words" grouped into "sentences" terminated by a zero-length
// word. Login is the post-6.43 plaintext form, with a legacy MD5-challenge
// fallback if the router demands it.
class RouterOS {
    constructor(host, port, user, pass) {
        Object.assign(this, { host, port, user, pass });
    }

    static encodeLen(n) {
        if (n < 0x80) return Buffer.from([n]);
        if (n < 0x4000) return Buffer.from([(n >> 8) | 0x80, n & 0xff]);
        if (n < 0x200000) return Buffer.from([(n >> 16) | 0xc0, (n >> 8) & 0xff, n & 0xff]);
        if (n < 0x10000000) return Buffer.from([(n >> 24) | 0xe0, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
        return Buffer.from([0xf0, (n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.buf = Buffer.alloc(0);
            this.queue = []; // pending sentence collectors (FIFO)
            this.sentence = []; // words of the sentence being assembled
            this.sock = net.connect({ host: this.host, port: this.port }, resolve);
            this.sock.on('error', reject);
            this.sock.on('data', (d) => this._onData(d));
        });
    }

    _onData(d) {
        this.buf = Buffer.concat([this.buf, d]);
        for (;;) {
            const dec = this._decodeLen();
            if (dec == null) return; // need more bytes
            const [len, hdr] = dec;
            if (this.buf.length < hdr + len) return; // need more bytes
            const word = this.buf.slice(hdr, hdr + len).toString('binary');
            this.buf = this.buf.slice(hdr + len);
            if (len === 0) {
                const s = this.sentence;
                this.sentence = [];
                if (this.queue[0]) this.queue[0].push(s);
            } else {
                this.sentence.push(word);
            }
        }
    }

    _decodeLen() {
        const b = this.buf;
        if (b.length < 1) return null;
        const c = b[0];
        if ((c & 0x80) === 0) return [c, 1];
        if ((c & 0xc0) === 0x80) return b.length < 2 ? null : [((c & 0x3f) << 8) | b[1], 2];
        if ((c & 0xe0) === 0xc0) return b.length < 3 ? null : [((c & 0x1f) << 16) | (b[1] << 8) | b[2], 3];
        if ((c & 0xf0) === 0xe0) return b.length < 4 ? null : [((c & 0x0f) << 24) | (b[1] << 16) | (b[2] << 8) | b[3], 4];
        return b.length < 5 ? null : [(b[1] << 24) | (b[2] << 16) | (b[3] << 8) | b[4], 5];
    }

    // Send one sentence (array of words), collect reply sentences until !done/!fatal.
    talk(words) {
        return new Promise((resolve, reject) => {
            const cb = [];
            this.queue.push(cb);
            const done = [];
            let trap = null;
            const tick = setInterval(() => {
                while (cb.length) {
                    const s = cb.shift();
                    done.push(s);
                    const tag = s[0];
                    if (tag === '!trap') trap = s.slice(1).join(' ');
                    if (tag === '!done' || tag === '!fatal') {
                        clearInterval(tick);
                        this.queue.shift();
                        if (tag === '!fatal') return reject(new Error('!fatal: ' + s.slice(1).join(' ')));
                        if (trap) return reject(new Error('!trap: ' + trap));
                        return resolve(done);
                    }
                }
            }, 2);
            let out = Buffer.alloc(0);
            for (const word of words) out = Buffer.concat([out, RouterOS.encodeLen(Buffer.byteLength(word, 'binary')), Buffer.from(word, 'binary')]);
            out = Buffer.concat([out, Buffer.from([0])]); // terminate sentence
            this.sock.write(out);
        });
    }

    async login() {
        let r = await this.talk(['/login', `=name=${this.user}`, `=password=${this.pass}`]);
        const ret = r.find((s) => s[0] === '!done')?.find((w) => w.startsWith('=ret='));
        if (!ret) return; // post-6.43 plaintext login accepted
        const challenge = Buffer.from(ret.slice(5), 'hex');
        const md5 = crypto.createHash('md5');
        md5.update(Buffer.concat([Buffer.from([0]), Buffer.from(this.pass, 'binary'), challenge]));
        await this.talk(['/login', `=name=${this.user}`, `=response=00${md5.digest('hex')}`]);
    }

    close() {
        if (this.sock) this.sock.end();
    }
}

// Open API, login, run fn(api), always close.
async function withApi(o, fn) {
    if (!o.user || !o.pass) throw new Error('actuation needs RouterOS API credentials (opts.user/opts.pass or ROUTEROS_USER/ROUTEROS_PASS)');
    const api = new RouterOS(o.host, o.apiPort, o.user, o.pass);
    await api.connect();
    try {
        await api.login();
        return await fn(api);
    } finally {
        api.close();
    }
}

// Fetch one /interface/ethernet record matching key=val (e.g. name / default-name).
// Returns { id, name, defaultName } or null. Lets us confirm exactly which
// physical port we are about to touch.
async function ethRecord(api, key, val) {
    const printed = await api.talk(['/interface/ethernet/print', `?${key}=${val}`]);
    const re = printed.find((s) => s[0] === '!re');
    if (!re) return null;
    const field = (k) => {
        const w = re.find((x) => x.startsWith(`=${k}=`));
        return w ? w.slice(k.length + 2) : null;
    };
    return { id: field('.id'), name: field('name'), defaultName: field('default-name') };
}

// Resolve a user selector to a concrete ethernet record — using the SAME identity
// the `status` table prints, so "off 4" means "the idx-4 row" not "ether4":
//   * a literal default-name (etherN / sfpN)  -> matched directly over the API
//   * an integer                              -> ifIndex from `status` (the Idx column)
//   * anything else                           -> case-insensitive name substring
// The ifIndex / name paths read SNMP to map idx<->name, then look the interface
// up by its RouterOS name (which equals the SNMP ifName). Name substrings that hit
// more than one interface are rejected rather than guessed.
async function resolveEth(api, sel, o) {
    const s = String(sel).trim();
    if (DEFAULT_NAME_RE.test(s)) {
        const rec = (await ethRecord(api, 'default-name', s)) || (await ethRecord(api, 'name', s));
        if (!rec) throw new Error(`no ethernet interface with default-name "${s}"`);
        return rec;
    }
    const { ports } = await readStatus(o);
    let match;
    if (/^\d+$/.test(s)) {
        match = ports.find((p) => p.ifIndex === Number(s));
        if (!match) throw new Error(`no interface at idx ${s} — run: ./poe-mikrotik.js status`);
    } else {
        const needle = s.toLowerCase();
        const hits = ports.filter((p) => (p.name || '').toLowerCase().includes(needle));
        if (hits.length === 0) throw new Error(`no interface name contains "${s}" — run: ./poe-mikrotik.js status`);
        if (hits.length > 1) throw new Error(`"${s}" matches ${hits.length} interfaces (${hits.map((h) => `idx${h.ifIndex} ${h.name}`).join(', ')}) — be more specific`);
        match = hits[0];
    }
    const rec = await ethRecord(api, 'name', match.name);
    if (!rec) throw new Error(`SNMP idx ${match.ifIndex} ("${match.name}") has no matching API ethernet interface`);
    rec.ifIndex = match.ifIndex;
    return rec;
}

// Apply key=value settings to a resolved ethernet record.
async function setEthernet(api, rec, kv) {
    await api.talk(['/interface/ethernet/set', `=.id=${rec.id}`, ...Object.entries(kv).map(([k, v]) => `=${k}=${v}`)]);
}

// Shorthand for the resolved-port confirmation struct the actuators return.
const portTag = (rec) => ({ ifIndex: rec.ifIndex ?? null, iface: rec.defaultName, name: rec.name });

// ===========================================================================
// ACTUATE (RouterOS API) — each returns a small result struct.
// ===========================================================================

// setPoe(port, value, opts) — value is "off" | "auto-on" | "forced-on".
// `port` is an Idx number, a name substring, or a default-name (etherN/sfpN).
async function setPoe(port, value, opts) {
    const o = resolveOpts(opts);
    return withApi(o, async (api) => {
        const rec = await resolveEth(api, port, o);
        await setEthernet(api, rec, { 'poe-out': value });
        return { ...portTag(rec), poeOut: value };
    });
}
const poeOff = (port, opts) => setPoe(port, 'off', opts);
const poeOn = (port, opts) => setPoe(port, 'auto-on', opts);

// poeCycle(port, seconds=10, opts) — the recovery primitive: off, wait, on.
async function poeCycle(port, seconds = 10, opts) {
    const o = resolveOpts(opts);
    return withApi(o, async (api) => {
        const rec = await resolveEth(api, port, o);
        await setEthernet(api, rec, { 'poe-out': 'off' });
        await sleep(seconds * 1000);
        await setEthernet(api, rec, { 'poe-out': 'auto-on' });
        return { ...portTag(rec), cycled: true, offSeconds: seconds };
    });
}

// setPort(port, disabled, opts) — disable/enable the whole interface (link down).
async function setPort(port, disabled, opts) {
    const o = resolveOpts(opts);
    return withApi(o, async (api) => {
        const rec = await resolveEth(api, port, o);
        await setEthernet(api, rec, { disabled: disabled ? 'yes' : 'no' });
        return { ...portTag(rec), disabled: !!disabled };
    });
}
const portDisable = (port, opts) => setPort(port, true, opts);
const portEnable = (port, opts) => setPort(port, false, opts);

// ===========================================================================
// PROVISION (RouterOS API) — create/update the least-privilege recovery user.
// ===========================================================================
// Run ONCE as admin. Idempotent: creates the group/user if missing, otherwise
// updates the user's group + password (+ allowed address). The admin creds come
// from opts/env (user/pass); the NEW account is named by newUser/newPass args.
//
// setupUser(newUser, newPass, opts) -> Promise<{group, user, groupCreated, userCreated}>
//   opts (besides admin host/user/pass): group  (default "poe-api")
//                                        policy (default "api,read,write,test")
//                                        address (optional CIDR, restricts login source)
async function setupUser(newUser, newPass, opts = {}) {
    if (!newUser || !newPass) throw new Error('setupUser requires newUser and newPass');
    const group = opts.group || 'poe-api';
    const policy = opts.policy || 'api,read,write,test';
    const address = opts.address;
    return withApi(resolveOpts(opts), async (api) => {
        // First word of the matching !re sentence that carries =.id=, or null.
        const idOf = async (path, key, val) => {
            const r = await api.talk([`${path}/print`, `?${key}=${val}`]);
            const idw = r.find((s) => s[0] === '!re')?.find((w) => w.startsWith('=.id='));
            return idw ? idw.slice(5) : null;
        };

        let groupCreated = false;
        if (!(await idOf('/user/group', 'name', group))) {
            await api.talk(['/user/group/add', `=name=${group}`, `=policy=${policy}`]);
            groupCreated = true;
        }

        const userKv = [`=group=${group}`, `=password=${newPass}`, ...(address ? [`=address=${address}`] : [])];
        const existingId = await idOf('/user', 'name', newUser);
        let userCreated = false;
        if (existingId) {
            await api.talk(['/user/set', `=.id=${existingId}`, ...userKv]);
        } else {
            await api.talk(['/user/add', `=name=${newUser}`, '=comment=poe recovery service', ...userKv]);
            userCreated = true;
        }
        return { group, user: newUser, groupCreated, userCreated };
    });
}

module.exports = {
    readStatus,
    walkOid,
    readPoeSample,
    watch,
    readPort,
    setPoe,
    poeOff,
    poeOn,
    poeCycle,
    setPort,
    portDisable,
    portEnable,
    setupUser,
    RouterOS,
    POE_STATUS,
};

// ===========================================================================
// CLI (only when run directly) — thin wrapper over the exports above.
// ===========================================================================
const HELP = `poe-mikrotik.js — read & actuate PoE on a MikroTik (RouterOS), any model

Usage:
  ./poe-mikrotik.js [status]            show ALL physical interfaces (ether+sfp): link, PoE, V/A/W, traffic
  ./poe-mikrotik.js json               same data as JSON (for piping into other tools)
  ./poe-mikrotik.js watch [flags]      sample PoE draw until Ctrl-C, tracking per-port peaks
        --summary                      one line per report instead of the full table
        --interval=N                   seconds between samples (default 5)
        --report=N                     seconds between periodic lines (default 60)
        --limit-port=N                 per-port current limit in mA — report margin vs it
        --limit-total=N                whole-device current limit in mA — likewise
                                       New peaks print the moment they occur, whatever the
                                       report interval; Ctrl-C prints a final peak table.
                                       Neither SNMP nor RouterOS keeps a peak, so the only
                                       way to have one is to sample for it. Nor does either
                                       publish the hardware's ratings, hence the limit flags:
                                         CRS112            --limit-port=450 --limit-total=1400
                                         RBOmniTikPG-5HacD --limit-port=450 --limit-total=2000
  ./poe-mikrotik.js off   <port>       cut PoE power to a port            [needs API creds]
  ./poe-mikrotik.js on    <port>       restore PoE power (auto-on)        [needs API creds]
  ./poe-mikrotik.js cycle <port> [s]   off, wait s seconds (default 10), on   [needs API creds]
  ./poe-mikrotik.js disable <port>     disable the port itself (link down)[needs API creds]
  ./poe-mikrotik.js enable  <port>     re-enable the port                 [needs API creds]
  ./poe-mikrotik.js setup <user> <pass> [addr]
                                       create/update a least-privilege API user
                                       (run ONCE as admin)               [needs ADMIN creds]
  ./poe-mikrotik.js help               show this help

  <port> selects the SAME interface the status table shows. It can be:
    * an Idx number      e.g. "4"     -> the row with ifIndex 4 in 'status'
    * a name substring   e.g. "adsb"  -> matched against the Name column
    * a physical port    e.g. "ether3"-> a literal RouterOS default-name
  NOTE: the Idx number is the SNMP ifIndex, which is NOT necessarily the etherN
  number (loopback/uplink/bridge shift it per device). When in doubt use the name,
  or "ether3" for the physical port. Every actuation echoes back the resolved
  {ifIndex, iface(=default-name), name} so you can confirm it hit the right port.

Environment:
  POE_HOST           switch address       (default 192.168.0.128)
  POE_COMMUNITY      SNMP community        (default public)
  ROUTEROS_API_PORT  RouterOS API port     (default 8728)
  ROUTEROS_USER      API username          (required for actuation)
  ROUTEROS_PASS      API password          (required for actuation)`;

// peaks (optional) is the ifIndex -> {current_mA, power_W} map kept by watch(); when
// present the table gains the high-water columns, so a periodic watch report is exactly
// the table `status` prints plus what the run has seen so far.
function printStatusTable(s, peaks) {
    const fmtBytes = (b) => {
        if (b == null) return '-';
        if (!b) return '0B';
        const k = 1024,
            sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        const i = Math.floor(Math.log(b) / Math.log(k));
        return parseFloat((b / Math.pow(k, i)).toFixed(2)) + sizes[i];
    };
    console.log(`Interface + PoE status @ ${s.host}\n`);
    const head = ['Idx', 'Name', 'Link', 'PoE', 'Volt', 'Curr', 'Power'];
    if (peaks) head.push('PeakCurr', 'PeakPower');
    head.push('from-dev(rx)', 'to-dev(tx)');
    const rows = [head];
    for (const p of s.ports) {
        const row = [
            String(p.ifIndex),
            (p.name || '').slice(0, 42),
            p.link,
            p.poe ? `${p.poeStatus.label}(${p.poeStatus.code})` : '—',
            p.voltage != null ? `${p.voltage.toFixed(1)}V` : '—',
            p.current_mA != null ? `${p.current_mA}mA` : '—',
            p.power_W != null ? `${p.power_W.toFixed(1)}W` : '—',
        ];
        if (peaks) {
            const pk = peaks[p.ifIndex];
            row.push(pk && pk.current_mA ? `${pk.current_mA}mA` : '—', pk && pk.power_W ? `${pk.power_W.toFixed(1)}W` : '—');
        }
        row.push(fmtBytes(p.rxBytes), fmtBytes(p.txBytes));
        rows.push(row);
    }
    const w = head.map((_, c) => Math.max(...rows.map((row) => String(row[c]).length)));
    for (const row of rows) console.log(row.map((cell, c) => String(cell).padEnd(w[c])).join('  '));
    console.log(`\nTotal PoE draw: ${s.totalPowerW} W`);
}

// --- watch ------------------------------------------------------------------
// Neither the MikroTik PoE SNMP table nor RouterOS's own /interface/ethernet/poe/monitor
// retains a high-water mark — both are live reads — so a peak only exists if something
// samples for it. Draw moves on a timescale of seconds (a device booting, a camera's IR
// illuminator cutting in), so sampling has to be fast; but a run left going for days that
// printed every sample would bury the very spike it was left running to catch. Hence:
// sample fast, report slowly, and print immediately only when a new peak is actually set.

const WATCH_INTERVAL_DEFAULT = 5; // seconds between samples
const WATCH_REPORT_DEFAULT = 60; // seconds between periodic lines
// Every new high-water mark is *recorded*, but only a materially larger one is *announced*:
// the readings jitter by 10-20mA sample to sample, so announcing every 1mA nudge would fill
// a multi-day log with noise and hide the real spikes. Relative rather than absolute so it
// scales with the port: a 5mA step means something on a 40mA port and nothing on a 150mA one.
const WATCH_PEAK_NOTIFY_RATIO = 1.1;
// Fraction of a stated limit at which headroom stops being comfortable and the run starts
// saying so. Below this the margin is reported quietly as a percentage; at or above it every
// crossing is called out, because "how close am I to the limit" is the question a long run
// is usually left going to answer.
const WATCH_LIMIT_WARN_RATIO = 0.8;

function watchStamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function watchElapsed(ms) {
    const s = Math.floor(ms / 1000),
        d = Math.floor(s / 86400),
        h = Math.floor((s % 86400) / 3600),
        m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

// Only the three PoE columns, rather than readStatus()'s twelve walks: the traffic counters
// and interface names it also fetches do not change meaningfully between samples, and at
// one sample every few seconds for days that difference is most of the SNMP traffic.
// A session per sample (as readStatus does) rather than one long-lived one, so a network
// blip costs a single sample instead of ending the run.
async function readPoeSample(o) {
    const session = snmp.createSession(o.host, o.community, { timeout: 5000, version: snmp.Version2c });
    try {
        const [stat, curr, pow] = await Promise.all([walkOid(session, OID.poeStatus), walkOid(session, OID.poeCurr), walkOid(session, OID.poePower)]);
        const out = {};
        for (const idx of Object.keys(curr))
            out[idx] = {
                code: stat[idx] != null ? Number(stat[idx]) : null,
                current_mA: curr[idx] != null ? Number(curr[idx]) : null,
                power_W: pow[idx] != null ? Number(pow[idx]) / 10 : null,
            };
        return out;
    } finally {
        session.close();
    }
}

// watch(opts) — sample PoE draw until interrupted, tracking per-port peaks.
//   opts.interval    seconds between samples          (default 5)
//   opts.report      seconds between periodic output  (default 60)
//   opts.summary     one line per report instead of the full table
//   opts.limitPort   per-port current limit, mA   — enables margin reporting
//   opts.limitTotal  whole-device current limit, mA — likewise
// The limits are a property of the hardware, not of RouterOS: the switch does not publish its
// own ratings over SNMP or the API, so they have to be supplied. Examples: CRS112 450mA/port
// and 1400mA total; RBOmniTikPG-5HacD 450mA/port and 2000mA total.
async function watch(opts = {}) {
    const o = resolveOpts(opts);
    const intervalMs = (opts.interval || WATCH_INTERVAL_DEFAULT) * 1000;
    const reportMs = (opts.report || WATCH_REPORT_DEFAULT) * 1000;
    const limitPort = opts.limitPort || 0;
    const limitTotal = opts.limitTotal || 0;
    const pct = (v, limit) => (limit ? ` ${Math.round((v / limit) * 100)}%` : '');

    // One full read up front for the port names: they do not change while running, so
    // re-walking ifName every sample would be pure overhead.
    const initial = await readStatus(o);
    const labels = {};
    // Port names carry the hardware after a '+' ("server-vader+rockpis0"); the role alone is
    // what identifies the line in a log, and keeps the summary narrow enough to stay one line.
    for (const p of initial.ports) if (p.poe) labels[p.ifIndex] = (p.name || `idx${p.ifIndex}`).split('+')[0].slice(0, 24);
    const order = Object.keys(labels)
        .map(Number)
        .sort((a, b) => a - b);
    if (!order.length) {
        console.error(`no PoE-delivering ports found on ${o.host}`);
        process.exit(1);
    }

    // Current and power peak independently rather than recording the power that happened to
    // accompany the peak current: the device reports power quantised to deci-watts and evidently
    // not sampled at the same instant, so the two do not reliably coincide.
    const peaks = {};
    for (const idx of order) peaks[idx] = { current_mA: 0, power_W: 0, atCurrent: null, atPower: null };
    // Total current is summed per sample, not from the per-port peaks: those peaks occur at
    // different moments, so adding them overstates what the device ever actually delivered at
    // once - which is the only figure the total rating can be judged against.
    let peakTotalW = 0,
        peakTotalAt = null,
        peakTotalMA = 0,
        peakTotalMAAt = null,
        warned = {};

    const started = Date.now();
    let samples = 0,
        errors = 0,
        lastError = null;

    console.log(`poe watch @ ${o.host} — sampling every ${intervalMs / 1000}s, reporting every ${reportMs / 1000}s`);
    console.log(`started ${watchStamp()}; peaks are high-water marks since then; Ctrl-C for a final summary\n`);

    const finalSummary = () => {
        console.log(`\n\n=== peaks after ${watchElapsed(Date.now() - started)} (${samples} samples, ${errors} errors) ===`);
        const head = ['Name', 'PeakCurr', 'at', 'PeakPower', 'at'];
        if (limitPort) head.push(`of ${limitPort}mA`, 'headroom');
        const rows = [head];
        for (const idx of order) {
            const row = [
                labels[idx],
                peaks[idx].current_mA ? `${peaks[idx].current_mA}mA` : '—',
                peaks[idx].atCurrent ? watchStamp(peaks[idx].atCurrent) : '—',
                peaks[idx].power_W ? `${peaks[idx].power_W.toFixed(1)}W` : '—',
                peaks[idx].atPower ? watchStamp(peaks[idx].atPower) : '—',
            ];
            if (limitPort) row.push(`${Math.round((peaks[idx].current_mA / limitPort) * 100)}%`, `${limitPort - peaks[idx].current_mA}mA`);
            rows.push(row);
        }
        const w = head.map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
        for (const r of rows) console.log(r.map((cell, c) => String(cell).padEnd(w[c])).join('  '));
        console.log(
            `\nPeak total draw: ${(peakTotalMA / 1000).toFixed(2)} A / ${peakTotalW.toFixed(1)} W${peakTotalMAAt ? ` at ${watchStamp(peakTotalMAAt)}` : ''}` +
                (limitTotal ? `\n  against the ${(limitTotal / 1000).toFixed(2)} A device limit: ${Math.round((peakTotalMA / limitTotal) * 100)}% used, ${((limitTotal - peakTotalMA) / 1000).toFixed(2)} A headroom` : '')
        );
        // The theoretical worst case: every port at its own peak at once. Those peaks fell at
        // different moments so this has not actually happened, but it is the number to size the
        // supply against — the observed peak only records what has coincided so far.
        const sumPeaks = order.reduce((a, idx) => a + peaks[idx].current_mA, 0);
        console.log(
            `\nTheoretical peak (every port at its own peak simultaneously): ${(sumPeaks / 1000).toFixed(2)} A` +
                (limitTotal ? `\n  against the ${(limitTotal / 1000).toFixed(2)} A device limit: ${Math.round((sumPeaks / limitTotal) * 100)}% used, ${((limitTotal - sumPeaks) / 1000).toFixed(2)} A headroom` : '')
        );
        if (lastError) console.log(`last error: ${lastError}`);
    };
    for (const sig of ['SIGINT', 'SIGTERM'])
        process.on(sig, () => {
            finalSummary();
            process.exit(0);
        });

    let nextReport = Date.now() + reportMs;
    for (;;) {
        const cycleStart = Date.now();
        try {
            const sample = await readPoeSample(o);
            samples++;
            const now = new Date();

            let totalW = 0,
                totalMA = 0;
            for (const idx of order) {
                const cur = sample[idx];
                if (!cur || cur.current_mA == null) continue;
                if (cur.power_W) totalW += cur.power_W;
                totalMA += cur.current_mA;
                // Called out once per port per crossing rather than every sample, so a port that
                // simply runs hot does not repeat the same warning for days.
                if (limitPort && cur.current_mA >= limitPort * WATCH_LIMIT_WARN_RATIO && !warned[idx]) {
                    warned[idx] = true;
                    console.log(`${watchStamp(now)}  ! ${labels[idx]} at ${cur.current_mA}mA — ${Math.round((cur.current_mA / limitPort) * 100)}% of the ${limitPort}mA port limit`);
                }
                if (cur.power_W && cur.power_W > peaks[idx].power_W) {
                    peaks[idx].power_W = cur.power_W;
                    peaks[idx].atPower = now;
                }
                if (cur.current_mA > peaks[idx].current_mA) {
                    const was = peaks[idx].current_mA;
                    peaks[idx].current_mA = cur.current_mA;
                    peaks[idx].atCurrent = now;
                    // Printed the moment it happens: this is the event the watch exists to catch,
                    // and at a slow report cadence it would otherwise surface up to a report later
                    // with no indication of when it actually occurred. Skipped for the first
                    // reading of each port, which is a baseline rather than a spike.
                    if (was > 0 && cur.current_mA >= was * WATCH_PEAK_NOTIFY_RATIO) console.log(`${watchStamp(now)}  * peak  ${labels[idx]}  ${cur.current_mA}mA (was ${was}mA)${cur.power_W ? `  ${cur.power_W.toFixed(1)}W` : ''}`);
                }
            }
            if (totalW > peakTotalW) {
                peakTotalW = totalW;
                peakTotalAt = now;
            }
            if (totalMA > peakTotalMA) {
                peakTotalMA = totalMA;
                peakTotalMAAt = now;
                if (limitTotal && totalMA >= limitTotal * WATCH_LIMIT_WARN_RATIO && !warned.total) {
                    warned.total = true;
                    console.log(`${watchStamp(now)}  ! total draw ${(totalMA / 1000).toFixed(2)}A — ${Math.round((totalMA / limitTotal) * 100)}% of the ${(limitTotal / 1000).toFixed(2)}A device limit`);
                }
            }

            if (Date.now() >= nextReport) {
                nextReport = Date.now() + reportMs;
                if (opts.summary) {
                    const parts = order.map((idx) => `${labels[idx]} ${sample[idx] && sample[idx].current_mA != null ? sample[idx].current_mA : '—'}/${peaks[idx].current_mA || '—'}mA${pct(peaks[idx].current_mA, limitPort)}`);
                    // Total in amps: the per-port rating is quoted in mA but the device rating is
                    // in amps (1.4A, 2A), so each is shown in the unit its limit is stated in.
                    const total = `${(totalMA / 1000).toFixed(2)}/${(peakTotalMA / 1000).toFixed(2)}A${pct(peakTotalMA, limitTotal)} ${totalW.toFixed(1)}W`;
                    // ...and the theoretical worst case alongside it: every port simultaneously at
                    // its own observed peak. That has not happened (the peaks fell at different
                    // moments) and may never, but it is the figure to size the supply against,
                    // whereas the observed peak only says what has coincided so far.
                    const theoretical = order.reduce((sum, idx) => sum + peaks[idx].current_mA, 0);
                    const theor = `theor ${(theoretical / 1000).toFixed(2)}A${pct(theoretical, limitTotal)}`;
                    console.log(`${watchStamp(now)}  total ${total}  ${theor}  |  ${parts.join('  ')}${errors ? `  [${errors} errors]` : ''}`);
                } else {
                    printStatusTable(await readStatus(o), peaks);
                    console.log('');
                }
            }
        } catch (e) {
            errors++;
            lastError = `${watchStamp()} ${e.message}`;
            // A switch reboot or a dropped packet must not end a multi-day run, so failures are
            // counted and carried rather than thrown; the count surfaces in every summary line.
            if (errors === 1 || errors % 20 === 0) console.log(`${watchStamp()}  ! sample failed (${errors} so far): ${e.message}`);
        }
        // Interval measured from the start of the cycle, so a slow sample does not make the
        // effective period drift outwards over a long run.
        await new Promise((r) => setTimeout(r, Math.max(0, intervalMs - (Date.now() - cycleStart))));
    }
}

async function cli() {
    // Flags are pulled out first so they may appear anywhere, leaving the positional
    // arguments the other commands already expect untouched.
    const argv = process.argv.slice(2);
    const flag = (name) => {
        const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
        if (i < 0) return undefined;
        const a = argv.splice(i, 1)[0];
        return a.includes('=') ? a.slice(a.indexOf('=') + 1) : true;
    };
    const watchOpts = {
        summary: flag('summary') !== undefined,
        interval: Number(flag('interval')) || undefined,
        report: Number(flag('report')) || undefined,
        limitPort: Number(flag('limit-port')) || undefined,
        limitTotal: Number(flag('limit-total')) || undefined,
    };
    const wantWatch = flag('watch') !== undefined;

    const [cmd, portArg, secArg] = argv;
    if (wantWatch) return watch(watchOpts);
    switch (cmd || 'status') {
        case 'watch':
            return watch(watchOpts);
        case 'status':
        case 'read':
            return printStatusTable(await readStatus());
        case 'json':
            return console.log(JSON.stringify(await readStatus(), null, 2));
        case 'off':
            return console.log(JSON.stringify(await poeOff(portArg)));
        case 'on':
            return console.log(JSON.stringify(await poeOn(portArg)));
        case 'cycle': {
            const secs = secArg ? parseInt(secArg, 10) : 10;
            console.log(`cycling "${portArg}": poe-out=off, waiting ${secs}s, then auto-on...`);
            return console.log(JSON.stringify(await poeCycle(portArg, secs)));
        }
        case 'disable':
            return console.log(JSON.stringify(await portDisable(portArg)));
        case 'enable':
            return console.log(JSON.stringify(await portEnable(portArg)));
        case 'setup': {
            const [, newUser, newPass, addr] = process.argv.slice(2);
            if (!newUser || !newPass) {
                console.error('usage: setup <user> <pass> [allowed-address]   (admin creds via ROUTEROS_USER/PASS)');
                process.exit(1);
            }
            return console.log(JSON.stringify(await setupUser(newUser, newPass, addr ? { address: addr } : {})));
        }
        case 'help':
        case '-h':
        case '--help':
            return console.log(HELP);
        default:
            console.error(`unknown command "${cmd}"\n`);
            console.error(HELP);
            process.exit(1);
    }
}

if (require.main === module)
    cli().catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
    });
