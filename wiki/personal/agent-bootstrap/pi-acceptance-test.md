# Pi acceptance test

## Goal

Confirm the local Pi harness golden path still works end to end:

- run
- write artifacts
- verify the replay tape
- confirm effect and policy logs exist

## Quick run

Harness-native helper:

```bash
npm run acceptance:pi
```

Equivalent packaged CLIs:

```bash
pi-harness acceptance-pi
kb session acceptance pi
```

## Optional paths

Default locations:

- workdir: `.pi-acceptance-work`
- out root: `.pi-acceptance-out`

Custom locations:

```bash
npm run acceptance:pi -- ./tmp/pi-work ./tmp/pi-out
```

With trace capture:

```bash
npm run acceptance:pi -- ./tmp/pi-work ./tmp/pi-out --trace=./tmp/pi-trace.jsonl
```

## Pass criteria

A passing run reports:

- Pi acceptance test: `PASS`
- a new session id
- a verifiable tape path
- effect log path exists
- policy log path exists
- checkpoint path exists
- digest present
- non-zero tape record count

## What it does under the hood

The helper runs the existing golden-path mock flow, then:

1. locates `tapes/<session>.jsonl`
2. verifies the tape hash chain
3. confirms effect log exists
4. confirms policy log exists
5. confirms checkpoint exists
6. prints artifact paths for inspection

## Failure hints

- tape verification failed → inspect the reported tape path and run `pi-harness verify <tape>`
- missing effect log or policy log → inspect the session directory under the reported out root
- unexpected runtime failure → rerun with a dedicated workdir/out root to isolate artifacts

## Related commands

```bash
pi-harness run ./.pi-work ./.pi-out
pi-harness verify ./.pi-out/tapes/<session>.jsonl
pi-harness replay ./.pi-out/tapes/<session>.jsonl
```
