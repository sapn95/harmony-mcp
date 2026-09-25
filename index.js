#!/usr/bin/env node
// harmony-mcp — MCP server for a Logitech Harmony Hub (https://support.myharmony.com)
// on the local network: list activities and devices, start an activity, and
// send individual IR commands, over the hub's own WebSocket API on port 8088.
//
// No Logitech cloud, no account, no internet. The hub is provisioned once with
// the Harmony app and answers on the LAN for ever after; the cloud API it was
// originally built against has been shut down, and the XMPP interface was
// removed in firmware 4.15.206. What is left is the WebSocket interface this
// server speaks, which is the same one the Harmony web remote uses.
//
// Auth: there is none, and that is the hub's design rather than an omission
// here. Anything that can reach port 8088 can drive every device in the room —
// no token, no password, no pairing. So there is also nothing for this server
// to hold, cache or leak, and no keychain entry that is a credential. What it
// does need is the hub's address in HARMONY_HUB_HOST; the remote id the hub
// hands out itself, and this server asks for it when it is not configured.
//
// Safety: nothing this API does is irreversible, so no tool is gated behind
// confirm:true. That is a finding about the hub and not a gap — an activity can
// be started again, a power-off IS an activity (id -1), and an IR command is a
// keypress. The things the sibling servers gate (money, the post, a delete with
// no undo) have no counterpart here, and a decorative gate on a reversible
// action is how a real one gets clicked through.
//
// What does need saying is the opposite problem, and every result that sends a
// code says it: an IR command is FIRE AND FORGET. The hub reports that it
// emitted the code, never that the equipment in front of it reacted. A speaker
// system on the wrong input, a TV that is already off, a blocked emitter and a
// device that was unplugged this morning all look exactly like success from
// here. The one thing this server can check on the caller's behalf is that the
// command and the device exist in the hub's own configuration, and it does.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Name and version come from package.json, never from a second copy here:
// `npm version` only bumps package.json, so a hardcoded string silently
// advertises a stale version to every client.
const PKG = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// stdio is spelled out because execFileSync hands the child's stderr straight to
// ours by default, and `security` writes a line to stderr for every entry it
// cannot find. A machine that keeps the host in a client config rather than the
// keychain would otherwise print "SecKeychainSearchCopyNext: The specified item
// could not be found" on a perfectly healthy start, which a client shows as a
// server error. The exit code is all we ever wanted from it.
function keychain(service) {
  try {
    return execFileSync('security', ['find-generic-password', '-a', 'harmony', '-s', service, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

// A variable that is *set* wins, even when it is empty. Written as
// `process.env.X || keychain(...)` an empty variable falls through to the login
// keychain, so a test run or a container that deliberately blanks a value
// silently talks to the real hub in the real living room instead of failing.
const envOrKeychain = (name, service) =>
  (process.env[name] !== undefined ? process.env[name] : keychain(service)).trim();

const HOST = envOrKeychain('HARMONY_HUB_HOST', 'harmony-mcp-host');
const CONFIGURED_REMOTE = envOrKeychain('HARMONY_HUB_REMOTE_ID', 'harmony-mcp-remote-id');
const PORT = envOrKeychain('HARMONY_HUB_PORT', 'harmony-mcp-port') || '8088';

// The host goes into a URL, and a URL is not a string. `HARMONY_HUB_HOST` is
// read from a client config file that a model can be talked into writing, and
// three shapes of it send this server's requests somewhere else entirely:
//
//   a@evil.example.com   — everything before the @ is userinfo, so the request
//                          goes to evil.example.com and the "host" is a login
//   hub.local/../x       — a path, which resolves away and addresses another
//                          endpoint on the same host
//   hub.local:8088?x=1   — a query string smuggled into the authority
//
// So the host is a hostname or an IP literal and nothing else, checked here
// rather than trusted and interpolated. A bracketed IPv6 literal is allowed
// because that is the only legal way to write one in an authority.
const HOSTNAME = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;
const IPV6 = /^\[[0-9A-Fa-f:.]{2,45}\]$/;
function authority() {
  if (!HOST) throw new Error('HARMONY_HUB_HOST ist nicht gesetzt (env oder Keychain harmony-mcp-host) — ohne Adresse ist kein Hub erreichbar.');
  if (!HOSTNAME.test(HOST) && !IPV6.test(HOST)) {
    throw new Error(`HARMONY_HUB_HOST ist kein Hostname und keine IP: ${JSON.stringify(HOST).slice(0, 60)}`);
  }
  // Same reasoning one field along: a port that is not a number would carry
  // whatever follows it into the authority.
  if (!/^\d{1,5}$/.test(PORT) || Number(PORT) < 1 || Number(PORT) > 65535) {
    throw new Error(`HARMONY_HUB_PORT ist kein Port: ${JSON.stringify(PORT).slice(0, 20)}`);
  }
  return `${HOST}:${PORT}`;
}

// Every request is bounded, so a hub that has been unplugged fails the tool call
// instead of hanging the client for ever. Starting an activity is deliberately
// far more generous than the rest: the hub walks a sequence of IR commands with
// deliberate gaps between them — switching an amplifier's input and waiting for
// a projector to strike a lamp is routinely fifteen seconds — and a budget cut
// to fit a config fetch would report every slow activity as a failure it is not.
//
// Both are overridable, and not only so the suite can prove the timeout path
// without waiting three quarters of a minute for it: a hub reached over
// powerline or mesh Wi-Fi genuinely is slower than one on the same switch, and
// the alternative to a knob here is a reader editing the source. A value that is
// not a positive number falls back rather than turning a budget into NaN, which
// AbortSignal.timeout treats as "immediately".
const ms = (name, dflt) => {
  const v = Math.trunc(Number(process.env[name]));
  return Number.isFinite(v) && v > 0 ? v : dflt;
};
const TIMEOUT_MS = ms('HARMONY_TIMEOUT_MS', 10000);
const ACTIVITY_TIMEOUT_MS = ms('HARMONY_ACTIVITY_TIMEOUT_MS', 45000);

// Truncate the far end's prose before it goes into a tool result. There is no
// credential in this server to strip out of it, which is why there is no
// redactor beside this — the hub has nothing to authenticate with.
const excerpt = (s, n) => String(s ?? '').slice(0, n);

// The hub identifies itself by a "remote id", which is not secret and not a
// credential: it is the serial-number-shaped string the WebSocket URL is keyed
// by, and the hub hands it to anybody who asks over plain HTTP. Discovered once
// and remembered, and — like the socket — asked for only once even when several
// tool calls arrive together.
//
// Origin is required and its value is not ours to choose: the hub checks it and
// answers nothing without it. sl.dhg.myharmony.com is what the Harmony web
// remote sends, and the hub does not resolve it or reach it — it is a string
// comparison against a host that no longer serves anything.
const PROVISION_ORIGIN = 'http://sl.dhg.myharmony.com';
let discovered = null;
let pendingRemote = null;
function hubSaysId() {
  if (discovered) return Promise.resolve(discovered);
  pendingRemote ??= provision().finally(() => { pendingRemote = null; });
  return pendingRemote;
}
// The hub is asked which id it has even when one is configured. Skipping the
// round trip in that case was the obvious saving and it cost the one thing that
// makes the variable safe: something to be wrong against. A stale or mistyped
// HARMONY_HUB_REMOTE_ID was then reported by harmony_status as the active id,
// while every call after it failed on a socket the hub closes without a word —
// a confident answer sending the reader to the network instead of the setting.
//
// So the configured value overrides WHICH id is used, not whether we learn which
// one the hub thinks it has. And a provisioning endpoint that is down must not
// take out a server that was told the id outright, so that failure is swallowed
// here and surfaces in harmony_status, which is the tool whose job it is.
const remoteId = async () => {
  if (!CONFIGURED_REMOTE) return hubSaysId();
  try { await hubSaysId(); } catch { /* harmony_status reports it; not fatal */ }
  return CONFIGURED_REMOTE;
};
async function provision() {
  let r;
  try {
    r = await fetch(`http://${authority()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'utf-8', Origin: PROVISION_ORIGIN },
      body: JSON.stringify({ id: 1, cmd: 'setup.account?getProvisionInfo', params: {} }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // Keep the original as `cause`: the friendly message says what failed, the
    // cause still says why, which is what is needed when debugging a LAN that
    // has a hub on a different subnet.
    if (e?.name === 'TimeoutError') throw new Error(`Hub ${authority()} antwortet nicht (${TIMEOUT_MS / 1000}s).`, { cause: e });
    throw new Error(`Hub ${authority()} nicht erreichbar: ${e?.message || String(e)}`, { cause: e });
  }
  if (!r.ok) throw new Error(`Provisioning → ${r.status}: ${excerpt(await r.text(), 300)}`);
  const j = await r.json().catch(() => null);
  const id = j?.data?.activeRemoteId;
  // The provisioning answer also carries the Logitech account's e-mail address,
  // which is why only this one field is ever read out of it and the body is
  // never forwarded to a tool result.
  if (typeof id !== 'string' || !id) throw new Error('Provisioning-Antwort ohne activeRemoteId.');
  discovered = id;
  return id;
}

// One WebSocket per tool call, opened here and closed in the caller's finally.
//
// Not one shared socket for the process, and that is deliberate. The hub drops
// an idle connection after 60 seconds, so a long-lived socket needs a keepalive
// ping, a reconnect path, and a decision about what to do with a call that
// arrives during the gap — three mechanisms whose failure mode is a tool that
// works when used often and fails when used once an hour, which is exactly how
// this server will be used. A handshake on a LAN costs a few milliseconds. The
// config is re-read per call for the same reason: a cache would go stale the
// moment a device is added in the Harmony app, and "the hub does not have that
// command" is a far worse answer when it is wrong.
async function openHub() {
  const id = await remoteId();
  const url = `ws://${authority()}/?domain=svcs.myharmony.com&hubId=${encodeURIComponent(id)}`;
  const ws = new WebSocket(url);
  const pending = new Map();
  const waiters = new Map();
  let closed = null;

  // Whether the hub has ever said anything on this socket. It decides how a
  // close is reported — see closedBy.
  let served = false;
  ws.addEventListener('message', ev => {
    let m;
    try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
    // Any message at all, matched or not: a socket that has been spoken on is a
    // socket that works, whatever it does next.
    served = true;
    // Two shapes arrive on this socket. An answer to something we asked carries
    // back the id we sent. A notification carries a `type` and no id at all —
    // and the one that matters most, startActivityFinished, is of the second
    // kind, so a client that only ever matched on id waited out its whole
    // timeout on an activity that had already started.
    const key = m?.id == null ? null : String(m.id);
    const settle = key != null && pending.get(key);
    if (settle) { pending.delete(key); settle(m); return; }
    const waiting = m?.type && waiters.get(m.type);
    if (waiting) { waiters.delete(m.type); waiting(m); }
  });
  // A hub handed a remote id it does not know accepts the TCP connection, lets
  // the upgrade complete, and only then closes with 1008. The handshake has
  // already resolved by that point, so the "stimmt die remote id?" hint below
  // was attached to a branch that only fires when the close beats the open — and
  // against a real hub it does not. What actually came back was a bare
  // "Verbindung geschlossen (1008)", which says nothing about what to change.
  //
  // Which side of the open the close lands on is a race and not a diagnosis, so
  // the hint hangs off the thing that is actually diagnostic: whether the hub
  // ever said a word before hanging up. It never does when the id is wrong.
  const closedBy = reason => {
    closed ??= served ? reason : `${reason} — und zwar bevor der Hub überhaupt geantwortet hat; stimmt die remote id?`;
    for (const f of [...pending.values(), ...waiters.values()]) f(null);
    pending.clear(); waiters.clear();
  };
  ws.addEventListener('close', ev => { closedBy(`Verbindung geschlossen (${ev.code})`); });
  // An error event carries no usable detail in the WHATWG interface, so the
  // close that follows it is what gets reported. Registered all the same,
  // because an unhandled 'error' on this target is otherwise an exception with
  // no tool call attached to it.
  ws.addEventListener('error', () => { closedBy('Verbindungsfehler'); });

  await new Promise((resolve, reject) => {
    // The socket is closed on the way out of a failed handshake. withHub only
    // closes what openHub returned, so a rejection here left a half-open socket
    // behind with nothing holding a reference to it — one per failed call, for
    // as long as the process runs.
    const t = setTimeout(() => {
      try { ws.close(); } catch { /* never opened */ }
      reject(new Error(`Hub ${authority()} nimmt keine WebSocket-Verbindung an (${TIMEOUT_MS / 1000}s).`));
    }, TIMEOUT_MS);
    t.unref?.();
    ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener('close', ev => { clearTimeout(t); reject(new Error(`Hub ${authority()} hat die Verbindung sofort geschlossen (${ev.code}) — stimmt die remote id?`)); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(t); reject(new Error(`Hub ${authority()} nicht erreichbar auf dem WebSocket.`)); }, { once: true });
  });

  let seq = 0;
  // `notify` names a notification type to settle on instead of an id, which is
  // how startactivity is awaited.
  const request = (cmd, params, { notify, timeout = TIMEOUT_MS } = {}) => {
    if (closed) return Promise.reject(new Error(closed));
    const key = String(++seq);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(key);
        if (notify) waiters.delete(notify);
        reject(new Error(`${cmd}: Zeitüberschreitung nach ${timeout / 1000}s.`));
      }, timeout);
      t.unref?.();
      // A null hands back the socket dying rather than an answer, which is the
      // difference between "the hub said no" and "the hub went away" — and the
      // second one must not be reported as the first.
      const done = m => { clearTimeout(t); if (m === null) reject(new Error(closed || 'Verbindung verloren')); else resolve(m); };
      if (notify) waiters.set(notify, done); else pending.set(key, done);
      ws.send(JSON.stringify({ hubId: id, timeout: 60, hbus: { cmd, id: key, params: params || {} } }));
    });
  };
  // holdAction is the one command the hub never answers: it replies with an
  // unrelated `harmonyengine.metadata?notify` carrying no id, so there is
  // nothing for request() to match and it waited out its whole budget on every
  // single keypress. A tap became twenty seconds and a repeat of three timed the
  // tool call out. That is not a quirk to work around either — it is the wire
  // telling us what the header comment says, that IR has no return path.
  const send = (cmd, params) => {
    if (closed) throw new Error(closed);
    ws.send(JSON.stringify({ hubId: id, timeout: 60, hbus: { cmd, id: String(++seq), params: params || {} } }));
  };
  // close() queues the close frame behind whatever is still buffered, but a
  // socket torn down in the caller's finally on the same tick as the last send
  // raced it: the release frame of the final keypress never left, which the hub
  // reads as a button still being held and which swallows the NEXT command sent
  // to that device. So the buffer is drained before the finally gets there.
  const drain = async (ms = 2000) => {
    const until = Date.now() + ms;
    while (ws.bufferedAmount > 0 && Date.now() < until) {
      await new Promise(r => { setTimeout(r, 10).unref?.(); });
    }
  };
  return { remoteId: id, request, send, drain, close: () => { try { ws.close(); } catch { /* already gone */ } } };
}

async function withHub(fn) {
  const hub = await openHub();
  try { return await fn(hub); } finally { hub.close(); }
}

// The hub answers `code` as 200 the number on one command and "200" the string
// on another, so it is compared loosely on purpose. A comparison that insisted
// on one of the two reported every second command as an error.
const ok = m => String(m?.code ?? '') === '200';
const ENGINE = 'vnd.logitech.harmony/vnd.logitech.harmony.engine';

async function config(hub) {
  const m = await hub.request(`${ENGINE}?config`, { verb: 'get' });
  if (!ok(m)) throw new Error(`Konfiguration nicht lesbar: ${excerpt(m?.msg, 120)} (code ${m?.code})`);
  return { activities: m.data?.activity || [], devices: m.data?.device || [] };
}

// -1 is not a sentinel this server invented: it is the activity id the hub uses
// for "everything off", and it comes back from getCurrentActivity as the answer
// meaning nothing is running.
const POWER_OFF = '-1';
const activityRow = (a, current) => ({ id: String(a?.id), label: a?.label, ...(String(a?.id) === current ? { current: true } : {}) });
const deviceRow = d => ({ id: String(d?.id), label: d?.label, type: d?.type, manufacturer: d?.manufacturer, model: d?.model });
// A device's commands are two levels down, grouped by the part of the remote
// they sit on — the flattening is what makes them addressable by name.
const commandsOf = d => (d?.controlGroup || []).flatMap(g => (g?.function || []).map(f => ({ name: f?.name, label: f?.label, group: g?.name })));

async function currentActivity(hub) {
  const m = await hub.request(`${ENGINE}?getCurrentActivity`, { verb: 'get' });
  if (!ok(m)) throw new Error(`Aktuelle Aktivität nicht lesbar: ${excerpt(m?.msg, 120)} (code ${m?.code})`);
  return String(m.data?.result ?? POWER_OFF);
}

// Ids go into a JSON payload the hub parses and into no path, so the danger here
// is not traversal — it is a caller addressing something that does not exist and
// being told it worked. Both ids are therefore checked against the hub's own
// configuration at the point of use; this only rejects the shapes that cannot be
// an id at all, so an obvious mistake fails before a socket is opened.
const ID = /^-?[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
function hubId(what, v) {
  const s = String(v ?? '');
  if (!ID.test(s)) throw new Error(`Ungültige ${what}: ${JSON.stringify(s).slice(0, 60)}`);
  return s;
}

// The schema says number, but nothing enforces a schema on the way in. Both of
// these end up in a payload that drives a physical emitter, and a repeat of
// 100000 is a wedged hub rather than a loud television.
const clamp = (v, lo, hi, dflt) => Math.min(hi, Math.max(lo, Math.trunc(Number(v)) || dflt));

const IR_NOT_CONFIRMED = 'Der Hub bestätigt nur, dass er den Code gesendet hat — nicht, dass das Gerät reagiert hat. IR ist ohne Rückkanal.';

const TOOLS = [
  { name: 'harmony_status', description: 'Verify the hub is reachable and show its address, remote id, firmware and the activity that is currently running.', inputSchema: { type: 'object', properties: {} } },
  { name: 'harmony_list_activities', description: 'List the activities configured on the hub (id and label), marking the one that is currently running.', inputSchema: { type: 'object', properties: {} } },
  { name: 'harmony_list_devices', description: 'List the devices the hub can control (id, label, manufacturer, model).', inputSchema: { type: 'object', properties: {} } },
  { name: 'harmony_list_commands', description: 'List the IR commands the hub knows for one device — the names harmony_send_command accepts.', inputSchema: { type: 'object', properties: { device_id: { type: 'string', description: 'device id from harmony_list_devices' } }, required: ['device_id'] } },
  { name: 'harmony_current_activity', description: 'Show which activity is running right now, or that everything is off.', inputSchema: { type: 'object', properties: {} } },
  { name: 'harmony_start_activity', description: 'Start an activity, which switches every device it covers to the right input. Waits for the hub to report the activity finished starting.', inputSchema: { type: 'object', properties: { activity_id: { type: 'string', description: 'activity id from harmony_list_activities' } }, required: ['activity_id'] } },
  { name: 'harmony_power_off', description: 'Turn everything off, which on a Harmony Hub is the activity with id -1. Reversible: start any activity to come back.', inputSchema: { type: 'object', properties: {} } },
  { name: 'harmony_send_command', description: 'Send one IR command to one device, e.g. VolumeUp or InputHdmi2. The command must be one harmony_list_commands reports for that device. Fire and forget: the hub confirms it emitted the code, never that the device reacted.', inputSchema: { type: 'object', properties: { device_id: { type: 'string', description: 'device id from harmony_list_devices' }, command: { type: 'string', description: 'command name from harmony_list_commands' }, hold_ms: { type: 'number', description: 'how long to hold the button, 0-5000 (default 0 = a tap)' }, repeat: { type: 'number', description: 'how many times to send it, 1-10 (default 1)' } }, required: ['device_id', 'command'] } },
];

const server = new Server({ name: PKG.name, version: PKG.version }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args = {} } = req.params;
  const text = s => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 1) }] });
  try {
    // Before anything opens a socket: an unknown name is a client bug, and
    // discovering a remote id for it both lies with isError:false and sends a
    // request to the hub on behalf of a call that was never valid.
    if (!TOOLS.some(t => t.name === name)) throw new Error(`unknown tool ${name}`);
    // Every tool that names a device or an activity puts the id through here,
    // once, before a socket exists.
    const did = args.device_id === undefined ? undefined : hubId('device_id', args.device_id);
    const aid = args.activity_id === undefined ? undefined : hubId('activity_id', args.activity_id);

    // `required` in a schema is a hint to the client, not a check. Without a
    // guard, a call that simply left the argument out got as far as opening a
    // socket and reading the whole configuration, only to complain about an id of
    // `undefined` — a sentence naming no fix, arrived at down the expensive path.
    //
    // Each of these is checked INSIDE its own branch rather than up here, which
    // matters for a reason that is not obvious: the smoke test proves every
    // advertised tool reaches a branch by calling it with no arguments at all and
    // asserting the answer is not "unknown tool". Answered up front, a tool whose
    // branch had been deleted would still be answered by the guard, and that
    // check would stay green while the tool no longer existed.
    const needs = (missing, lister) => text({ error: `${missing} fehlt — ${lister} nennt die möglichen Werte.` });

    if (name === 'harmony_status') {
      // The one tool that must work when nothing else does, so it reports what
      // it found rather than throwing on the first surprise.
      const id = await remoteId();
      return await withHub(async hub => {
        const { activities, devices } = await config(hub);
        const current = await currentActivity(hub);
        const running = activities.find(a => String(a?.id) === current);
        // A configured remote id was reported as correct without ever being
        // checked, which is a confident false answer: the socket opens against
        // whatever was configured, and a hub that rejects it closes the
        // connection immediately with no explanation. Asking the hub what it
        // thinks its id is costs one HTTP round trip and turns that into a
        // sentence naming the variable to fix.
        //
        // Three cases, and the third one used to be silent. Either the hub
        // agrees with what was configured, or it does not and that is the
        // warning worth having — or it could not be asked at all, which
        // remoteId() deliberately swallows so that a broken provisioning
        // endpoint does not disable a server that was handed the id. Swallowed
        // there means reported here, or it is not reported anywhere.
        const mismatch = !CONFIGURED_REMOTE ? {}
          : !discovered ? { warning: `HARMONY_HUB_REMOTE_ID ist gesetzt, aber der Hub liess sich nicht danach fragen — ${authority()} antwortet auf dem Provisioning-Endpunkt nicht.` }
            : discovered !== CONFIGURED_REMOTE ? { warning: `HARMONY_HUB_REMOTE_ID ist ${CONFIGURED_REMOTE}, der Hub nennt sich aber ${discovered}` }
              : {};
        let firmware;
        // Best effort, and it stays best effort: sysinfo is the one command in
        // this server that some firmware answers and some does not, and a hub
        // that will not talk about itself is still a working hub. Reporting the
        // whole status as broken over a missing version string would take the
        // one diagnostic tool out of service for a cosmetic field.
        try {
          const m = await hub.request('connect.sysinfo?get', {});
          if (ok(m)) firmware = m.data?.fw_ver;
        } catch { /* older or newer firmware, not a failure */ }
        return text({
          hub: authority(), remote_id: id, ...(firmware ? { firmware } : {}), ...mismatch,
          activities: activities.length, devices: devices.length,
          current_activity: current === POWER_OFF ? null : { id: current, label: running?.label },
          ...(current !== POWER_OFF && !running ? { note: `Der Hub meldet Aktivität ${current}, die in seiner eigenen Konfiguration nicht vorkommt.` } : {}),
        });
      });
    }

    if (name === 'harmony_list_activities') {
      return await withHub(async hub => {
        const { activities } = await config(hub);
        const current = await currentActivity(hub);
        return text({ activities: activities.map(a => activityRow(a, current)) });
      });
    }

    if (name === 'harmony_list_devices') {
      return await withHub(async hub => text({ devices: (await config(hub)).devices.map(deviceRow) }));
    }

    if (name === 'harmony_list_commands') {
      if (did === undefined) return needs('device_id', 'harmony_list_devices');
      return await withHub(async hub => {
        // Read once. Fetching the config a second time to build the error list
        // was a second round trip on the path that had already gone wrong.
        const { devices } = await config(hub);
        const device = devices.find(d => String(d?.id) === did);
        // Naming the alternatives, because a device id is an opaque eight-digit
        // number and the usual mistake is reaching for the wrong one of two
        // televisions rather than inventing a number outright.
        if (!device) return text({ error: `Kein Gerät mit device_id ${did}`, devices: devices.map(deviceRow) });
        return text({ device: deviceRow(device), commands: commandsOf(device) });
      });
    }

    if (name === 'harmony_current_activity') {
      return await withHub(async hub => {
        const current = await currentActivity(hub);
        if (current === POWER_OFF) return text({ current_activity: null, note: 'Alles aus.' });
        const running = (await config(hub)).activities.find(a => String(a?.id) === current);
        return text({ current_activity: { id: current, label: running?.label } });
      });
    }

    if (name === 'harmony_start_activity' || name === 'harmony_power_off') {
      if (name === 'harmony_start_activity' && aid === undefined) return needs('activity_id', 'harmony_list_activities');
      const wanted = name === 'harmony_power_off' ? POWER_OFF : aid;
      return await withHub(async hub => {
        // Checked against the hub's own list first. An unknown id is accepted by
        // the hub without complaint and simply never finishes, so the call sat
        // out its whole 45-second budget and then reported a timeout — which
        // reads as a slow hub and sends the reader to the network, not to the
        // typo in the id.
        const { activities } = await config(hub);
        if (wanted !== POWER_OFF && !activities.some(a => String(a?.id) === wanted)) {
          return text({ error: `Keine Aktivität mit activity_id ${wanted}`, activities: activities.map(a => activityRow(a, '')) });
        }
        const m = await hub.request(`${ENGINE}?startactivity`, {
          async: 'true', timestamp: 0, args: { rule: 'start' }, activityId: wanted,
        }, { notify: `${ENGINE}?startActivityFinished`, timeout: ACTIVITY_TIMEOUT_MS });
        const code = m?.data?.errorCode;
        const label = activities.find(a => String(a?.id) === wanted)?.label;
        // The notification carries its own result, and it is not the same thing
        // as the request having been accepted: a hub that cannot reach one
        // device in the activity finishes with a non-200 and leaves the room
        // half switched. Reporting "started" off the back of the send was a
        // statement about the physical world that nobody had checked.
        if (code != null && String(code) !== '200') {
          return text({ started: false, activity: { id: wanted, label }, error: `Hub meldet ${code}: ${excerpt(m?.data?.errorString, 200)}` });
        }
        return text({ started: true, activity: wanted === POWER_OFF ? { id: POWER_OFF, label: 'PowerOff' } : { id: wanted, label } });
      });
    }

    if (name === 'harmony_send_command') {
      if (did === undefined) return needs('device_id', 'harmony_list_devices');
      if (!String(args.command ?? '').trim()) return needs('command', 'harmony_list_commands');
      const command = String(args.command ?? '');
      const holdMs = clamp(args.hold_ms, 0, 5000, 0);
      const repeat = clamp(args.repeat, 1, 10, 1);
      return await withHub(async hub => {
        const { devices } = await config(hub);
        const device = devices.find(d => String(d?.id) === did);
        if (!device) return text({ error: `Kein Gerät mit device_id ${did}`, devices: devices.map(deviceRow) });
        const known = commandsOf(device);
        // The only check this server can make before the code leaves the
        // emitter, and the reason it is worth making: a misspelt command is
        // emitted as nothing at all and answered with the same empty notify as
        // a real one, so "Volumeup" instead of "VolumeUp" came back as a
        // success and the room stayed quiet.
        if (!known.some(c => c.name === command)) {
          return text({ error: `Gerät ${device.label} kennt kein Kommando ${JSON.stringify(command).slice(0, 60)}`, commands: known.map(c => c.name) });
        }
        // The action is a JSON document inside a JSON string — the hub parses
        // the outer message, then parses this field again. Built with
        // JSON.stringify rather than by hand: a device label with a quote in it
        // used to break out of the inner document.
        const action = JSON.stringify({ command, type: 'IRCommand', deviceId: did });
        // send, not request: holdAction is never answered. See the note on
        // send() — awaiting it burned the full timeout per keypress.
        for (let i = 0; i < repeat; i++) {
          hub.send(`${ENGINE}?holdAction`, { status: 'press', timestamp: '0', verb: 'render', action });
          // A tap is press-then-release with nothing in between; a hold is the
          // same pair with the gap the caller asked for. The release is not
          // optional — without it the hub keeps the virtual button down and the
          // next command to that device is swallowed.
          if (holdMs > 0) await new Promise(r => { setTimeout(r, holdMs).unref?.(); });
          hub.send(`${ENGINE}?holdAction`, { status: 'release', timestamp: String(holdMs), verb: 'render', action });
        }
        await hub.drain();
        return text({ emitted: { command, device: device.label, repeat, ...(holdMs ? { hold_ms: holdMs } : {}) }, confirmed: false, note: IR_NOT_CONFIRMED });
      });
    }

    // Advertised, and it reached the bottom of the chain, so nothing handles it.
    // Falling off the end returned undefined, which the client reads as a
    // successful call with no content: asking to turn the room off was answered,
    // cheerfully and with isError:false, by nothing at all.
    throw new Error(`unknown tool ${name}`);
  } catch (e) {
    return { content: [{ type: 'text', text: 'ERROR: ' + (e.message || String(e)) }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
