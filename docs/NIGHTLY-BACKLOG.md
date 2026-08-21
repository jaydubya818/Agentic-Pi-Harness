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

## Closed

_(none yet — this file was created by the 2026-08-21 run)_

## Checked, not applicable

- 2026-08-21 — Node 20 EOL toolchain bump — real and urgent, but already tracked in `docs/ROADMAP.md` ("Move off Node 20") with the three pin sites enumerated. Not re-proposed here. One new data point from this run: the full suite (365 tests), `typecheck`, `lint`, `build`, and `golden:verify`/`golden:replay` all pass unmodified on Node **v24.18.1**, and the committed golden digest is unchanged, so the runtime bump is lower-risk than the roadmap entry assumes. The blocker is process, not code: the `actions/setup-node` pins live in `.github/workflows/ci.yml`, which the nightly token cannot push.
- 2026-08-21 — zod 3.25.76 → 4.x — zod 4 is current, but every persisted artifact in this repo is defined by a zod schema and the Tier A contract is the schema surface. A major bump ripples through `src/schemas/*`, the contract envelopes, and the golden digests simultaneously. Too large for a nightly; needs its own change with a golden re-baseline.
- 2026-08-21 — `npm` `allowScripts` pinning for `node-pty` / `esbuild` / `fsevents` — npm 11 prompts to approve install scripts and writes an `allowScripts` block into `package.json`. Genuine supply-chain hardening, but it is npm-11-only, changes install behaviour for every consumer of a published package, and was surfaced as a side effect of the nightly's own install rather than as a repo need. Not landed unilaterally.
