import { StreamEvent } from "../schemas/index.js";

export interface ModelClient {
  name: string;
  stream(messages: unknown[]): AsyncIterable<StreamEvent>;
}

/**
 * Mock model client for the golden path. Emits a scripted stream.
 */
export class MockModelClient implements ModelClient {
  name = "mock";
  constructor(private script: StreamEvent[]) {}
  async *stream(): AsyncIterable<StreamEvent> {
    for (const e of this.script) yield e;
  }
}
