# Roadmap

Living document. Updated on release. See `CHANGELOG.md` for shipped work.

## Now — v0.2.0 (observability + semantic drift)

Target: 2 weeks out. Covers ADR 0004 surfaces C1 and C2.

- [ ] OTel metrics: swap `src/metrics/counter.ts` for `@opentelemetry/api` Meter
- [ ] Prometheus scrape endpoint on `runQueryLoop` output (optional, flag-gated)
- [ ] `pino` structured logging, one JSONL line per decision / retry / hook outcome
- [ ] OTel spans: per-turn root, per-tool-call children, per-hook children
- [ ] Semantic decision hash — canonicalized `{result, effect-class, surface-area}`
- [ ] `compare-effects.mjs --semantic` flag for rule-id-agnostic drift detection
- [ ] CI adds a mutation test: change a rule id, drift check should still pass
- [ ] Dashboards as committed JSON (Grafana-importable)

## Next — v0.3.0 (Windows + real pi.dev integration)

Target: 4–6 weeks out.

- [ ] Windows path separator + worktree cleanup (ADR 0004 C3)
- [ ] Real pi.dev provider replacing `MockModelClient` in the golden path
- [ ] Cost tracking — plumb `costTableVersion` into effect records
- [ ] `PolicyEngine` rule inheritance — rules can extend other rules
- [ ] Hook shell-contract executor (documented in HOOK-SECURITY, not yet wired)

## Later — v0.4.0+ (parked)

Not committed to a release. Open to reshuffling.

- Parallel sub-agents with merge conflict resolution
- Content-addressable replay store (distributed)
- Signed plugin registry with revocation
- Budget enforcement (token + wall-clock, not just retry counts)
- Multi-model fallback chains inside `runQueryLoop`
- Rich compaction strategies: semantic summarization, token-aware
- Tier C decision-log semantic equivalence beyond the basic hash

## Rejected

Documented decisions that are not happening. Each references the ADR that
killed it, so we don't re-litigate.

- **GPG-signed replay tapes** — see ADR 0002. HMAC chain is sufficient; GPG
  adds key management without adding attacker-relevant security.
- **In-place compaction** — see ADR 0003. Compaction mutates in place would
  diverge tape from in-memory record.
- **Two-tier A split "runtime only"** — see ADR 0001. A-runtime and A-proof
  are inseparable; shipping one without the other is not a release.
