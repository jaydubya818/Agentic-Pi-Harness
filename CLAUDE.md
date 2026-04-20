# Claude Code defaults for this repo

Default concise-response mode in this repo: **Caveman lite**.

Use these defaults unless the user asks for more detail:

- **Normal repo responses:** concise, clear, technically exact, low-fluff
- **Code review comments:** caveman-review style — one-line findings with severity, problem, fix
- **Commit message suggestions:** caveman-commit style — Conventional Commits, terse subject, why over what
- **General engineering work:** compress wording, not substance

Do **not** compress away important details for:
- governed execution behavior
- KB/Wiki policy boundaries
- contract/state/event semantics
- safety constraints
- migration or operational steps
- exact commands, paths, IDs, schemas, or failure modes

If the user explicitly asks for a detailed explanation, fuller reasoning, or formal wording, expand as needed.
