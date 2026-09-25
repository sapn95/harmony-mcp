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

export function start({ remoteId = 'Example_Remote_0001' } = {}) {
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
          accountId: 'Example_Account_0001',
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

    ws.on('message', buf => {
      let m;
      try { m = JSON.parse(buf.toString()); } catch { return; }
      const cmd = m?.hbus?.cmd;
      const id = m?.hbus?.id;
      state.cmds.push(cmd);
      const reply = o => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o)); };

      if (cmd === `${ENGINE}?config`) {
        // code as a NUMBER here and as a STRING below, because the real hub is
        // inconsistent in exactly that way. A server that compared strictly
        // against one of the two reported every command of the other kind as an
        // error, so both shapes are in the fixtures on purpose.
        return reply({ cmd, id, code: state.configCode, msg: state.configCode === 200 ? 'OK' : 'nope', data: state.configCode === 200 ? CONFIG() : {} });
      }
      if (cmd === `${ENGINE}?getCurrentActivity`) {
        return reply({ cmd, id, code: '200', msg: 'OK', data: { result: state.currentActivity } });
      }
      if (cmd === 'connect.sysinfo?get') {
        if (!state.answerSysinfo) return undefined;   // some firmware simply does not
        return reply({ cmd, id, code: 200, msg: 'OK', data: { fw_ver: '4.15.250', status: 'normal' } });
      }
      if (cmd === `${ENGINE}?startactivity`) {
        const activityId = String(m?.hbus?.params?.activityId);
        state.started.push(activityId);
        if (state.dropStartNotify) return undefined;  // hub that never finishes
        const errorCode = state.startErrorCode ?? 200;
        if (String(errorCode) === '200') state.currentActivity = activityId;
        // The answer to this one is a NOTIFICATION carrying no id at all, which
        // is why the server registers a waiter on the type instead of matching
        // the id it sent.
        return reply({ type: `${ENGINE}?startActivityFinished`, data: { activityId, errorCode, errorString: errorCode === 200 ? 'OK' : 'failed' } });
      }
      if (cmd === `${ENGINE}?holdAction`) {
        let action;
        try { action = JSON.parse(m?.hbus?.params?.action || '{}'); } catch { action = {}; }
        state.presses.push({ status: m?.hbus?.params?.status, command: action.command, deviceId: action.deviceId });
        // And this one is answered by something unrelated with no id either — the
        // hub's own metadata notify. There is no acknowledgement of a keypress
        // anywhere in this protocol, which is the whole basis of the server
        // reporting confirmed:false.
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
        answersAgain() { state.provisionStatus = 200; state.omitRemoteId = false; state.configCode = 200; },
        connectsAgain() { state.refuseUpgrade = false; state.closeOnConnect = false; },
        startsAgain() { state.startErrorCode = null; state.dropStartNotify = false; },
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
