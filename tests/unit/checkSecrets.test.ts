import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs guard script, no type declarations
import { classifyStagedPath, isGuardOwnFixture, scanContentForSecrets } from "../../scripts/check-secrets.mjs";

describe("staged-secret guard (RISK-REGISTER R11)", () => {
  it("flags key material by path", () => {
    expect(classifyStagedPath("keys/policy-signing.pem")).toMatch(/private key/);
    expect(classifyStagedPath("ops/bridge.key")).toMatch(/private key/);
    expect(classifyStagedPath(".env")).toMatch(/environment file/);
    expect(classifyStagedPath("deploy/.env.production")).toMatch(/environment file/);
    expect(classifyStagedPath("home/.ssh/id_ed25519")).toMatch(/ssh private key/);
  });

  it("leaves templates and ordinary source alone", () => {
    expect(classifyStagedPath(".env.example")).toBeNull();
    expect(classifyStagedPath(".env.sample")).toBeNull();
    expect(classifyStagedPath("src/hermes/httpBridge.ts")).toBeNull();
    expect(classifyStagedPath("docs/keys-and-rotation.md")).toBeNull();
  });

  it("flags self-identifying credentials in content", () => {
    expect(scanContentForSecrets("-----BEGIN RSA PRIVATE KEY-----\nMII...\n")).toContain("inline private key");
    expect(scanContentForSecrets(`const t = "AKIA${"A".repeat(16)}";`)).toContain("aws access key id");
    expect(scanContentForSecrets(`token: "ghp_${"a".repeat(36)}"`)).toContain("github personal access token");
    expect(scanContentForSecrets('PI_HERMES_BRIDGE_TOKEN="s3cr3t-literal"')).toContain("hardcoded bridge auth token");
    // Unquoted shell/.env assignment is the shape this token actually leaks in.
    expect(scanContentForSecrets("export PI_HERMES_BRIDGE_TOKEN=deadbeefcafe1234")).toContain("hardcoded bridge auth token");
    expect(scanContentForSecrets("PI_HERMES_BRIDGE_TOKEN: s3cr3t-literal")).toContain("hardcoded bridge auth token");
    // GitHub's non-PAT token prefixes are just as usable as ghp_.
    for (const prefix of ["gho_", "ghu_", "ghs_", "ghr_"]) {
      expect(scanContentForSecrets(`token: "${prefix}${"a".repeat(36)}"`)).toContain("github oauth/app token");
    }
    expect(scanContentForSecrets(`_authToken=npm_${"a".repeat(36)}`)).toContain("npm access token");
    expect(scanContentForSecrets(`key = "AIza${"a".repeat(35)}"`)).toContain("google api key");
  });

  it("exempts its own source and test from the content pass", () => {
    // Both files carry every pattern by construction; without the exemption
    // the guard refused any commit that touched them.
    expect(isGuardOwnFixture("scripts/check-secrets.mjs")).toBe(true);
    expect(isGuardOwnFixture("tests/unit/checkSecrets.test.ts")).toBe(true);
    expect(isGuardOwnFixture("src/hermes/httpBridge.ts")).toBe(false);
    expect(isGuardOwnFixture("scripts/check-schema-drift.mjs")).toBe(false);
  });

  it("does not trip on the hashes, digests, and signatures this repo commits", () => {
    const noise = [
      'policyDigest: "sha256:9f2c1b0e4a7d8c5f3e2b1a0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b"',
      'signature = "sha256-hmac:' + "0".repeat(64) + '"',
      'prevHash: "' + "0".repeat(64) + '"',
      "const key = process.env.PI_HERMES_BRIDGE_TOKEN;",
      'PI_HERMES_BRIDGE_TOKEN="$BRIDGE_TOKEN"',
      'PI_HERMES_BRIDGE_TOKEN=$BRIDGE_TOKEN',
      'export PI_HERMES_BRIDGE_TOKEN="$(/bin/cat "$TOKEN_FILE")"',
      "PI_HERMES_BRIDGE_TOKEN=",
      "authToken: process.env.PI_HERMES_BRIDGE_TOKEN,",
      "export const SECRET_HEADER = 'Authorization';",
    ].join("\n");
    expect(scanContentForSecrets(noise)).toEqual([]);
  });
});
