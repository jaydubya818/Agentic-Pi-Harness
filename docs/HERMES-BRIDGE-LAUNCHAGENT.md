# Hermes Bridge LaunchAgent

Use this when you want the Pi→Hermes bridge running persistently on macOS instead of starting it by hand.

## What it creates

The setup script writes:

- `~/.pi/hermes-bridge-token`
- `~/.pi/run-hermes-bridge.sh`
- `~/Library/LaunchAgents/ai.pi.hermes-bridge.plist`

The bridge keeps its durable run/session state under:

- `~/.pi/hermes-bridge-state`

## Install

From the repo root:

```bash
scripts/setup-hermes-bridge-launchagent.sh --load
```

Dry run:

```bash
scripts/setup-hermes-bridge-launchagent.sh --dry-run
```

## Defaults

- bridge URL: `http://127.0.0.1:8787`
- LaunchAgent label: `ai.pi.hermes-bridge`
- auth: enabled via bearer token file

## Environment overrides

You can override these before running the script:

- `PI_HOME`
- `PI_HERMES_BRIDGE_STATE_ROOT`
- `PI_HERMES_BRIDGE_TOKEN_FILE`
- `PI_HERMES_BRIDGE_RUN_SCRIPT`
- `PI_HERMES_BRIDGE_PLIST`
- `PI_HERMES_BRIDGE_HOST`
- `PI_HERMES_BRIDGE_PORT`
- `PI_HERMES_BRIDGE_LOG`
- `PI_HERMES_BRIDGE_ERR_LOG`
- `PI_HERMES_BINARY`

## Control

Check service:

```bash
launchctl print gui/$UID/ai.pi.hermes-bridge
```

Restart:

```bash
launchctl bootout gui/$UID ~/Library/LaunchAgents/ai.pi.hermes-bridge.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.pi.hermes-bridge.plist
```

## Verify manually

```bash
TOKEN="$(cat ~/.pi/hermes-bridge-token)"
curl http://127.0.0.1:8787/healthz
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/meta
```

Or run the built-in doctor:

```bash
npm run hermes:doctor -- --url http://127.0.0.1:8787 --timeout-ms 180000
```
