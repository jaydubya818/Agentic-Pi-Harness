# KB Access Policy V1

## Purpose

This document defines the minimum safe operating policy for shared knowledge use between **Pi** and **Hermes** across:

- `~/Agentic-KB` — governed operational memory / system of record
- `~/My LLM Wiki` — broader research, synthesis, and working knowledge

This is the **v1 enforcement policy**. It is intentionally narrow.

---

## Core model

### Pi
Pi is the:
- supervisor
- governor
- reviewer
- normalizer
- promoter of canonical truth

Pi may read both repos and write both repos.

### Hermes
Hermes is a governed worker agent.

Hermes may:
- read both repos
- write only to explicitly approved **non-canonical** zones
- propose candidate knowledge
- never directly modify canonical knowledge

### Canonical rule
Nothing becomes trusted or canonical unless **Pi explicitly writes or promotes it into canonical directories in `~/Agentic-KB`**.

---

## Repository roles

## `~/Agentic-KB`
Governed operational memory and system of record.

Contains:
- contracts
- standards
- promoted knowledge
- supervision records
- mission/run-scoped governed artifacts
- discovery and handoff intake

Does **not** contain:
- freeform scratch notes
- mixed-trust drafts
- personal synthesis pages
- unreviewed research as canonical memory

## `~/My LLM Wiki`
Broader research, synthesis, and working knowledge space.

Contains:
- drafts
- research notes
- topic pages
- syntheses
- working notes
- exploratory material

Everything in `~/My LLM Wiki` is **untrusted by default**.

---

## Approved v1 directory model

## `~/Agentic-KB`

```text
~/Agentic-KB/
  contracts/
  standards/
  knowledge/
    promoted/
  queues/
    discovery/
  handoffs/
    inbound/
  staging/
    normalized/
  supervision/
    reviews/
    approvals/
    rejections/
  archive/
    rejected/
  missions/
    YYYY/
      mission-<mission_id>/
        runs/
          run-<run_id>/
            request/
            outputs/
            traces/
            supervision/
```

## `~/My LLM Wiki`

```text
~/My LLM Wiki/
  inbox/
  drafts/
  research/
  working-notes/
  syntheses/
  topic-pages/
  archive/
```

---

## Permission policy

## Pi permissions
Pi may read and write all paths in both repos.

## Hermes permissions
Hermes may write **only** to:

- `~/My LLM Wiki/**`
- `~/Agentic-KB/queues/discovery/**`
- `~/Agentic-KB/handoffs/inbound/**`
- `~/Agentic-KB/missions/YYYY/mission-<mission_id>/runs/run-<run_id>/outputs/**`
- `~/Agentic-KB/missions/YYYY/mission-<mission_id>/runs/run-<run_id>/traces/**`

Hermes may **not** write to:

- `~/Agentic-KB/contracts/**`
- `~/Agentic-KB/standards/**`
- `~/Agentic-KB/knowledge/**`
- `~/Agentic-KB/staging/normalized/**`
- `~/Agentic-KB/supervision/**`
- `~/Agentic-KB/archive/**`
- `~/Agentic-KB/missions/**/request/**`
- `~/Agentic-KB/missions/**/supervision/**`

---

## Path rules by directory

| Path | Purpose | Pi write | Hermes write | Notes |
|---|---|---:|---:|---|
| `contracts/` | canonical contracts | Y | N | Pi-only canonical |
| `standards/` | canonical standards | Y | N | Pi-only canonical |
| `knowledge/promoted/` | promoted trusted knowledge | Y | N | Pi-only canonical |
| `queues/discovery/` | candidate discoveries | Y | Y | Hermes create-only preferred |
| `handoffs/inbound/` | worker-to-Pi handoffs | Y | Y | Hermes create-only preferred |
| `staging/normalized/` | Pi-normalized promotion candidates | Y | N | Pi-only in v1 |
| `supervision/reviews/` | review records | Y | N | Pi-only |
| `supervision/approvals/` | approval records | Y | N | Pi-only |
| `supervision/rejections/` | rejection records | Y | N | Pi-only |
| `archive/rejected/` | rejected candidate artifacts | Y | N | predictable rejection bucket |
| `missions/.../request/` | immutable request envelope | Y | N | Pi-only, frozen after create |
| `missions/.../outputs/` | run-scoped worker outputs | Y | Y | Hermes write allowed |
| `missions/.../traces/` | run-scoped traces/logs | Y | limited | Hermes append-only or create-only |
| `missions/.../supervision/` | run-scoped supervision record | Y | N | Pi-only |
| `~/My LLM Wiki/**` | working knowledge | Y | Y | untrusted by default |

---

## Immutable and append-only rules

### Immutable
These paths are immutable after creation except by Pi in explicit repair scenarios:

- `~/Agentic-KB/missions/YYYY/mission-<mission_id>/runs/run-<run_id>/request/**`

Rule:
- Pi creates request envelope once
- Hermes may read it
- Hermes may never edit, replace, or delete it

### Append-only
These paths should be append-only or create-new-file only:

- `~/Agentic-KB/missions/**/traces/**`

Rules:
- Hermes should append to existing trace logs or create new trace files
- Hermes should not rewrite historical trace files in place
- Pi may compact, summarize, or archive traces later if needed

Preferred implementation:
- one file per event stream, append-only
- or one new file per trace segment

---

## Trust model

| Trust level | Meaning |
|---|---|
| `canonical` | trusted operational memory |
| `staged` | normalized and review-ready, not yet canonical |
| `queue` | intake/candidate material awaiting review |
| `scratch` | provisional working material |
| `external` | imported or outside-origin material |

## Trust mapping

| Path | Trust |
|---|---|
| `~/Agentic-KB/contracts/**` | canonical |
| `~/Agentic-KB/standards/**` | canonical |
| `~/Agentic-KB/knowledge/promoted/**` | canonical |
| `~/Agentic-KB/queues/discovery/**` | queue |
| `~/Agentic-KB/handoffs/inbound/**` | queue |
| `~/Agentic-KB/staging/normalized/**` | staged |
| `~/Agentic-KB/supervision/**` | canonical record |
| `~/Agentic-KB/missions/**/outputs/**` | staged |
| `~/Agentic-KB/missions/**/traces/**` | trace / non-canonical |
| `~/My LLM Wiki/**` | scratch / working / untrusted |

---

## Promotion rule

Promotion into canonical memory follows this rule:

1. Hermes or Pi produces candidate material in:
   - `queues/discovery/`
   - `handoffs/inbound/`
   - `missions/.../outputs/`
   - `~/My LLM Wiki/**`
2. Pi reviews the candidate
3. Pi normalizes it into:
   - `staging/normalized/`
4. Pi approves or rejects it
5. If approved, Pi writes canonical form into:
   - `knowledge/promoted/`
   - or another canonical Pi-only directory
6. If rejected, Pi records rejection in:
   - `supervision/rejections/`
   - and may move artifacts into `archive/rejected/`

Hermes never writes directly into canonical directories.

---

## Naming rules

## Mission folder
```text
mission-<mission_id>
```

Example:
```text
mission-pi-hermes-kb-policy
```

## Run folder
```text
run-<run_id>
```

Example:
```text
run-20260420T120000Z
```

## Discovery files
```text
disc-<date>-<topic>-<agent>-<run_id>.md
```

## Handoff files
```text
handoff-<from_agent>-to-pi-<mission_id>-<run_id>.md
```

## Trace files
```text
trace-<mission_id>-<run_id>.jsonl
trace-<mission_id>-<run_id>-part-<n>.jsonl
```

## Promoted files
```text
<topic>-<slug>.md
```

---

## Required frontmatter for any file entering `~/Agentic-KB`

Any non-trivial artifact written into `~/Agentic-KB` outside raw traces should include frontmatter.

Minimum required fields:

```yaml
id: <unique-id>
trust: canonical|staged|queue|scratch|external
created_by: pi|hermes
created_at: <ISO-8601>
mission_id: <mission-id>
run_id: <run-id>
source_paths:
  - /absolute/source/path
status: candidate|reviewed|approved|rejected|promoted
```

Recommended additional fields:

```yaml
reviewed_by: pi
reviewed_at: <ISO-8601>
promoted_from: /absolute/path
```

Exception:
- raw append-only trace files do not need markdown frontmatter

---

## Safety rules

1. **No concurrent writes to canonical files**
   - Pi is sole writer of canonical directories

2. **Hermes writes are run-scoped or queue-scoped**
   - no shared writable canonical namespace

3. **Queue zones are create-only where possible**
   - Hermes should create new items, not edit prior items

4. **Traces are append-only**
   - no in-place trace rewrites by Hermes

5. **Request envelopes are frozen**
   - created by Pi, read by Hermes, never edited by Hermes

6. **Normalization is Pi-only**
   - `staging/normalized/` stays Pi-only in v1

7. **Promotion is Pi-only**
   - no exceptions

8. **Working wiki is never trusted automatically**
   - material must be explicitly promoted to become canonical

---

## Minimal enforcement checklist

Implement in this order:

1. create the approved directory set
2. document allowed and forbidden write paths in agent policy
3. restrict Hermes writes to approved v1 zones
4. make Pi own normalization and promotion
5. test one mission end-to-end

---

## Final v1 decision

Adopt this exact v1 model:

- `~/Agentic-KB` is canonical and Pi-governed
- `~/My LLM Wiki` is shared working knowledge and untrusted by default
- Hermes writes only to queue, handoff, run output, and trace paths in `~/Agentic-KB`
- `staging/normalized/` is Pi-only
- `memory/hot/` is omitted from v1
- `missions/.../request/` is Pi-only and immutable
- `missions/.../traces/` is append-only
- all canonical promotion is Pi-only

This is the minimum safe, auditable, low-chaos operating policy for v1.
