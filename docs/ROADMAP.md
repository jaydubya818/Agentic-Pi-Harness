# Roadmap

Living document. Updated on release. See `CHANGELOG.md` for shipped work.

## Now — v0.2.0 (observability + semantic drift)

Target: 2 weeks out. Covers ADR 0004 surfaces C1 and C2.

- [ ] **Move off Node 20.** Node 20 reached end of life on 2026-04-30 and
      receives no further security patches; a CVE disclosed against it now is
      fixed in 22/24 and never backported. The repo pins it in three places
      that must move together: `.tool-versions` (`nodejs 20.11.1`),
      `engines.node` (`>=20.11.0`), and both `actions/setup-node` steps in
      `.github/workflows/ci.yml` (`node-version: "20"`). Bump to the current
      22 LTS and re-run the golden-proof job, which is the only place a
      runtime change can silently alter committed artifacts.

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
- [ ] Wire the hook shell-contract executor into the loop. The executor itself
      ships (`src/hooks/shellHook.ts`, `shellHook.test.ts`); what is missing is
      a path from a hook manifest to `makeShellHook`, and an export from
      `src/index.ts` so embedders can reach it at all.

## Later — v0.4.0+ (parked)

Not committed to a release. Open to reshuffling.

- Parallel sub-agents with merge conflict resolution
- Content-addressable replay store (distributed)
- Signed plugin registry with revocation
- Budget enforcement (token + wall-clock, not just retry counts)
- Multi-model fallback chains inside `runQueryLoop`
- Rich compaction strategies: semantic summarization, token-aware
- Tier C decision-log semantic equivalence beyond the basic hash

## Parked with a known design constraint

### MCP hosting (Tier C, ADR 0001 / ADR 0004)

Not scheduled, and nothing in `src/` speaks MCP today. Recorded here so the
design is not started against a stale reading of the protocol: the
`2026-07-28` MCP specification revision changes the shape an MCP host would
have to implement.

- The core protocol is **stateless**: the `initialize`/`initialized`
  handshake and the `Mcp-Session-Id` header are gone. A host built around a
  per-connection session handle would be modelling something the protocol no
  longer has.
- Routing moved to **request headers**, and list results are **cacheable**.
- **Dynamic Client Registration is deprecated** in favour of CIMD.
- **Tasks** moved out of core into the `io.modelcontextprotocol/tasks`
  extension.
- **Roots, Sampling, and Logging are deprecated** on a 12-month window.

Implication for this repo when the surface is picked up: the bridge's
session-oriented control plane (`POST /sessions` → `execute` → close) is a
Pi-Hermes contract, not an MCP one, and must not be reused as the MCP
transport model. Verify against the spec revision current at the time —
this note is a pointer, not a substitute.

## Rejected

Documented decisions that are not happening. Each references the ADR that
killed it, so we don't re-litigate.

- **GPG-signed replay tapes** — see ADR 0002. HMAC chain is sufficient; GPG
  adds key management without adding attacker-relevant security.
- **In-place compaction** — see ADR 0003. Compaction mutates in place would
  diverge tape from in-memory record.
- **Two-tier A split "runtime only"** — see ADR 0001. A-runtime and A-proof
  are inseparable; shipping one without the other is not a release.
