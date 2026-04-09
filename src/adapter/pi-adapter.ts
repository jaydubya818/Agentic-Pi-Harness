import { parseOrThrow, StreamEvent, StreamEventSchema } from "../schemas/index.js";

export interface ModelClient {
  name: string;
  stream(messages: unknown[]): AsyncIterable<StreamEvent>;
}

export interface GoldenPathScriptInput {
  targetPath: string;
}

function cloneEvent(event: StreamEvent): StreamEvent {
  return parseOrThrow(StreamEventSchema, JSON.parse(JSON.stringify(event)), "mock stream event");
}

function validateScript(script: StreamEvent[]): StreamEvent[] {
  return script.map((event, index) => parseOrThrow(StreamEventSchema, event, `mock script event ${index + 1}`));
}

export function createGoldenPathScript(input: GoldenPathScriptInput): StreamEvent[] {
  return [
    { type: "message_start", schemaVersion: 1 },
    { type: "text_delta", schemaVersion: 1, text: "Reading failing test." },
    { type: "tool_use", schemaVersion: 1, id: "t1", name: "read_file", input: { path: input.targetPath } },
    { type: "text_delta", schemaVersion: 1, text: "Patching." },
    {
      type: "tool_use",
      schemaVersion: 1,
      id: "t2",
      name: "write_file",
      input: { path: input.targetPath, content: "test('adds', () => { expect(1 + 1).toBe(2); });\n" },
    },
    { type: "message_stop", schemaVersion: 1, stopReason: "end_turn" },
  ];
}

/**
 * Deterministic mock model client for the Tier A golden path.
 * Ignores input messages and yields a schema-validated, cloned event stream.
 */
export class MockModelClient implements ModelClient {
  name = "mock";
  private readonly script: StreamEvent[];

  constructor(script: StreamEvent[]) {
    this.script = validateScript(script);
  }

  async *stream(_messages: unknown[]): AsyncIterable<StreamEvent> {
    for (const event of this.script) {
      yield cloneEvent(event);
    }
  }
}

export function createGoldenPathMockModelClient(input: GoldenPathScriptInput): ModelClient {
  return new MockModelClient(createGoldenPathScript(input));
}
