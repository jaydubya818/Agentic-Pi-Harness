import { describe, it, expect } from "vitest";
import { canonicalize, sha256Hex } from "../../src/schemas/canonical.js";

describe("canonicalize", () => {
  it("sorts object keys", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it("drops undefined", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });
  it("rejects NaN", () => {
    expect(() => canonicalize({ a: NaN })).toThrow();
  });
  it("is stable across key insertion order", () => {
    expect(sha256Hex(canonicalize({ x: 1, y: 2 }))).toBe(sha256Hex(canonicalize({ y: 2, x: 1 })));
  });
  it("handles nested", () => {
    expect(canonicalize({ z: [3, 1, 2], a: { c: 1, b: 2 } })).toBe('{"a":{"b":2,"c":1},"z":[3,1,2]}');
  });
});
