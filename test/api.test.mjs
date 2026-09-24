// The suites drive the server over stdio against the local mock hub. Nothing
// here can reach a real hub: the address is 127.0.0.1 and the port is the mock's
// own, and test/client.mjs puts a `security` that finds nothing first on PATH so
// a regression in the env-wins rule cannot fall through to the login keychain.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startServer } from './client.mjs';
import { start as startMock } from './mock-harmony.mjs';

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const ENGINE = 'vnd.logitech.harmony/vnd.logitech.harmony.engine';

let mock, srv;

before(async () => {
  mock = await startMock();
  // The activity budget is cut right down, because one test here proves what
  // happens when the hub never reports the activity finished and the default is
  // three quarters of a minute of doing nothing.
  srv = await startServer({ HARMONY_HUB_PORT: mock.port, HARMONY_ACTIVITY_TIMEOUT_MS: '1500', HARMONY_TIMEOUT_MS: '1500' });
});
after(async () => { await srv?.stop(); await mock?.close(); });

describe('protocol', () => {
  test('serverInfo matches package.json', () => {
    const info = srv.init?.result?.serverInfo;
    assert.equal(info.name, PKG.name);
    assert.equal(info.version, PKG.version);
  });

  test('every tool has a usable description and a declared schema', async () => {
    const tools = await srv.tools();
    assert.ok(tools.length > 0);
    for (const t of tools) {
      assert.ok(t.description.length > 20, `${t.name} description`);
      assert.equal(t.inputSchema.type, 'object');
      assert.equal(typeof t.inputSchema.properties, 'object');
      for (const r of t.inputSchema.required || []) {
        assert.ok(Object.hasOwn(t.inputSchema.properties, r), `${t.name} requires undeclared ${r}`);
      }
    }
  });

  test('an unknown tool is an error and costs the hub nothing', async () => {
    const before = { p: mock.state.provisions, c: mock.state.cmds.length };
    const r = await srv.call('harmony_nope');
    assert.equal(r.isError, true);
    assert.match(r.raw, /unknown tool/);
    // The point of deciding this first: an unknown name must not open a socket
    // or ask the hub who it is.
    assert.equal(mock.state.provisions, before.p);
    assert.equal(mock.state.cmds.length, before.c);
  });
});

describe('discovery', () => {
  test('the remote id is fetched once and reused', async () => {
    await srv.call('harmony_list_devices');
    const after = mock.state.provisions;
    await srv.call('harmony_list_devices');
    assert.equal(mock.state.provisions, after, 'provisioning was repeated');
  });

  test('the provisioning request carries the Origin the hub insists on', () => {
    assert.ok(mock.state.origins.includes('http://sl.dhg.myharmony.com'));
    assert.ok(!mock.state.origins.includes(null), 'a request went out with no Origin');
  });

  test('the socket is opened with the discovered id and the expected domain', () => {
    const c = mock.state.connections.at(-1);
    assert.equal(c.hubId, mock.state.remoteId);
    assert.equal(c.domain, 'svcs.myharmony.com');
  });
});

describe('harmony_status', () => {
  test('reports the hub, its id, its firmware and what is running', async () => {
    mock.state.currentActivity = '10000001';
    const r = await srv.call('harmony_status');
    assert.equal(r.isError, false);
    assert.equal(r.data.remote_id, mock.state.remoteId);
    assert.equal(r.data.firmware, '4.15.250');
    assert.equal(r.data.activities, 3);
    assert.equal(r.data.devices, 3);
    assert.deepEqual(r.data.current_activity, { id: '10000001', label: 'Example_WatchTV' });
    assert.match(r.data.hub, /^127\.0\.0\.1:\d+$/);
  });

  test('current_activity is null when everything is off', async () => {
    mock.state.currentActivity = '-1';
    const r = await srv.call('harmony_status');
    assert.equal(r.data.current_activity, null);
  });

  test('a hub that will not talk about itself is still a working hub', async () => {
    mock.state.answerSysinfo = false;
    try {
      const r = await srv.call('harmony_status');
      assert.equal(r.isError, false);
      assert.equal(r.data.firmware, undefined);
      assert.equal(r.data.devices, 3, 'the rest of the status was lost with the version string');
    } finally {
      mock.state.answerSysinfo = true;
    }
  });

  test('an activity the hub reports but does not list is called out', async () => {
    mock.state.currentActivity = '99999999';
    try {
      const r = await srv.call('harmony_status');
      assert.match(r.data.note, /Konfiguration nicht vorkommt/);
    } finally {
      mock.state.currentActivity = '-1';
    }
  });
});

describe('listing', () => {
  test('activities come back with the running one marked', async () => {
    mock.state.currentActivity = '10000002';
    try {
      const r = await srv.call('harmony_list_activities');
      const music = r.data.activities.find(a => a.id === '10000002');
      const tv = r.data.activities.find(a => a.id === '10000001');
      assert.equal(music.current, true);
      assert.equal(tv.current, undefined, 'more than one activity was marked as running');
    } finally {
      mock.state.currentActivity = '-1';
    }
  });

  test('devices come back with the fields needed to address them', async () => {
    const r = await srv.call('harmony_list_devices');
    const tv = r.data.devices.find(d => d.id === '20000001');
    assert.equal(tv.label, 'Example_TV');
    assert.equal(tv.manufacturer, 'Example_Maker');
    assert.equal(tv.model, 'Example_Model_A');
  });

  test('commands are flattened out of their control groups', async () => {
    const r = await srv.call('harmony_list_commands', { device_id: '20000001' });
    const names = r.data.commands.map(c => c.name);
    assert.ok(names.includes('VolumeUp'));
    assert.ok(names.includes('InputHdmi2'));
    assert.ok(names.includes('PowerToggle'), 'a whole control group was dropped');
  });

  test('a device with no codes at all is an empty list, not a crash', async () => {
    const r = await srv.call('harmony_list_commands', { device_id: '20000003' });
    assert.equal(r.isError, false);
    assert.deepEqual(r.data.commands, []);
  });

  test('an unknown device names the ones that do exist', async () => {
    const r = await srv.call('harmony_list_commands', { device_id: '20009999' });
    assert.match(r.data.error, /20009999/);
    assert.equal(r.data.devices.length, 3, 'the alternatives were not offered');
  });

  test('current_activity says so plainly when nothing is on', async () => {
    mock.state.currentActivity = '-1';
    const r = await srv.call('harmony_current_activity');
    assert.equal(r.data.current_activity, null);
    assert.match(r.data.note, /aus/);
  });
});

describe('starting an activity', () => {
  test('a known activity is started and confirmed from the notification', async () => {
    const r = await srv.call('harmony_start_activity', { activity_id: '10000001' });
    assert.equal(r.isError, false);
    assert.equal(r.data.started, true);
    assert.equal(r.data.activity.label, 'Example_WatchTV');
    assert.equal(mock.state.started.at(-1), '10000001');
  });

  test('an unknown activity is refused before the hub is asked to start it', async () => {
    const before = mock.state.started.length;
    const r = await srv.call('harmony_start_activity', { activity_id: '10009999' });
    assert.match(r.data.error, /10009999/);
    assert.equal(mock.state.started.length, before, 'the hub was asked to start a made-up activity');
    assert.ok(r.data.activities.length > 0, 'the alternatives were not offered');
  });

  test('power_off asks for activity -1', async () => {
    const r = await srv.call('harmony_power_off');
    assert.equal(r.data.started, true);
    assert.equal(mock.state.started.at(-1), '-1');
  });

  test('a hub that finishes with an error code is not reported as started', async () => {
    mock.state.startErrorCode = 500;
    try {
      const r = await srv.call('harmony_start_activity', { activity_id: '10000001' });
      assert.equal(r.data.started, false);
      assert.match(r.data.error, /500/);
    } finally {
      mock.startsAgain();
    }
  });

  test('a hub that never finishes times out rather than claiming success', async () => {
    mock.state.dropStartNotify = true;
    try {
      const r = await srv.call('harmony_start_activity', { activity_id: '10000001' });
      assert.equal(r.isError, true);
      assert.match(r.raw, /Zeit(ü|u)berschreitung/);
    } finally {
      mock.startsAgain();
    }
  });
});

describe('sending a command', () => {
  test('a tap is a press and a release, and is never claimed as confirmed', async () => {
    mock.state.presses.length = 0;
    const r = await srv.call('harmony_send_command', { device_id: '20000001', command: 'VolumeUp' });
    assert.equal(r.isError, false);
    assert.equal(r.data.confirmed, false);
    assert.match(r.data.note, /nicht, dass das Ger(ä|a)t reagiert/);
    assert.deepEqual(mock.state.presses.map(p => p.status), ['press', 'release']);
    assert.equal(mock.state.presses[0].command, 'VolumeUp');
    assert.equal(mock.state.presses[0].deviceId, '20000001');
  });

  test('a misspelt command is refused instead of emitted as nothing', async () => {
    mock.state.presses.length = 0;
    const r = await srv.call('harmony_send_command', { device_id: '20000001', command: 'Volumeup' });
    assert.match(r.data.error, /Volumeup/);
    assert.equal(mock.state.presses.length, 0, 'a command the device does not have was emitted anyway');
    assert.ok(r.data.commands.includes('VolumeUp'), 'the real spelling was not offered');
  });

  test('a command that exists on another device is still refused on this one', async () => {
    mock.state.presses.length = 0;
    // VolumeUp is on Example_TV and deliberately not on Example_Speakers, so
    // this is what tells an exists-on-this-device check apart from an
    // exists-somewhere one.
    const r = await srv.call('harmony_send_command', { device_id: '20000002', command: 'VolumeUp' });
    assert.match(r.data.error, /Example_Speakers/);
    assert.equal(mock.state.presses.length, 0);
  });

  test('repeat is clamped and actually repeated', async () => {
    mock.state.presses.length = 0;
    const r = await srv.call('harmony_send_command', { device_id: '20000001', command: 'Mute', repeat: 3 });
    assert.equal(r.data.emitted.repeat, 3);
    assert.equal(mock.state.presses.length, 6, 'three taps are three presses and three releases');
  });

  test('a hold reports the time it held for', async () => {
    mock.state.presses.length = 0;
    const r = await srv.call('harmony_send_command', { device_id: '20000001', command: 'VolumeDown', hold_ms: 40 });
    assert.equal(r.data.emitted.hold_ms, 40);
    assert.deepEqual(mock.state.presses.map(p => p.status), ['press', 'release']);
  });
});

describe('a hub that misbehaves', () => {
  test('a config the hub will not hand over is an error, not an empty room', async () => {
    mock.state.configCode = 500;
    try {
      const r = await srv.call('harmony_list_devices');
      assert.equal(r.isError, true);
      assert.match(r.raw, /Konfiguration nicht lesbar/);
    } finally {
      mock.answersAgain();
    }
  });

  test('a provisioning endpoint that refuses says so', async () => {
    // A fresh server, because the running one has already discovered and cached
    // the id — which is the behaviour the discovery suite asserts.
    mock.state.provisionStatus = 503;
    const fresh = await startServer({ HARMONY_HUB_PORT: mock.port, HARMONY_TIMEOUT_MS: '1500' });
    try {
      const r = await fresh.call('harmony_status');
      assert.equal(r.isError, true);
      assert.match(r.raw, /503/);
    } finally {
      await fresh.stop();
      mock.answersAgain();
    }
  });

  test('a provisioning answer with no remote id in it is refused', async () => {
    mock.state.omitRemoteId = true;
    const fresh = await startServer({ HARMONY_HUB_PORT: mock.port, HARMONY_TIMEOUT_MS: '1500' });
    try {
      const r = await fresh.call('harmony_status');
      assert.equal(r.isError, true);
      assert.match(r.raw, /activeRemoteId/);
    } finally {
      await fresh.stop();
      mock.answersAgain();
    }
  });

  test('a socket closed on connect points at the remote id', async () => {
    mock.state.closeOnConnect = true;
    const fresh = await startServer({ HARMONY_HUB_PORT: mock.port, HARMONY_TIMEOUT_MS: '1500' });
    try {
      const r = await fresh.call('harmony_list_devices');
      assert.equal(r.isError, true);
      assert.match(r.raw, /remote id/);
    } finally {
      await fresh.stop();
      mock.connectsAgain();
    }
  });

  test('a configured id the hub disagrees with is a warning, not a silent wrong answer', async () => {
    const fresh = await startServer({ HARMONY_HUB_PORT: mock.port, HARMONY_HUB_REMOTE_ID: 'Example_Remote_9999', HARMONY_TIMEOUT_MS: '1500' });
    try {
      const r = await fresh.call('harmony_status');
      assert.match(r.data.warning, /Example_Remote_9999/);
      assert.match(r.data.warning, /Example_Remote_0001/);
    } finally {
      await fresh.stop();
    }
  });

  test('the hub is asked about itself even when the id is configured', async () => {
    // The warning above is only possible because status asks. A server that
    // trusted the configured value would have nothing to compare against, and
    // the check above would pass while proving nothing.
    const fresh = await startServer({ HARMONY_HUB_PORT: mock.port, HARMONY_HUB_REMOTE_ID: mock.state.remoteId, HARMONY_TIMEOUT_MS: '1500' });
    const before = mock.state.provisions;
    try {
      const r = await fresh.call('harmony_status');
      assert.equal(r.isError, false);
      assert.equal(r.data.warning, undefined);
      assert.ok(mock.state.provisions > before, 'the configured id was taken on trust');
    } finally {
      await fresh.stop();
    }
  });
});

describe('the wire', () => {
  test('every command goes out under the engine namespace the hub expects', () => {
    const seen = new Set(mock.state.cmds);
    assert.ok(seen.has(`${ENGINE}?config`));
    assert.ok(seen.has(`${ENGINE}?getCurrentActivity`));
    assert.ok(seen.has(`${ENGINE}?startactivity`));
    assert.ok(seen.has(`${ENGINE}?holdAction`));
  });
});
