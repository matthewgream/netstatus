//
// devices-known.js — resolve a MAC address to the name it is filed under in
// devices-known.conf, shared by the per-vendor wifi tools.
//
// The registration/station tables these tools read identify clients only by MAC,
// so the names have to come from somewhere; devices-known.conf is the list the
// scanner and notifier already maintain, and reusing it means one place to edit
// rather than a second list that quietly drifts out of step.
//
//   Environment:
//     DEVICES_KNOWN   path to devices-known.conf  (default /opt/ostratakenebranna/devices/devices-known.conf)
//

const fs = require('fs');
const path = require('path');

// The scanner's own list, in the branna repo: these tools moved out of it into /opt/netstatus, so the
// path is absolute rather than a sibling of this file.
const KNOWN_DEFAULT = '/opt/ostratakenebranna/devices/devices-known.conf';

// Format: MAC,NAME,NOTES[,FLAGS]. Parsed exactly as devices-notifier.js parses it so the
// tools agree on what the file means: '#' lines are skipped (which is how an entry is
// disabled, so a commented-out device must NOT resolve), MACs are lowercased, and a line
// whose first field is not a MAC is ignored rather than trusted.
function loadKnownDevices(filename = process.env.DEVICES_KNOWN || KNOWN_DEFAULT) {
    const known = new Map();
    let text;
    try {
        text = fs.readFileSync(filename, 'utf8');
    } catch {
        return known; // absent or unreadable: callers fall back to bare MACs rather than failing
    }
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const firstComma = line.indexOf(',');
        if (firstComma < 0) continue;
        const secondComma = line.indexOf(',', firstComma + 1);
        const mac = line.substring(0, firstComma).trim().toLowerCase();
        if (!/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/.test(mac)) continue;
        const name = (secondComma < 0 ? line.substring(firstComma + 1) : line.substring(firstComma + 1, secondComma)).trim();
        if (name) known.set(mac, name);
    }
    return known;
}

// The name alone, or '-' — for a table with its own Name column.
function nameFor(mac, known) {
    return (mac && known.get(mac.toLowerCase())) || '-';
}

// "name (mac)" when known, the bare MAC otherwise — for a heading, where there is room.
function macLabel(mac, known) {
    if (!mac) return '-';
    const name = known.get(mac.toLowerCase());
    return name ? `${name} (${mac})` : mac;
}

module.exports = { loadKnownDevices, nameFor, macLabel, KNOWN_DEFAULT };
