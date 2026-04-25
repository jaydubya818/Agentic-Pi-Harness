export type AgenticKbAccessMode = "auto" | "local" | "http" | "disabled";
export type MemorySource = "local" | "http" | "none";
export type MemorySourceMode = "local" | "http" | "cli";

export interface MemorySearchOptions {
  limit?: number;
}

export interface MemorySearchResult {
  slug: string;
  title: string;
  path: string;
  content: string;
  score: number;
  source: MemorySourceMode | Exclude<MemorySource, "none">;
  snippet?: string;
  visibility?: string;
}

export interface MemoryArticle {
  slug: string;
  title: string;
  path: string;
  content: string;
  source?: MemorySourceMode | Exclude<MemorySource, "none">;
}

export interface MemoryDocument extends MemoryArticle {}

export interface AgentContextLoadOptions {
  project?: string;
}

export interface AgentContextItem {
  path: string;
  title: string;
  content: string;
  className?: string;
  scope?: string;
  bytes?: number;
}

export interface AgentContextBundle {
  agentId: string;
  source: MemorySourceMode | Exclude<MemorySource, "none">;
  budgetBytes?: number;
  bytesUsed?: number;
  items: AgentContextItem[];
  rawOutput?: string;
}

export interface ScopedContextFile {
  path: string;
  class?: string;
  reason: string;
  bytes?: number;
  priority?: number;
  content?: string;
}

export interface ScopedContextBundle {
  agentId: string;
  tier?: string;
  files: ScopedContextFile[];
  trace?: Record<string, unknown>;
}

export interface MemoryCloseTaskPayload {
  project?: string;
  taskLogEntry?: string;
  hotUpdate?: string;
  gotcha?: string;
  discoveries?: unknown[];
  escalations?: unknown[];
  rewrites?: unknown[];
}

export interface MemoryCloseTaskResult {
  performed: boolean;
  reason?: string;
  output?: string;
}

export interface MemoryHealthCheck {
  enabled: boolean;
  ok: boolean;
  mode: AgenticKbAccessMode | MemorySourceMode;
  reason?: string;
  kbRoot?: string;
  apiUrl?: string;
}

export interface MemoryEvidence {
  kind: "search" | "agent-context";
  title: string;
  path?: string;
  slug?: string;
  reason: string;
  excerpt: string;
  score?: number;
  source: Exclude<MemorySource, "none">;
}

export interface MemoryContextRequest {
  query?: string;
  agentId?: string;
  project?: string;
  maxResults?: number;
  budgetChars?: number;
}

export interface MemoryContextPack {
  used: boolean;
  available: boolean;
  source: MemorySource;
  query?: string;
  agentId?: string;
  project?: string;
  items: MemoryEvidence[];
  text: string;
  budgetChars: number;
  usedChars: number;
  truncated: boolean;
  warnings: string[];
}

export interface MemoryProvider {
  search(query: string, options?: MemorySearchOptions | number): Promise<MemorySearchResult[]>;
  buildContextPack(input: MemoryContextRequest): Promise<MemoryContextPack>;
  healthCheck(): Promise<MemoryHealthCheck>;
  loadAgentContext(agentId: string, options?: AgentContextLoadOptions): Promise<AgentContextBundle | null>;
  get?(slug: string): Promise<MemoryDocument | null>;
  readArticle?(slug: string): Promise<MemoryArticle | null>;
  loadScopedContext?(agentId: string, project?: string): Promise<ScopedContextBundle | null>;
  closeAgentTask?(agentId: string, payload: MemoryCloseTaskPayload): Promise<MemoryCloseTaskResult>;
}
