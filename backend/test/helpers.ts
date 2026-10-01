import { z } from "zod";
import { createTestDb } from "../src/db/client.js";
import type { ChatMessage, LlmClient } from "../src/llm/client.js";

export { createTestDb };

/** A mock LlmClient that returns a scripted object for the next completeJson call. */
export class MockLlm implements LlmClient {
  enabled = true;
  private queue: unknown[] = [];
  public calls: ChatMessage[][] = [];

  constructor(public failTimes = 0) {}

  push(obj: unknown): this {
    this.queue.push(obj);
    return this;
  }

  async completeJson<T>(messages: ChatMessage[], schema: z.ZodType<T>): Promise<T> {
    this.calls.push(messages);
    if (this.failTimes > 0) {
      this.failTimes--;
      throw new Error("mock LLM forced failure");
    }
    const next = this.queue.shift();
    if (next === undefined) throw new Error("MockLlm queue empty");
    return schema.parse(next);
  }
}

/** A disabled LLM (forces heuristic / fallback code paths). */
export class DisabledLlm implements LlmClient {
  enabled = false;
  async completeJson<T>(): Promise<T> {
    throw new Error("disabled");
  }
}
