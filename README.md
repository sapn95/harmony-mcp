<div align="center">

# harmony-mcp

Drive a **Logitech Harmony Hub** from an MCP client, over the hub's own local API.

[![npm](https://img.shields.io/npm/v/harmony-mcp?style=flat-square&logo=npm&logoColor=white&label=npm&color=CB3837)](https://www.npmjs.com/package/harmony-mcp)
&nbsp;
[![CI](https://img.shields.io/github/actions/workflow/status/sapn95/harmony-mcp/ci.yml?branch=main&style=flat-square&logo=github&logoColor=white&label=CI)](https://github.com/sapn95/harmony-mcp/actions/workflows/ci.yml)
&nbsp;
[![node](https://img.shields.io/node/v/harmony-mcp?style=flat-square&logo=nodedotjs&logoColor=white&color=5FA04E)](https://nodejs.org)
&nbsp;
[![licence](https://img.shields.io/npm/l/harmony-mcp?style=flat-square&color=4C5B5C)](LICENSE)

</div>

---

MCP server for a [Logitech Harmony Hub](https://support.myharmony.com) on your own network. List the activities and devices the hub knows, start an activity, turn everything off, and send individual IR commands to one device — from any MCP client (Claude Code, Claude Desktop, and others).

Logitech discontinued the Harmony line in 2021 and shut down the cloud API. The hubs kept working, and so did the local interface this server speaks. Nothing here touches the internet.

---

## Prerequisites

- Node 22.4 or newer. That floor is higher than the sibling servers in this account ask for, and deliberately: this server uses the WebSocket client built into Node, which was marked stable in 22.4, so there is no WebSocket dependency to install. Node 20 went end-of-life in April 2026.
- A Harmony Hub already set up with the Harmony app, on the same network as the machine running this server. The one-time provisioning has to have happened; after that the hub no longer needs Logitech and neither does this.
- The hub's IP address or hostname. A fixed lease for it is worth the five minutes: everything here is addressed by that.

```bash
git clone https://github.com/sapn95/harmony-mcp.git
cd harmony-mcp
npm install
```

---

## Setting the hub address (step by step)

### 1. Find the hub

The Harmony app shows it under **Hub** → **About**, and your router will have it under whatever name the hub registered — usually `Harmony-Hub`. Failing both, it is the device answering on TCP 8088.

### 2. Check it answers

```bash
curl -s -X POST 192.0.2.10:8088 \
  -H 'Content-Type: application/json' \
  -H 'Accept: utf-8' \
  -H 'Origin: http://sl.dhg.myharmony.com' \
  -d '{"id":1,"cmd":"setup.account?getProvisionInfo","params":{}}'
```

That `Origin` header is not optional and its value is not ours to choose. The hub compares it against that string and answers nothing without it; it never resolves or contacts the host, which has served nothing for years.

The reply contains `activeRemoteId`. You do not need to write it down — this server asks for it the same way — but seeing it come back proves the hub is reachable.

### 3. Store the address

On macOS, in the login keychain, so it does not sit in a client config:

```bash
security add-generic-password -a harmony -s harmony-mcp-host -w -U   # prompts
```

| Value | Keychain service name | Env-var alternative | Required |
| --- | --- | --- | --- |
| Hub IP or hostname | `harmony-mcp-host` | `HARMONY_HUB_HOST` | yes |
| Remote id | `harmony-mcp-remote-id` | `HARMONY_HUB_REMOTE_ID` | no — discovered |
| Port | `harmony-mcp-port` | `HARMONY_HUB_PORT` | no — 8088 |

An environment variable that is **set** wins even when it is empty, and the keychain is only consulted for a variable that is absent. That is on purpose: written the other way round, a container or a test that deliberately blanks the address would fall through to the developer's keychain and start switching on the television in the actual living room.

---

## Register in Claude Code

```bash
claude mcp add harmony -- node /absolute/path/to/harmony-mcp/index.js
```

Or, as JSON, with an absolute path to `index.js`:

```jsonc
{
  "mcpServers": {
    "harmony": {
      "command": "node",
      "args": ["/absolute/path/to/harmony-mcp/index.js"],
      "env": { "HARMONY_HUB_HOST": "192.0.2.10" }
    }
  }
}
```

---

## There is no credential to hold

The hub has no authentication. None. Anything that can reach port 8088 can drive every device in the room, and there is no token, no password and no pairing step to get there.

That is the hub's design and not something this server can fix, but two things follow from it that are worth being explicit about:

- **There is nothing here to leak.** No credential is read, cached, redacted or logged, because none exists. The "remote id" is not a secret — the hub hands it to anybody who asks, over plain HTTP, which is exactly how this server gets it.
- **Your network is the only access control there is.** If the hub is reachable from somewhere you would not want it driven from, that is true with or without this server.

## Nothing here is gated, and that is a finding

The sibling servers in this account gate the calls that spend money or reach the physical world irreversibly behind `confirm: true`. This one gates nothing, because there is nothing of that shape in the API: an activity can be started again, a power-off *is* an activity (the one with id `-1`), and an IR command is a keypress. A confirmation prompt on a reversible action is how a real one gets clicked through.

## What IR cannot tell you

An IR command is fire and forget, and at the wire level the protocol says so: a `holdAction` the hub accepts is never answered. At most an unrelated metadata notification arrives, carrying no correlation id at all.

So when `harmony_send_command` comes back, it is reporting that the hub emitted the code. It is **not** reporting that anything reacted to it. A speaker system on the wrong input, a television that was already off, a blocked emitter, a device unplugged this morning — all four look exactly like success from here, and every result that sends a code carries `confirmed: false` saying so.

What the hub *does* answer is a refusal, under the id the keypress went out with: `566 Command not found for device id` and `401 Bluetooth not paired` both arrive within a tenth of a second on a real hub. So every keypress waits `HARMONY_REFUSAL_WINDOW_MS` (800 ms) for an objection, and a refused one comes back as `emitted: false` with the hub's code and message rather than as a code that went out.

The one check this server *can* make on your behalf, and does, is that the device and the command both exist in the hub's own configuration. A misspelt `Volumeup` is emitted as nothing at all and answered with the same empty notification as a real command, so without that check the room simply stays quiet and the tool call says it worked.

---

## Tool reference

| Tool | Parameters | What it does / returns |
| --- | --- | --- |
| `harmony_status` | — | Hub address, remote id, firmware, how many activities and devices, and what is running. The tool to call first when anything is wrong. |
| `harmony_list_activities` | — | `[{ id, label, current? }]`, with the running one marked. |
| `harmony_list_devices` | — | `[{ id, label, type, manufacturer, model }]`. |
| `harmony_list_commands` | `device_id` (required) | Every IR command name the hub holds for that device — the vocabulary `harmony_send_command` accepts. |
| `harmony_current_activity` | — | `{ id, label }`, or `null` when everything is off. |
| `harmony_start_activity` | `activity_id` (required) | Starts it and waits for the hub to report it finished starting. Returns `started: false` with the hub's own error code if it did not. |
| `harmony_power_off` | — | Everything off. Reversible: start any activity to come back. |
| `harmony_send_command` | `device_id`, `command` (required); `hold_ms`, `repeat` (optional) | One IR command. `hold_ms` 0–5000, `repeat` 1–10, both clamped. Always `confirmed: false`. |

### Example

```jsonc
// Which devices are there?
{ "name": "harmony_list_devices", "arguments": {} }

// What can the amplifier do?
{ "name": "harmony_list_commands", "arguments": { "device_id": "20000001" } }

// Switch it to its optical input
{ "name": "harmony_send_command",
  "arguments": { "device_id": "20000001", "command": "InputOptical" } }

// Nudge the volume up five steps
{ "name": "harmony_send_command",
  "arguments": { "device_id": "20000001", "command": "VolumeUp", "repeat": 5 } }
```

---

## What the hub does that cost an evening to find out

- **An accepted `holdAction` is never answered.** Awaiting a reply to a keypress burns the whole timeout, once per press. A repeat of three timed the tool call out entirely. There is no acknowledgement in the protocol to wait for, only a refusal.
- **An idle connection is dropped after 60 seconds.** This server therefore opens a socket per tool call and closes it again, rather than holding one open with a keepalive. A shared socket needs a ping, a reconnect path and a decision about calls that arrive during the gap — three mechanisms whose failure mode is a tool that works when used often and breaks when used once an hour, which is how a remote control is actually used.
- **The hub is inconsistent about `code`.** One command answers `200` the number, another `"200"` the string. A server that compared strictly against either reported every command of the other kind as an error.

The first release was written against a mock and the protocol notes. A real hub then showed five more, each of which broke it outright or cost a minute per call:

- **`activeRemoteId` is a number.** Not the string every write-up shows. A check for a string refused every real hub at the first call, with the id sitting in the answer.
- **The end of an activity is `harmony.engine?startActivityFinished`,** with no `vnd.logitech.harmony/vnd.logitech.` in front, although every request goes out with that prefix. Before it come an acknowledgement under the request's own id with code `200`, which is *not* the end, and progress frames `harmony.engine?startActivity` with `done` and `total`, code `100` on the way. Two starts send no `startActivityFinished` at all: the activity that is already running gets one progress frame, done 1 of 1, and PowerOff with everything off re-sends the power discretes as `harmony.engine?helpdiscretes`, ending with one more frame of that type without a counter. The server ends a start on whichever of the three arrives first.
- **Starting the activity that is already running costs a minute.** The hub answers with a single progress frame, done 1 of 1, never finishes the request, and then answers nothing else, `getCurrentActivity` included, until the 60-second timeout in the request's envelope has run out. Measured: the next answer came at 60.5 s; with a 5-second envelope it came at once. This server therefore does not send that start; it reports the activity as running. PowerOff with everything off is still sent, because there the hub re-sends the power-off codes and is done in seconds.
- **A refused keypress is answered.** See [What IR cannot tell you](#what-ir-cannot-tell-you).
- **`?config` can stop answering for good.** One hub did after its device list had been edited locally through `proxy.resource?put`; activities and keypresses kept working, `?config` said nothing for five minutes and more, and every tool here starts by reading it. A timeout now falls back to the hub's own lists, `harmony://Account/<account>/DeviceList` and `ActivityList`, addressed by the account id from the provisioning answer. The account id, like the e-mail address beside it, goes into no result. `harmony_status` reports which source it used as `config_source`, and the fallback labels every command with its own name, because those lists carry no button groups.

---

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `HARMONY_HUB_HOST` | — | Hub IP or hostname. Required. Validated as a hostname or IP literal and nothing else. |
| `HARMONY_HUB_REMOTE_ID` | discovered | Skip the provisioning round trip. `harmony_status` still asks the hub and warns if the two disagree. |
| `HARMONY_HUB_PORT` | `8088` | The hub's port. |
| `HARMONY_TIMEOUT_MS` | `10000` | Budget for a config read, a status query or a handshake. |
| `HARMONY_ACTIVITY_TIMEOUT_MS` | `45000` | Budget for an activity to finish starting. Generous because the hub walks a sequence of IR commands with deliberate gaps between them. |
| `HARMONY_REFUSAL_WINDOW_MS` | `800` | How long a keypress waits for the hub to refuse it. A real hub refuses within about a tenth of a second. |

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `HARMONY_HUB_HOST ist nicht gesetzt` | No address in env or keychain | Store one — see above. |
| `ist kein Hostname und keine IP` | The host has a scheme, path, port or `@` in it | Host only. The port is a separate variable. |
| `nicht erreichbar` / `antwortet nicht` | Wrong address, or a hub on another subnet or VLAN | Try the `curl` above from the same machine. |
| Reachable, until a VPN connects | The VPN published a route covering the hub's subnet | [See below](#a-vpn-can-swallow-the-hub). |
| `hat die Verbindung sofort geschlossen` | Wrong remote id | Unset `HARMONY_HUB_REMOTE_ID` and let it be discovered. |
| `Provisioning-Antwort ohne activeRemoteId` | Something on 8088 that is not a Harmony Hub | Check the address. |
| `kennt kein Kommando` | The command is not in the hub's list for that device | `harmony_list_commands` for the real spelling; they are case-sensitive. |
| `Hub lehnt ab (401): Bluetooth not paired` | The device is driven over Bluetooth and the hub has lost its pairing with it | Pair again through the Harmony app. Until then, nothing the hub sends that device arrives, and an activity that powers it on over Bluetooth stalls at that step. |
| `config_source: "resources"` in `harmony_status` | The hub left `?config` unanswered | Nothing to fix here; the lists are read from the hub's resources instead. It costs one timeout per server process. |
| Command succeeds, nothing happens | IR reached nothing | Expected: the result says `confirmed: false`. Check line of sight, the device's input, and that the hub's emitter points at it. |
| `Zeitüberschreitung` on an activity | The hub is still working through the sequence | Raise `HARMONY_ACTIVITY_TIMEOUT_MS`. |

### A VPN can swallow the hub

A corporate VPN commonly publishes a route for the whole of `192.168.0.0/16` — which is to say, for most of the private address space the hub is likely to be sitting in. The machine's own subnet goes on working, because the directly-connected route for it is more specific and wins; every *other* address in that range is handed to the tunnel instead, and quietly goes nowhere. The hub becomes unreachable the moment the VPN comes up and reachable again when it drops, which from the outside looks like a flaky hub rather than a routing decision.

Ask the routing table rather than guessing. Put your hub's real address in, and note that this is the one command on this page that will not tell you when you forget: unlike the `curl` above, `route` answers happily for the documentation address too, and since `192.0.2.0/24` is nowhere near the private range, that answer is a confident `en0` — the opposite of the diagnosis.

```bash
HUB=<your hub's address>        # the one the curl above worked against
route -n get "$HUB"
```

An `interface:` of `utun<n>` instead of `en0` is the whole diagnosis, and the `destination` line will show the wide route that claimed it. There is nothing this server can do about it: either drop the VPN while using the hub, or have whoever runs it publish a narrower route.

Worth ruling out first, though, that the machine is on the network you think it is. If a broadcast ping turns up no neighbours at all, it is not a routing problem:

```bash
ping -c 3 192.168.1.255 >/dev/null; arp -an
```

---

## Releasing

Publishing uses npm Trusted Publishing (OIDC) — there is no npm token anywhere.

```bash
npm version patch && git push --follow-tags
```

### If the publish fails with 404

The Trusted Publisher is not configured yet for this package. On npmjs.com → the package → Settings → Trusted Publisher, set user `sapn95`, repository `harmony-mcp`, workflow `release.yml`, allowed action `npm publish`.

---

## Checks

```bash
npm run gate      # syntax, lint, smoke, hygiene, tests with a coverage floor
npm run mutate    # mutation-test just the lines this branch changed
```

The gate runs, in order: a syntax check, ESLint, an offline protocol smoke test, the hygiene scan, and the suites under a coverage floor of 90% lines, 90% functions and 80% branches.

The suites drive the server over stdio against a mock that serves the hub's provisioning endpoint and its WebSocket interface on one local port. No test can reach a real hub, the real login keychain, or anything on the internet — the address is pinned to `127.0.0.1` with a port nothing listens on unless a test hands over the mock's, and a `security` that finds nothing goes first on `PATH`. The mock is deliberately hostile where a real hub is: it answers `code` as a number on one command and a string on another, sends the remote id as a number, never answers an accepted `holdAction` but answers a refused one, acknowledges an activity under its id long before the unprefixed notification that ends it, and can be told to close the socket on connect, refuse the upgrade, start an activity that never finishes, or leave `?config` unanswered for good. Each of those shapes was recorded off a real hub, and four of them were missing from the first release's mock, which is how that release passed every test and failed against the real thing at the first call.

`scripts/hygiene.mjs` scans both the staged and the working-tree copy of every tracked file for secrets, for anything that looks like a real person's detail, for a commit identity that is not anonymous, and for a lockfile claiming it fetched a package from a registry other than the public one. `test/hygiene.test.mjs` proves the scanner itself, against throwaway repositories built per case — including filenames git has to quote and paths whose bytes are not valid UTF-8, both of which it once skipped in silence while reporting every file clean.

That last rule is there because the lockfile leaked before it existed. `npm install` writes a `resolved` URL per package, so whatever registry the machine was pointed at gets committed; on a work machine that is an internal mirror, and several hundred of its URLs went out in a public repository before anything noticed. Nothing above caught it, because a bare hostname is not a credential. The rule lists the registry that *is* allowed rather than the ones that are not, for the reason the name list is kept outside the repository entirely: naming the internal host in order to forbid it would publish it in the file whose job is to keep it out. `.npmrc` pins the default registry so the URLs are mostly not written in the first place. Only mostly, and the gap is worth naming: `@scope:registry` is a separate npm config key rather than an override of `registry`, so a scoped mapping set at user level still wins for that scope, and this project installs several scoped packages. Listing them in `.npmrc` would only move the problem along to the first scoped dependency added after the list was written. The scan is what closes it, because it reads every `resolved` URL in the lockfile regardless of scope and regardless of which machine wrote the file.

### Mutation testing

`npm run mutate:all` runs Stryker over the whole of `index.js`. The guards in this server are all of the shape mutation testing is good at catching: the host pattern, the command-exists check, the clamps, the loose `code` comparison. Each is a line that can be deleted while every test stays green, and that is the question worth asking of them.

---

## License

MIT © sapn95 — see [LICENSE](LICENSE).
