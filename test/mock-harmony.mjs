// An in-process stand-in for a Harmony Hub: the provisioning endpoint over HTTP
// and the command interface over WebSocket, both on one port, exactly as the
// real hub serves them.
//
// Every fixture value is obviously synthetic and named Example_*. That is not
// decoration: scripts/hygiene.mjs scans the tracked files of this public repo
// for anything that looks like a real person's detail, and a fixture must not be
// the thing the gate exists to catch. The provisioning answer in particular
// carries a Logitech account e-mail on a real hub, so the one here is at
// example.com — a domain RFC 2606 guarantees cannot resolve.
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const ENGINE = 'vnd.logitech.harmony/vnd.logitech.harmony.engine';

// Shaped like a real config, down to `-1` being a listed activity called
// PowerOff — the hub really does put it in the list, which is why the power-off
// tool does not have to special-case its absence.
const CONFIG = () => ({
  activity: [
    { id: '-1', label: 'PowerOff' },
    { id: '10000001', label: 'Example_WatchTV' },
    { id: '10000002', label: 'Example_ListenToMusic' },
  ],
  device: [
    {
      id: '20000001', label: 'Example_TV', type: 'Television',
      manufacturer: 'Example_Maker', model: 'Example_Model_A',
      controlGroup: [
        { name: 'Power', function: [{ name: 'PowerToggle', label: 'Power' }] },
        {
          name: 'Volume',
          function: [
            { name: 'VolumeUp', label: 'Vol +' },
            { name: 'VolumeDown', label: 'Vol -' },
            { name: 'Mute', label: 'Mute' },
          ],
        },
        { name: 'Input', function: [{ name: 'InputHdmi1', label: 'HDMI 1' }, { name: 'InputHdmi2', label: 'HDMI 2' }] },
      ],
    },
    {
      id: '20000002', label: 'Example_Speakers', type: 'AV Receiver',
      manufacturer: 'Example_Maker', model: 'Example_Model_B',
      // Deliberately one group only, and deliberately no VolumeUp: a command
      // that exists on one device and not on another is what proves the
      // exists-on-THIS-device check rather than an exists-anywhere one.
      controlGroup: [
        { name: 'Input', function: [{ name: 'InputOptical', label: 'Optical' }, { name: 'InputCoax', label: 'Coax' }] },
      ],
    },
    // No controlGroup at all. A device the hub knows and has no codes for is
    // ordinary — a Bluetooth or CEC-only target — and flattening `undefined`
    // used to throw rather than come back as an empty list.
    { id: '20000003', label: 'Example_Streamer', type: 'StreamingStick', manufacturer: 'Example_Maker', model: 'Example_Model_C' },
  ],
});

// The account the fixture's resource lists live under. A real hub reports its
// Logitech account id on the provisioning endpoint, and the server needs it for
// one thing only: reading those lists when ?config will not answer.
const ACCOUNT = 'Example_Account_0001';

// CONFIG() as the hub's own resource lists hold it, which is the shape a real
// hub answers proxy.resource?get with: Id- and Name instead of id and label,
// commands as a flat list with no button groups, and no PowerOff activity.
const RESOURCES = () => {
  const c = CONFIG();
  return {
    DeviceList: {
      DevicesWithFeatures: c.device.map(d => ({
        Device: { 'Id-': Number(d.id), Name: d.label, Manufacturer: d.manufacturer, Model: d.model, DeviceTypeDisplayName: d.type },
        Commands: (d.controlGroup || []).flatMap(g => g.function).map(f => ({ Name: f.name })),
        DeviceFeatures: [],
      })),
    },
    ActivityList: {
      Activities: c.activity.filter(a => a.id !== '-1').map(a => ({ 'Id-': Number(a.id), Name: a.label, Roles: [] })),
    },
  };
};

const commandsOn = deviceId => (CONFIG().device.find(d => d.id === String(deviceId))?.controlGroup || [])
  .flatMap(g => g.function).map(f => f.name);

// A real hub sends its remote id as a NUMBER, and the first release of the
// server refused it for not being a string — tested only against a mock that
// sent one. So the default here is the real shape; a test that wants the string
// form sets it.
export function start({ remoteId = 30000001 } = {}) {
  const state = {
    // What the test asserts on: every hbus command in the order it arrived,
    // every provisioning request, every keypress, every activity start.
    cmds: [],
    provisions: 0,
    origins: [],
    connections: [],
    presses: [],
    started: [],
    remoteId,
    currentActivity: '-1',

    // Hostility knobs. Each one reproduces something a real hub does, and each
    // is restored by the test through a named helper rather than at the call
    // site, so a failed assertion cannot poison the tests after it.
    provisionStatus: 200,
    omitRemoteId: false,
    configCode: 200,
    refuseUpgrade: false,
    closeOnConnect: false,
    startErrorCode: null,
    dropStartNotify: false,
    answerSysinfo: true,
    // ?config left unanswered for good, which a real hub did after its device
    // list had been edited locally. Everything else kept working.
    configStalls: false,
    // A keypress the hub refuses, e.g. { code: 401, msg: 'Bluetooth not paired' }.
    // A real hub answers a refusal under the request's id; an accepted keypress
    // it never answers.
    refuseHold: null,
    // getCurrentActivity left unanswered. A real hub does that for a minute
    // after the activity that was running is started again.
    answerCurrent: true,
  };

  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let cmd;
      try { cmd = JSON.parse(body)?.cmd; } catch { cmd = null; }
      state.origins.push(req.headers.origin || null);
      if (cmd !== 'setup.account?getProvisionInfo') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ msg: 'not found' }));
      }
      state.provisions++;
      if (state.provisionStatus !== 200) {
        res.writeHead(state.provisionStatus, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ msg: 'no' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id: 0, msg: 'OK', code: '200',
        data: {
          // A real hub returns the account address here, which is exactly why
          // the server reads activeRemoteId out of this body and never forwards
          // the body itself to a tool result.
          email: 'fixture@example.com', username: 'fixture@example.com',
          accountId: ACCOUNT,
          ...(state.omitRemoteId ? {} : { activeRemoteId: state.remoteId }),
          susChannel: 'production', mode: 3,
        },
      }));
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  srv.on('upgrade', (req, socket, head) => {
    if (state.refuseUpgrade) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => { wss.emit('connection', ws, req); });
  });

  wss.on('connection', (ws, req) => {
    const q = new URL(req.url, 'http://placeholder.invalid').searchParams;
    state.connections.push({ hubId: q.get('hubId'), domain: q.get('domain') });
    // A hub handed a remote id it does not recognise accepts the TCP connection
    // and then closes it with no explanation, which is why the server's open
    // path reports a close during the handshake as a possible id mismatch.
    if (state.closeOnConnect) { ws.close(1008, 'no'); return; }

    let wedged = false;
    ws.on('message', buf => {
      let m;
      try { m = JSON.parse(buf.toString()); } catch { return; }
      const cmd = m?.hbus?.cmd;
      const id = m?.hbus?.id;
      state.cmds.push(cmd);
      const reply = o => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o)); };

      // On the real hub that stalls, a ?config left pending took the socket
      // down with it: the next request on the same socket timed out as well,
      // where on a fresh socket it took a second. So once this connection has
      // asked, it is answered nothing more.
      if (wedged) return undefined;
      if (cmd === `${ENGINE}?config`) {
        if (state.configStalls) { wedged = true; return undefined; }   // asked, and never answered
        // code as a NUMBER here and as a STRING below, because the real hub is
        // inconsistent in exactly that way. A server that compared strictly
        // against one of the two reported every command of the other kind as an
        // error, so both shapes are in the fixtures on purpose.
        return reply({ cmd, id, code: state.configCode, msg: state.configCode === 200 ? 'OK' : 'nope', data: state.configCode === 200 ? CONFIG() : {} });
      }
      if (cmd === 'proxy.resource?get') {
        // The envelope a real hub answers with: an outer code, and the resource
        // inside data next to a second, string, code of its own.
        const uri = String(m?.hbus?.params?.uri || '');
        const name = uri.startsWith(`harmony://Account/${ACCOUNT}/`) ? uri.split('/').at(-1) : null;
        const res = name && RESOURCES()[name];
        if (!res) return reply({ cmd, id, code: 404, msg: 'resource not found' });
        return reply({ cmd, id, code: 200, msg: 'OK', data: { uri, code: '200', etag: '"Example_Etag"', hetag: '1', resource: res } });
      }
      if (cmd === `${ENGINE}?getCurrentActivity`) {
        // A real hub goes a minute without answering this after the running
        // activity was started again; see answerCurrent.
        if (!state.answerCurrent) return undefined;
        return reply({ cmd, id, code: '200', msg: 'OK', data: { result: state.currentActivity } });
      }
      if (cmd === 'connect.sysinfo?get') {
        if (!state.answerSysinfo) return undefined;   // some firmware simply does not
        return reply({ cmd, id, code: 200, msg: 'OK', data: { fw_ver: '4.15.250', status: 'normal' } });
      }
      if (cmd === `${ENGINE}?startactivity`) {
        const activityId = String(m?.hbus?.params?.activityId);
        state.started.push(activityId);
        // Recorded off a real hub, frame by frame. First an acknowledgement under
        // the request's id with code 200, which is NOT the end of it: a server
        // that settled on the id reported "started" before a single device had
        // been switched.
        reply({ cmd, id, code: 200, msg: 'OK', data: null });
        if (state.dropStartNotify) return undefined;  // hub that never finishes
        if (activityId === state.currentActivity) {
          // PowerOff with everything already off: the power discretes are sent
          // again under helpdiscretes, ending with a frame without a counter.
          if (activityId === '-1') {
            reply({ type: 'harmony.engine?helpdiscretes', data: { done: '1', total: '1', deviceId: '20000001' } });
            return reply({ type: 'harmony.engine?helpdiscretes', data: { activityId } });
          }
          // Any other activity that is already running: one progress frame,
          // done 1 of 1, and no notification at all.
          return reply({ cmd: 'harmony.engine?startActivity', id, code: 200, msg: 'Ok', data: { total: '1', done: '1' } });
        }
        // Progress under the same id with code 100, the last one with 200, or
        // with the failure's own code when the knob asks for one.
        const errorCode = String(state.startErrorCode ?? 200);
        reply({ cmd: 'harmony.engine?startActivity', id, code: 100, msg: 'progress', data: { done: '1', total: '2', deviceId: '20000001' } });
        reply({ cmd: 'harmony.engine?startActivity', id, code: Number(errorCode), msg: 'progress', data: { done: '2', total: '2', deviceId: '20000002' } });
        if (errorCode === '200') state.currentActivity = activityId;
        // And the end: a NOTIFICATION with no id, and with no vendor prefix on
        // its type — `harmony.engine?startActivityFinished`, where every request
        // goes out as `vnd.logitech.harmony/vnd.logitech.harmony.engine?...`.
        // The first release waited for the prefixed name, and so did this mock,
        // which is how a server that timed out on every real activity passed.
        return reply({ type: 'harmony.engine?startActivityFinished', data: { activityId, errorCode, errorString: errorCode === '200' ? 'OK' : 'failed' } });
      }
      if (cmd === `${ENGINE}?holdAction`) {
        let action;
        try { action = JSON.parse(m?.hbus?.params?.action || '{}'); } catch { action = {}; }
        state.presses.push({ status: m?.hbus?.params?.status, command: action.command, deviceId: action.deviceId });
        // A keypress the hub declines is answered, under its id: 566 for a
        // command the device does not have, 401 for a Bluetooth device it is not
        // paired with. Both observed on a real hub.
        if (state.refuseHold) return reply({ cmd, id, code: state.refuseHold.code, msg: state.refuseHold.msg });
        if (!commandsOn(action.deviceId).includes(action.command)) {
          return reply({ cmd, id, code: 566, msg: `Command not found for device id:${action.deviceId}` });
        }
        // An accepted one is answered by nothing with its id — at most the hub's
        // own metadata notify, which carries none. There is no acknowledgement of
        // a keypress anywhere in this protocol, which is the whole basis of the
        // server reporting confirmed:false.
        return reply({ type: 'harmonyengine.metadata?notify', data: {} });
      }
      return reply({ cmd, id, code: 400, msg: 'unknown command' });
    });
  });

  return new Promise(resolve => {
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({
        port: String(port),
        state,
        // Named helpers, so a test restores a knob from a finally without
        // repeating the default at the call site.
        answersAgain() { state.provisionStatus = 200; state.omitRemoteId = false; state.configCode = 200; state.configStalls = false; state.remoteId = remoteId; state.answerCurrent = true; },
        connectsAgain() { state.refuseUpgrade = false; state.closeOnConnect = false; },
        startsAgain() { state.startErrorCode = null; state.dropStartNotify = false; },
        acceptsKeys() { state.refuseHold = null; },
        close() {
          return new Promise(done => {
            for (const c of wss.clients) c.terminate();
            wss.close(() => { srv.close(() => done()); });
          });
        },
      });
    });
  });
}
