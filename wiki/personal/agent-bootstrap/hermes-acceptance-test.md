# Hermes acceptance test

## Goal

Confirm the Hermes bridge path is healthy, authenticated, and able to complete a governed supervised run.

## Operational note

The default helper path is now self-contained:

- it starts a temporary local bridge automatically
- it generates an in-memory token automatically
- it does not require a KB web server

## Quick run

Harness-native helper:

```bash
npm run acceptance:hermes
```

Equivalent packaged CLIs:

```bash
pi-harness acceptance-hermes
kb session acceptance hermes
```

Use external mode only when you explicitly want to target an already-running bridge:

```bash
pi-harness acceptance-hermes --url http://127.0.0.1:8787
kb session acceptance hermes --url http://127.0.0.1:8787
```

## Inputs

Optional flags:

- `--embedded` — force self-contained mode
- `--external` — force external-bridge mode
- `--url <url>` — external bridge URL; implies external mode
- `--token <token>` — explicit bearer token for external mode
- `--token-file <path>` — token file for external mode, default `~/.pi/hermes-bridge-token`
- `--workdir <path>` — workdir to use for the smoke task
- `--timeout-ms <ms>` — max wait for completion
- `--command <path>` — Hermes binary path for embedded mode when auto-detection is not enough

## Pass criteria

A passing run reports:

- Hermes acceptance test: `PASS`
- bridge health endpoint reachable
- auth enforced on unauthenticated `/meta`
- authenticated `/meta` succeeds
- session creation succeeds
- execute request accepted
- supervised run reaches `completed`
- PTY transport metadata present

## Failure hints

- `Hermes binary not found for embedded acceptance` → install Hermes, set `HERMES_COMMAND`, or pass `--command <path>`
- `bridge token available` failed → only relevant in external mode; set `PI_HERMES_BRIDGE_TOKEN` or create `~/.pi/hermes-bridge-token`
- `bridge healthz reachable` failed → only relevant in external mode; start the bridge first
- `bridge execute smoke test completes` failed → inspect bridge logs and Hermes runtime output
- auth failures → verify token matches the bridge process

## Related commands

```bash
npm run hermes:bridge -- --host 127.0.0.1 --port 8787 --auth-token "$PI_HERMES_BRIDGE_TOKEN"
npm run hermes:doctor -- --url http://127.0.0.1:8787
```
