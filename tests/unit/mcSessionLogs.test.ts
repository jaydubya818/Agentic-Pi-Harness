import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSessionLogRefs, redactedExcerpt } from "../../src/mc/sessionLogs.js";

const createdPaths: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdPaths.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("redactedExcerpt", () => {
  const seededSecrets = [
    "sk-abcdefgh12345678",
    "ghp_ABCDEFGHIJKLMNOPqrstuv1234567890",
    "xoxb-1234567890-abcdefghij",
    "xoxp-1234567890-abcdefghij",
    "AKIAABCDEFGHIJKLMNOP",
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----",
  ];

  it.each(seededSecrets.map((secret) => [secret]))("removes secret pattern %s", (secret) => {
    const text = `before ${secret} after`;
    const excerpt = redactedExcerpt(text, 10_000);
    expect(excerpt).not.toContain(secret);
    expect(excerpt).toContain("[REDACTED]");
  });

  it("removes every seeded secret from a combined log", () => {
    const text = seededSecrets.map((secret, index) => `line ${index}: token=${secret}`).join("\n");
    const excerpt = redactedExcerpt(text, 100_000);
    for (const secret of seededSecrets) expect(excerpt).not.toContain(secret);
  });

  it("respects maxBytes with tail truncation (keeps the newest lines)", () => {
    const text = `${"a".repeat(5000)}\nTERMINAL LINE`;
    const excerpt = redactedExcerpt(text, 64);
    expect(Buffer.byteLength(excerpt, "utf8")).toBeLessThanOrEqual(64);
    expect(excerpt).toContain("TERMINAL LINE");
  });

  it("returns short text unchanged when under the byte budget", () => {
    expect(redactedExcerpt("harmless log line", 4096)).toBe("harmless log line");
  });

  it("does not split multi-byte characters at the truncation boundary", () => {
    const text = "é".repeat(100);
    const excerpt = redactedExcerpt(text, 33);
    expect(excerpt).not.toContain("�");
    expect(Buffer.byteLength(excerpt, "utf8")).toBeLessThanOrEqual(33);
  });
});

describe("buildSessionLogRefs", () => {
  it("computes the correct sha256 and size for a fixture file", async () => {
    const dir = await makeTempDir("mc-logs-");
    const filePath = join(dir, "events.jsonl");
    const content = '{"event":"run.completed"}\n';
    await writeFile(filePath, content, "utf8");

    const refs = await buildSessionLogRefs([{ kind: "BRIDGE_EVENTS", path: filePath }]);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("BRIDGE_EVENTS");
    expect(refs[0].path).toBe(filePath);
    expect(refs[0].sha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(refs[0].sizeBytes).toBe(Buffer.byteLength(content, "utf8"));
    expect(refs[0].excerpt).toContain("run.completed");
  });

  it("skips missing files instead of throwing", async () => {
    const dir = await makeTempDir("mc-logs-");
    const existing = join(dir, "hermes.raw.log");
    await writeFile(existing, "worker output", "utf8");

    const refs = await buildSessionLogRefs([
      { kind: "HERMES_SESSION", path: existing },
      { kind: "PI_TAPE", path: join(dir, "does-not-exist.jsonl") },
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("HERMES_SESSION");
  });

  it("redacts secrets in the excerpt but hashes the raw content", async () => {
    const dir = await makeTempDir("mc-logs-");
    const filePath = join(dir, "hermes.raw.log");
    const content = "auth sk-abcdefgh12345678 done\n";
    await writeFile(filePath, content, "utf8");

    const refs = await buildSessionLogRefs([{ kind: "HERMES_SESSION", path: filePath }], { excerptMaxBytes: 4096 });
    expect(refs[0].excerpt).not.toContain("sk-abcdefgh12345678");
    expect(refs[0].excerpt).toContain("[REDACTED]");
    expect(refs[0].sha256).toBe(createHash("sha256").update(content).digest("hex"));
  });

  it("bounds excerpts to excerptMaxBytes", async () => {
    const dir = await makeTempDir("mc-logs-");
    const filePath = join(dir, "big.log");
    await writeFile(filePath, "x".repeat(10_000), "utf8");

    const refs = await buildSessionLogRefs([{ kind: "BRIDGE_EVENTS", path: filePath }], { excerptMaxBytes: 128 });
    expect(Buffer.byteLength(refs[0].excerpt ?? "", "utf8")).toBeLessThanOrEqual(128);
    expect(refs[0].sizeBytes).toBe(10_000);
  });
});
