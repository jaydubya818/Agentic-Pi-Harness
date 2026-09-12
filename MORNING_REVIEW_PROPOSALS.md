# Morning Review Proposals — 2026-05-17

These proposals were surfaced by the weekly Morning Review synthesizer and routed
to this repo because they were tagged with the `pi_agent` target. They are
proposals only — review, refine, and decide whether to act.

---

## Extract Asana's agent architecture patterns for pi_agent design reference

The Asana JD reveals a mature agent platform architecture: separate teams for
Agent Orchestration, AI Chat, Teammates Platform (execution engine + capability
layer), and Teammates Experience (UI). They explicitly separate model
integration/rollout, proactive agent behavior, developer platform, and
quality/eval infrastructure as distinct ownership areas. This maps closely to
pi_agent's concerns as it grows beyond a single-machine harness.

**TODO**: Identify which of these layers currently exist in pi_agent (even
informally), which are absent, and which would be premature given the current
scope. Document the intended decomposition before more agent surface area is
added.

Source: `weekly_2026-05-17.md` candidate `d1e1c164-e41`
