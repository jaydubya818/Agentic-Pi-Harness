import { mkdtemp, mkdir, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { writeKnowledgeText } = await import("./src/hermes/kbAccessPolicy.ts");
const base = await mkdtemp(join(tmpdir(), "kbpoc-"));
const kb = join(base, "Agentic-KB");
const wiki = join(base, "wiki");
await mkdir(join(kb, "knowledge/promoted"), { recursive: true });
await mkdir(wiki, { recursive: true });
// symlinked dir inside wiki -> canonical KB promoted dir
await symlink(join(kb, "knowledge/promoted"), join(wiki, "notes"));
const events = [];
await writeKnowledgeText({
  actor: "hermes",
  path: join(wiki, "
