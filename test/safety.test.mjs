// The properties that outrank features.
//
// This server has no credential to leak and no irreversible action to gate, so
// what is left to protect is narrower and easier to lose sight of: the address it
// talks to must be the one that was configured, a keypress must not be emitted
// for a command the device does not have, and the Logitech account address the
// hub volunteers on its provisioning endpoint must never reach a tool result.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './client.mjs';
import { start as startMock } from './mock-harmony.mjs';

let mock;
before(async () => { mock = await startMock(); });
after(async () => { await mock?.close(); });

// A keychain that DOES answer, so the env-wins rule can be caught failing. The
// null shim in client.mjs proves nothing about precedence: a server that wrongly
// consulted the keychain would get nothing from it there and look correct.
function keychainThatAnswers(value) {
  const dir = mkdtempSync(join(tmpdir(), 'harmony-loud-keychain-'));
  const log = join(dir, 'asked.log');
  writeFileSync(join(dir, 'security'),
    `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nprintf '%s\\n' ${JSON.stringify(value)}\n`,
    { mode: 0o755 });
  return { dir, wasAsked: () => { try { return readFileSync(log, 'utf8'); } catch { return ''; } } };
}

describe('the address is the one that was configured', () => {
  // Each of these is a way of writing a host that sends the request somewhere
  // else. The first is the dangerous one: everything before an @ in an authority
  // is userinfo, so the request would go to the second half and the "host" would
  // be a login.
  for (const [host, why] of [
    ['a@evil.example.com', 'userinfo smuggled in front of another host'],
    ['hub.invalid/../x', 'a path that resolves away'],
    ['hub.invalid?x=1', 'a query string in the authority'],
    ['hub.invalid:9999', 'a port embedded in the host'],
    ['hub .invalid', 'a space, which is not a hostname'],
  ]) {
    test(`refused: ${why}`, async () => {
      const before = mock.state.provisions;
      const srv = await startServer({ HARMONY_HUB_HOST: host, HARMONY_HUB_PORT: mock.port, HARMONY_TIMEOUT_MS: '1500' });
      try {
        const r = await srv.call('harmony_status');
        assert.equal(r.isError, true);
        assert.match(r.raw, /kein Hostname und keine IP/);
        // And it cost nothing: the refusal happens before a socket exists.
        assert.equal(mock.state.provisions, before);
      } finally {
        await srv.stop();
      }
    });
  }

  for (const port of ['0', '70000', '80;rm', '']) {
    test(`a port that is not a port is refused: ${JSON.stringify(port)}`, async () => {
      // An empty port is the one exception, because it falls back to the hub's
      // real default of 8088 rather than being a bad value — so it is expected
      // to fail on reachability instead, never on the authority being malformed.
      const srv = await startServer({ HARMONY_HUB_PORT: port, HARMONY_TIMEOUT_MS: '1500' });
      try {
        const r = await srv.call('harmony_status');
        assert.equal(r.isError, true);
        if (port !== '') assert.match(r.raw, /ist kein Port/);
      } finally {
        await srv.stop();
      }
    });
  }

  test('no host at all names the variable and the keychain entry', async () => {
    const srv = await startServer({ HARMONY_HUB_HOST: '', HARMONY_TIMEOUT_MS: '1500' });
    try {
      const r = await srv.call('harmony_status');
      assert.equal(r.isError, true);
      assert.match(r.raw, /HARMONY_HUB_HOST/);
      assert.match(r.raw, /harmony-mcp-host/);
    } finally {
      await srv.stop();
    }
  });

  test('a set-but-empty host does NOT fall through to the login keychain', async () => {
    const kc = keychainThatAnswers('192.0.2.1');
    const srv = await startServer({
      HARMONY_HUB_HOST: '', HARMONY_TIMEOUT_MS: '1500',
      PATH: `${kc.dir}:${process.env.PATH}`,
    });
    try {
      const r = await srv.call('harmony_status');
      // If the rule regressed, the host would be 192.0.2.1 and the complaint
      // would be about reachability rather than about the variable being unset.
      assert.match(r.raw, /HARMONY_HUB_HOST ist nicht gesetzt/);
      assert.ok(!/192\.0\.2\.1/.test(r.raw), 'the keychain value was used for a variable that was set');
      // Asked about the HOST specifically, not about the log being empty. The
      // log is not empty and should not be: client.mjs unsets
      // HARMONY_HUB_REMOTE_ID, so looking that one up in the keychain is the
      // correct behaviour and has nothing to do with the rule under test. The
      // first version of this assertion failed on exactly that, which made a
      // passing server look broken.
      assert.ok(!/harmony-mcp-host/.test(kc.wasAsked()), 'the keychain was consulted for a variable that was set');
    } finally {
      await srv.stop();
    }
  });

  test('an unset host DOES reach the keychain, so the rule above is about precedence', async () => {
    const kc = keychainThatAnswers('192.0.2.1');
    const srv = await startServer({
      HARMONY_HUB_HOST: undefined, HARMONY_TIMEOUT_MS: '1500',
      PATH: `${kc.dir}:${process.env.PATH}`,
    });
    try {
      await srv.call('harmony_status');
      assert.match(kc.wasAsked(), /harmony-mcp-host/);
    } finally {
      await srv.stop();
    }
  });
});

describe('nothing is emitted that the device cannot do', () => {
  let srv;
  before(async () => { srv = await startServer({ HARMONY_HUB_PORT: mock.port, HARMONY_TIMEOUT_MS: '1500' }); });
  after(async () => { await srv?.stop(); });

  test('an absurd repeat is clamped rather than wedging the hub', async () => {
    mock.state.presses.length = 0;
    const r = await srv.call('harmony_send_command', { device_id: '20000001', command: 'Mute', repeat: 100000 });
    assert.equal(r.data.emitted.repeat, 10);
    assert.equal(mock.state.presses.length, 20);
  });

  test('a repeat that is not a number falls back to one, not to NaN', async () => {
    mock.state.presses.length = 0;
    const r = await srv.call('harmony_send_command', { device_id: '20000001', command: 'Mute', repeat: 'lots' });
    assert.equal(r.data.emitted.repeat, 1);
    assert.equal(mock.state.presses.length, 2);
  });

  test('a negative hold is not a negative timeout', async () => {
    const r = await srv.call('harmony_send_command', { device_id: '20000001', command: 'Mute', hold_ms: -5000 });
    assert.equal(r.isError, false);
    assert.equal(r.data.emitted.hold_ms, undefined, 'a negative hold was carried through as a hold');
  });

  test('an id shaped like nothing on the hub is refused before a socket opens', async () => {
    const before = mock.state.cmds.length;
    const r = await srv.call('harmony_send_command', { device_id: '../../etc/passwd', command: 'Mute' });
    assert.equal(r.isError, true);
    assert.match(r.raw, /Ung(ü|u)ltige device_id/);
    assert.equal(mock.state.cmds.length, before, 'the hub was contacted for an id that cannot be one');
  });

  test('a command is checked against the device, not merely against being a string', async () => {
    mock.state.presses.length = 0;
    for (const command of ['', 'DROP TABLE', 'volumeup', 'VolumeUp ']) {
      const r = await srv.call('harmony_send_command', { device_id: '20000001', command });
      assert.ok(r.data.error, `${JSON.stringify(command)} was accepted`);
    }
    assert.equal(mock.state.presses.length, 0);
  });
});

describe('the hub volunteers more than it is asked', () => {
  test('the account address on the provisioning endpoint never reaches a result', async () => {
    const srv = await startServer({ HARMONY_HUB_PORT: mock.port, HARMONY_TIMEOUT_MS: '1500' });
    try {
      // Every tool, because the provisioning answer is fetched on the first call
      // whichever one that is, and the body is in hand at that moment.
      const results = [];
      for (const name of (await srv.tools()).map(t => t.name)) {
        results.push((await srv.call(name, { device_id: '20000001', command: 'Mute', activity_id: '10000001' })).raw);
      }
      const all = results.join('\n') + srv.stderr();
      // The local part on its own, not just the whole address: a result that
      // quoted only the username would pass a check for the full string.
      assert.ok(!/fixture/.test(all), 'the account address leaked into a tool result');
      assert.ok(!/Example_Account_0001/.test(all), 'the account id leaked into a tool result');
    } finally {
      await srv.stop();
    }
  });
});
