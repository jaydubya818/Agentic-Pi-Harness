# Nightly backlog

Items the nightly maintenance pass surfaced but did not land, plus items it
checked and deliberately rejected. Keeping the rejections here stops later
runs from re-proposing work that was already considered.

Roadmap items live in `docs/ROADMAP.md`; this file is only for things the
nightly pass raised. Where an item is already tracked on the roadmap it is
referenced rather than duplicated.

## Open

- [ ] 2026-08-21 — Persist `accepted_at` on bridge run records — `GET /runs?limit=N` documents itself as tailing the most recent runs, but a restored run carries no acceptance timestamp, so after a restart the order is only a proxy (session `created_at`, then `execution_id`) rather than true acceptance order.
- [ ] 2026-08-21 — Decide the ESLint path — `eslint 8.57.1` has had no security patches since 2024-10-05, and 9.x reached EOL on 2026-08-06, so a 8→9 bump lands on an already-dead line. Only 10.x is supported; that is a flat-config migration, not a version bump.
- [ ] 2026-08-21 — Sort `metrics.json` keys before writing — `Counters.snapshot()` returns `Object.fromEntries` of a `Map`, so key order is first-increment order, and `safeWriteJson` uses `JSON.stringify` rather than `canonicalize`. Two runs with identical counters can produce byte-different artifacts.
- [ ] 2026-08-21 (2nd pass) — Persist `LoopResult.sanitizations` to its own artifact — the typed `SanitizationRecord`s now survive the loop, but only in memory. Every sibling record type has a durable sink (`effects.jsonl`, `policy.jsonl`), so a run's sanitization history still dies with the process and `verify`/`replay` cannot check it. Wants a `sanitizations.jsonl` alongside the others plus a `LoopInputs.sanitizationLogPath`. Held back from the applying commit to keep that change additive-only and leave the golden digest untouched.
- [ ] 2026-08-21 (2nd pass) — Design proposal: make the trust label on tool output checkable — `wrapToolOutput` carries `trusted="false"` and the tool identity as text *inside* the payload they describe, which `syntheses/synthesis-telephone-game-per-claim-confidence` names as the case where the invariant stops being checkable: a dropped tag is indistinguishable from one that was never added. Escaping and pre-dispatch policy enforcement mean this is defence in depth rather than the only defence, so it is not urgent. A real fix means carrying trust as a structured field on `ToolResultEvent` and having the adapter re-render it at the model boundary — that changes `StreamEventSchema`, so it changes every tape hash and forces a golden re-baseline. Architectural, not surgical; recorded here rather than attempted. See `docs/HARNESS-INVARIANTS.md` invariant 3.

## Closed

- [x] 2026-08-21 (2nd pass) — Sofie certified completion over a failed build — `answerRoutineQuestion` read `targetSummary.installOk/lintOk/buildOk` for presence but never for value, so a target whose lint and build both failed still returned `verdict: answer`, "review passes within bounded authority", and `closureRecommendation: complete`. Fixed on `nightly/2026-08-21-improvements`; see `docs/HARNESS-INVARIANTS.md` invariant 4.
- [x] 2026-08-21 (2nd pass) — `SanitizationRecord` had no producer — the loop computed the record and discarded it, making tool-output truncation and tag-escaping measurable only by regex-scraping the payload. `LoopResult.sanitizations` now carries it. Persisting it is still open, above.
- [x] 2026-08-21 (2nd pass) — `bridgeStateStore.test.ts` flaked ~1 run in 3 — ENOTEMPTY from the `afterEach` recursive rm racing APFS, not from any assertion. 5 failures in 15 runs before, 0 in 20 after adding `maxRetries`/`retryDelay`.

## Checked, not applicable

- 2026-08-21 — Node 20 EOL toolchain bump — real and urgent, but already tracked in `docs/ROADMAP.md` ("Move off Node 20") with the three pin sites enumerated. Not re-proposed here. One new data point from this run: the full suite (365 tests), `typecheck`, `lint`, `build`, and `golden:verify`/`golden:replay` all pass unmodified on Node **v24.18.1**, and the committed golden digest is unchanged, so the runtime bump is lower-risk than the roadmap entry assumes. The blocker is process, not code: the `actions/setup-node` pins live in `.github/workflows/ci.yml`, which the nightly token cannot push.
- 2026-08-21 — zod 3.25.76 → 4.x — zod 4 is current, but every persisted artifact in this repo is defined by a zod schema and the Tier A contract is the schema surface. A major bump ripples through `src/schemas/*`, the contract envelopes, and the golden digests simultaneously. Too large for a nightly; needs its own change with a golden re-baseline.
- 2026-08-21 (2nd pass) — `resolveExecutable` PATH fallback — `src/hermes/transport.ts` resolves a bare command against `env.PATH ?? process.env.PATH`, so a caller who deliberately passed a `PATH`-less env to sandbox a child would get the binary located via the *harness's* PATH and then spawned with an env lacking it. Not reachable today: the only caller (`HermesAdapter`) always spreads `process.env`. Could not construct a failing case through a public entry point, so it is recorded as a finding rather than fixed. See `docs/HARNESS-INVARIANTS.md`.
- 2026-08-21 — `npm` `allowScripts` pinning for `node-pty` / `esbuild` / `fsevents` — npm 11 prompts to approve install scripts and writes an `allowScripts` block into `package.json`. Genuine supply-chain hardening, but it is npm-11-only, changes install behaviour for every consumer of a published package, and was surfaced as a side effect of the nightly's own install rather than as a repo need. Not landed unilaterally.
