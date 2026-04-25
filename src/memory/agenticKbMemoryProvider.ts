import { access, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type {
  AgentContextBundle,
  AgentContextItem,
  AgenticKbAccessMode,
  AgentContextLoadOptions,
  MemoryCloseTaskPayload,
  MemoryCloseTaskResult,
  MemoryContextPack,
  MemoryContextRequest,
  MemoryDocument,
  MemoryEvidence,
  MemoryHealthCheck,
  MemoryProvider,
  MemorySearchOptions,
  MemorySearchResult,
} from "./types.js";
import { buildMemoryContextPack, normalizeAgentContextItem, titleFromPath } from "./contextPackBuilder.js";

export interface CommandRunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunnerOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type CommandRunner = (command: string, args: string[], options?: CommandRunnerOptions) => Promise<CommandRunnerResult>;

export interface AgenticKbMemoryProviderOptions {
  kbRoot?: string;
  apiUrl?: string;
  accessMode?: AgenticKbAccessMode;
  maxResults?: number;
  contextBudgetChars?: number;
  privatePin?: string;
  anthropicApiKey?: string;
  writeEnabled?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  commandRunner?: CommandRunner;
}

interface HttpSearchResponse {
  results?: Array<{
    snippet?: string;
    score?: number;
    meta?: {
      slug?: string;
      title?: string;
      type?: string;
      visibility?: string;
    };
  }>;
}

export class AgenticKbMemoryProvider implements MemoryProvider {
  private readonly kbRoot: string | null;
  private readonly apiUrl: string | null;
  private readonly accessMode: AgenticKbAccessMode;
  private readonly maxResults: number;
  private readonly contextBudgetChars: number;
  private readonly privatePin: string | null;
  private readonly writeEnabled: boolean;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly commandRunner: CommandRunner;

  constructor(options: AgenticKbMemoryProviderOptions = {}) {
    this.kbRoot = options.kbRoot ? resolve(options.kbRoot) : null;
    this.apiUrl = options.apiUrl ?? null;
    this.accessMode = options.accessMode ?? "auto";
    this.maxResults = options.maxResults ?? 5;
    this.contextBudgetChars = options.contextBudgetChars ?? 12_000;
    this.privatePin = options.privatePin ?? null;
    this.writeEnabled = options.writeEnabled ?? false;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
  }

  async healthCheck(): Promise<MemoryHealthCheck> {
    const mode = await this.resolveMode();
    if (mode === "disabled") {
      return {
        enabled: false,
        ok: false,
        mode,
        reason: this.kbRoot ? "Agentic-KB path missing or inaccessible" : "Agentic-KB path not configured",
        kbRoot: this.kbRoot ?? undefined,
        apiUrl: this.apiUrl ?? undefined,
      };
    }
    if (mode === "http" && !this.apiUrl) {
      return {
        enabled: false,
        ok: false,
        mode,
        reason: "KB API URL not configured",
        kbRoot: this.kbRoot ?? undefined,
        apiUrl: this.apiUrl ?? undefined,
      };
    }
    return {
      enabled: true,
      ok: true,
      mode,
      kbRoot: this.kbRoot ?? undefined,
      apiUrl: this.apiUrl ?? undefined,
    };
  }

  async search(query: string, options: MemorySearchOptions | number = {}): Promise<MemorySearchResult[]> {
    const mode = await this.resolveMode();
    const limit = Math.min(typeof options === "number" ? options : options.limit ?? this.maxResults, this.maxResults);
    if (mode === "local") return this.searchLocal(query, limit);
    if (mode === "http") return this.searchHttp(query, limit);
    return [];
  }

  async get(slug: string): Promise<MemoryDocument | null> {
    const mode = await this.resolveMode();
    if (mode === "local") return this.getLocal(slug);
    if (mode === "http") return this.getHttp(slug);
    return null;
  }

  async readArticle(slug: string): Promise<MemoryDocument | null> {
    return this.get(slug);
  }

  async loadAgentContext(agentId: string, options: AgentContextLoadOptions = {}): Promise<AgentContextBundle | null> {
    const mode = await this.resolveMode();
    if (mode !== "local" || !this.kbRoot) return null;
    const cliPath = join(this.kbRoot, "cli", "kb.js");
    try {
      await access(cliPath);
    } catch {
      return null;
    }

    const args = [cliPath, "agent", "context", agentId];
    if (options.project) args.push("--project", options.project);
    const result = await this.commandRunner(process.execPath, args, {
      cwd: this.kbRoot,
      env: process.env,
      timeoutMs: this.timeoutMs,
    });
    if (result.exitCode !== 0) return null;

    const parsed = parseAgentContextOutput(result.stdout);
    const items: AgentContextItem[] = [];
    for (const file of parsed.files) {
      const absolutePath = join(this.kbRoot, file.path);
      const content = await readFile(absolutePath, "utf8");
      items.push(normalizeAgentContextItem(file.path, capContent(content, this.contextBudgetChars), file.className, file.scope, file.bytes));
    }

    return {
      agentId,
      source: "cli",
      budgetBytes: parsed.budgetBytes,
      bytesUsed: parsed.bytesUsed,
      items,
      rawOutput: result.stdout,
    };
  }

  async loadScopedContext(agentId: string, project?: string) {
    const bundle = await this.loadAgentContext(agentId, { project });
    if (!bundle) return null;
    return {
      agentId,
      files: bundle.items.map((item) => ({
        path: item.path,
        class: item.className,
        reason: item.scope ? `class=${item.className ?? "unknown"} scope=${item.scope}` : "scoped context",
        bytes: item.bytes,
        content: item.content,
      })),
      trace: {
        budget_bytes: bundle.budgetBytes,
        budget_used: bundle.bytesUsed,
      },
    };
  }

  async closeAgentTask(agentId: string, payload: MemoryCloseTaskPayload): Promise<MemoryCloseTaskResult> {
    if (!this.writeEnabled) return { performed: false, reason: "writeback disabled by default" };
    const mode = await this.resolveMode();
    if (mode !== "local" || !this.kbRoot) return { performed: false, reason: "writeback requires local Agentic-KB access" };

    const cliPath = join(this.kbRoot, "cli", "kb.js");
    const payloadPath = join(this.kbRoot, ".pi-close-task-payload.json");
    const { writeFile, rm } = await import("node:fs/promises");
    await writeFile(payloadPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    try {
      const args = [cliPath, "agent", "close-task", agentId, "--payload", payloadPath];
      const result = await this.commandRunner(process.execPath, args, {
        cwd: this.kbRoot,
        env: process.env,
        timeoutMs: this.timeoutMs,
      });
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "close-task failed");
    } finally {
      await rm(payloadPath, { force: true });
    }
    return { performed: true };
  }

  async buildContextPack(input: MemoryContextRequest): Promise<MemoryContextPack> {
    const query = input.query?.trim();
    const agentId = input.agentId?.trim();
    const project = input.project?.trim();
    const limit = input.maxResults ?? this.maxResults;
    const budgetChars = input.budgetChars ?? this.contextBudgetChars;
    const memoryResults = query ? await this.search(query, { limit }) : [];
    const agentContext = agentId ? await this.loadAgentContext(agentId, { project }) : null;

    const items: MemoryEvidence[] = [
      ...memoryResults.map((result): MemoryEvidence => ({
        kind: "search",
        title: result.title,
        path: result.path,
        slug: result.slug,
        reason: query ? `search match for "${query}"` : "search match",
        excerpt: result.snippet ?? result.content,
        score: result.score,
        source: result.source === "http" ? "http" : "local",
      })),
      ...(agentContext?.items.slice(0, limit).map((item): MemoryEvidence => ({
        kind: "agent-context",
        title: item.title,
        path: item.path,
        reason: item.className ? `class=${item.className}${item.scope ? ` scope=${item.scope}` : ""}` : "scoped context",
        excerpt: item.content,
        source: agentContext.source === "http" ? "http" : "local",
      })) ?? []),
    ];

    const available = (await this.healthCheck()).ok;
    const source = memoryResults.some((result) => result.source === "http") || agentContext?.source === "http" ? "http" : items.length > 0 ? "local" : "none";
    const warnings: string[] = [];
    if (query && memoryResults.length === 0) warnings.push(`No Agentic-KB search matches for "${query}"`);
    if (agentId && !agentContext) warnings.push(`No scoped Agentic-KB context available for agent ${agentId}`);

    return buildMemoryContextPack({
      source,
      available,
      query,
      agentId,
      project,
      items,
      warnings,
      budgetChars,
    });
  }

  private async resolveMode(): Promise<AgenticKbAccessMode> {
    if (this.accessMode === "disabled") return "disabled";
    if (this.accessMode === "local") return await this.hasReadableKbRoot() ? "local" : "disabled";
    if (this.accessMode === "http") return this.apiUrl ? "http" : "disabled";
    if (await this.hasReadableKbRoot()) return "local";
    if (this.apiUrl) return "http";
    return "disabled";
  }

  private async hasReadableKbRoot(): Promise<boolean> {
    if (!this.kbRoot) return false;
    try {
      await access(join(this.kbRoot, "wiki"));
      return true;
    } catch {
      return false;
    }
  }

  private async searchLocal(query: string, limit: number): Promise<MemorySearchResult[]> {
    if (!this.kbRoot) return [];
    const wikiRoot = join(this.kbRoot, "wiki");
    const files = await collectMarkdownFiles(wikiRoot);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results: MemorySearchResult[] = [];

    for (const file of files) {
      const content = await readFile(file, "utf8");
      const rel = relative(wikiRoot, file).replace(/\\/g, "/");
      const slug = rel.replace(/\.md$/i, "");
      const title = frontmatterTitle(content) ?? titleFromPath(rel);
      const haystack = `${title}\n${content}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) {
          score += 1;
          if (title.toLowerCase().includes(term)) score += 2;
        }
      }
      if (score === 0) continue;
      results.push({
        slug,
        title,
        path: `wiki/${rel}`,
        content: capContent(content, Math.min(this.contextBudgetChars, 1200)),
        snippet: capContent(content, 220),
        score,
        source: "local",
      });
    }

    return results.sort((left, right) => right.score - left.score).slice(0, limit);
  }

  private async getLocal(slug: string): Promise<MemoryDocument | null> {
    if (!this.kbRoot) return null;
    const filePath = join(this.kbRoot, "wiki", `${slug}.md`);
    try {
      const content = await readFile(filePath, "utf8");
      return {
        slug,
        title: frontmatterTitle(content) ?? titleFromPath(slug),
        path: `wiki/${slug}.md`,
        content,
        source: "local",
      };
    } catch {
      return null;
    }
  }

  private async searchHttp(query: string, limit: number): Promise<MemorySearchResult[]> {
    if (!this.apiUrl) return [];
    const params = new URLSearchParams({ q: query, limit: String(limit), scope: this.privatePin ? "all" : "public" });
    const response = await this.fetchImpl(`${this.apiUrl}/api/search?${params.toString()}`, {
      headers: this.privatePin ? { "x-private-pin": this.privatePin } : undefined,
    });
    if (!response.ok) return [];
    const payload = await response.json() as HttpSearchResponse;
    return (payload.results ?? []).map((result) => ({
      slug: result.meta?.slug ?? "unknown",
      title: result.meta?.title ?? result.meta?.slug ?? "unknown",
      path: `wiki/${result.meta?.slug ?? "unknown"}.md`,
      content: result.snippet ?? "",
      snippet: result.snippet ?? "",
      score: result.score ?? 1,
      visibility: result.meta?.visibility,
      source: "http",
    }));
  }

  private async getHttp(slug: string): Promise<MemoryDocument | null> {
    if (!this.apiUrl) return null;
    const response = await this.fetchImpl(`${this.apiUrl}/wiki/${slug}`, {
      headers: this.privatePin ? { "x-private-pin": this.privatePin } : undefined,
    });
    if (!response.ok) return null;
    const content = await response.text();
    return {
      slug,
      title: titleFromPath(slug),
      path: `wiki/${slug}.md`,
      content,
      source: "http",
    };
  }
}

async function collectMarkdownFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectMarkdownFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(fullPath);
  }
  return files;
}

function frontmatterTitle(content: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  for (const line of match[1].split("\n")) {
    const titleMatch = line.match(/^title:\s*(.+)$/);
    if (!titleMatch) continue;
    return titleMatch[1].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

function capContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, Math.max(0, maxChars - 15))}\n...[truncated]`;
}

interface ParsedContextFile {
  className?: string;
  path: string;
  scope?: string;
  bytes?: number;
}

function parseAgentContextOutput(stdout: string): { bytesUsed?: number; budgetBytes?: number; files: ParsedContextFile[] } {
  const budgetMatch = stdout.match(/Budget:\s*(\d+)\/(\d+)\s*bytes/i);
  const files = stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("  ["))
    .map((line): ParsedContextFile | null => {
      const match = line.match(/^\s*\[(.+?)\]\s+(.+?)\s+\((\d+)B\)\s+—\s+(.+)$/);
      if (!match) return null;
      const reason = match[4];
      const classMatch = reason.match(/class=(\S+)/);
      const scopeMatch = reason.match(/scope=(.+)$/);
      return {
        className: classMatch?.[1],
        path: match[2],
        scope: scopeMatch?.[1],
        bytes: Number(match[3]),
      };
    })
    .filter((item): item is ParsedContextFile => item !== null);
  return {
    bytesUsed: budgetMatch ? Number(budgetMatch[1]) : undefined,
    budgetBytes: budgetMatch ? Number(budgetMatch[2]) : undefined,
    files,
  };
}

async function defaultCommandRunner(command: string, args: string[], options: CommandRunnerOptions = {}): Promise<CommandRunnerResult> {
  const { spawn } = await import("node:child_process");
  return await new Promise<CommandRunnerResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutHandle = options.timeoutMs ? setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs) : null;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolvePromise({
        stdout,
        stderr: timedOut ? `${stderr}\ncommand timed out`.trim() : stderr,
        exitCode: code ?? (timedOut ? 124 : 1),
      });
    });
  });
}
