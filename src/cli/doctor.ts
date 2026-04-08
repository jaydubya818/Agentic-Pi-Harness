import { readFile } from "node:fs/promises";

interface Check { name: string; ok: boolean; detail?: string; }

export async function doctor(): Promise<Check[]> {
  const checks: Check[] = [];

  const [major] = process.versions.node.split(".").map(Number);
  checks.push({ name: "node >= 20", ok: major >= 20, detail: process.versions.node });

  try {
    const tv = await readFile(".tool-versions", "utf8");
    checks.push({ name: ".tool-versions present", ok: /nodejs/.test(tv) });
  } catch { checks.push({ name: ".tool-versions present", ok: false }); }

  try {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    checks.push({ name: "zod installed", ok: !!pkg.dependencies?.zod });
  } catch { checks.push({ name: "package.json", ok: false }); }

  return checks;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  doctor().then((cs) => {
    for (const c of cs) console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? " (" + c.detail + ")" : ""}`);
    process.exit(cs.every((c) => c.ok) ? 0 : 1);
  });
}
