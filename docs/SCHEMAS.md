# Schemas, Versioning & Canonicalization

## Rule: every persisted type has a Zod schema + `schemaVersion`

Persisted = anything written to disk, sent over the wire, or hashed. This includes `SessionContext`, `StreamEvent`, `ReplayTapeRecord`, `EffectRecord`, `PolicyDecision`, `Checkpoint`, `ProvenanceManifest`, `ToolAuditRecord`, `SanitizationRecord`, `HookAuditRecord`, `CompactionRecord`, `ToolManifest`.

Each schema lives in `src/schemas/<name>.ts` and exports:
```ts
export const FooSchema = z.object({ schemaVersion: z.literal(1), ... });
export type Foo = z.infer<typeof FooSchema>;
export const FOO_SCHEMA_VERSION = 1 as const;
```

`src/types.ts` re-exports inferred types only — no hand-written duplicates.

## Read path

All reads go through `parseOrThrow(schema, raw)`. No `as Foo` casts on deserialized data. CI lint rule forbids `as` on results of `JSON.parse` / `readFile` in `src/**`.

## Migration policy

- Bumping a schema version requires a migrator at `src/schemas/migrations/v<N>-to-v<N+1>.ts` with both forward tests and a round-trip test against a fixture tape.
- `pi-harness replay` refuses to migrate without `--compat` and a tested migrator.
- Pre-commit hook diffs `src/schemas/**` against the last tag and fails if `schemaVersion` wasn't bumped when a field changed.

## Canonicalization (for signing & hashing)

Used for: signed policy files, hash-chain record digests, `piMdDigest`, `policyDigest`.

**Procedure `canonicalize(value) -> Buffer`:**
1. Value must be JSON-serializable (no `undefined`, no functions, no `NaN`/`Infinity`).
2. Object keys sorted lexicographically (UTF-16 code units), recursively.
3. No insignificant whitespace. Separators: `,` and `:`.
4. Strings UTF-8. Unicode escapes lowercased (`\u00e9` not `\u00E9`).
5. Numbers: integers as integers, floats in shortest round-trip form (RFC 8785 §3.2.2.3).
6. Prepend framing line: `pi-policy-v1\n` for policy, `pi-tape-v1\n` for tape records, `pi-pimd-v1\n` for PI.md digest.

Implemented in `src/schemas/canonical.ts`. One function. Unit tests against RFC 8785 vectors.

## Signed policy

- Algorithm: HMAC-SHA256.
- Key: `~/.pi/keys/worker.key` (0600, 32 bytes). Never in env, never logged.
- Signature file: `<policy>.sig` — single line `sha256-hmac:<hex>`.
- Verify procedure: `verify(canonicalize(policyJson), sig, key)`. Fail-closed in worker mode; warn in interactive mode.
- `policyDigest` in the session manifest is `sha256(canonicalize(policyJson))` regardless of signing mode.
