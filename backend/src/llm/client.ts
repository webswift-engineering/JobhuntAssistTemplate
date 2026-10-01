import { z } from "zod";
import { config } from "../config.js";

export class LlmUnavailableError extends Error {
  constructor(msg = "LLM not configured (no DEEPSEEK_API_KEY)") {
    super(msg);
    this.name = "LlmUnavailableError";
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmClient {
  readonly enabled: boolean;
  /** Complete a chat returning JSON validated against `schema`. Retries once on parse failure. */
  completeJson<T>(messages: ChatMessage[], schema: z.ZodType<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// LLM health tracking — lets the dashboard show whether calls actually work
// (the `enabled` flag only means a key is configured, not that calls succeed).
// ---------------------------------------------------------------------------

export type LlmStatus = "ok" | "error" | "idle" | "disabled";

export interface LlmHealth {
  enabled: boolean;
  status: LlmStatus;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  totalCalls: number;
  totalFailures: number;
  consecutiveFailures: number;
}

const llmStats = {
  lastOkAt: null as number | null,
  lastErrorAt: null as number | null,
  lastError: null as string | null,
  totalCalls: 0,
  totalFailures: 0,
  consecutiveFailures: 0,
};

// ---------------------------------------------------------------------------
// Usage sink — every completed call reports its token counts here. index.ts wires
// the sink to the llm_usage table (spend meter); tests and CLIs leave it unset.
// ---------------------------------------------------------------------------

export interface LlmUsageEvent {
  at: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  ok: boolean;
}

let usageSink: ((e: LlmUsageEvent) => void) | null = null;

export function setLlmUsageSink(fn: ((e: LlmUsageEvent) => void) | null): void {
  usageSink = fn;
}

function emitUsage(e: LlmUsageEvent): void {
  if (!usageSink) return;
  try {
    usageSink(e);
  } catch (err) {
    console.warn("[llm] usage sink failed:", (err as Error).message);
  }
}

function recordLlmOk(): void {
  llmStats.lastOkAt = Date.now();
  llmStats.consecutiveFailures = 0;
}

function recordLlmError(message: string): void {
  llmStats.lastErrorAt = Date.now();
  llmStats.lastError = message.slice(0, 300);
  llmStats.totalFailures++;
  llmStats.consecutiveFailures++;
}

export function getLlmHealth(): LlmHealth {
  const enabled = getLlm().enabled;
  let status: LlmStatus;
  if (!enabled) status = "disabled";
  else if (llmStats.totalCalls === 0) status = "idle";
  else if (llmStats.consecutiveFailures > 0) status = "error";
  else status = "ok";
  return { enabled, status, ...llmStats };
}

function extractJson(text: string): unknown {
  // Tolerate ```json fences and leading prose.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const startArr = candidate.indexOf("[");
  const begin =
    start === -1 ? startArr : startArr === -1 ? start : Math.min(start, startArr);
  if (begin === -1) throw new Error("No JSON found in LLM response");
  const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
  return JSON.parse(candidate.slice(begin, end + 1));
}

/** DeepSeek via OpenAI-compatible /chat/completions. */
export class DeepSeekClient implements LlmClient {
  constructor(
    private readonly apiKey = config.llm.apiKey,
    private readonly model = config.llm.model,
    private readonly baseUrl = config.llm.baseUrl
  ) {}

  get enabled(): boolean {
    return this.apiKey.trim() !== "";
  }

  async completeJson<T>(messages: ChatMessage[], schema: z.ZodType<T>): Promise<T> {
    if (!this.enabled) throw new LlmUnavailableError();
    llmStats.totalCalls++;
    try {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        const { content, usage } = await this.rawComplete(messages, attempt > 0);
        emitUsage({ at: Date.now(), model: this.model, ok: true, ...usage });
        try {
          const parsed = schema.parse(extractJson(content));
          recordLlmOk();
          return parsed;
        } catch (err) {
          lastErr = err;
        }
      }
      throw new Error(
        `LLM JSON validation failed after retry: ${
          lastErr instanceof Error ? lastErr.message : String(lastErr)
        }`
      );
    } catch (err) {
      recordLlmError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private async rawComplete(
    messages: ChatMessage[],
    stricter: boolean
  ): Promise<{ content: string; usage: { promptTokens: number; completionTokens: number } }> {
    const sys: ChatMessage = {
      role: "system",
      content: stricter
        ? "Respond with ONLY valid minified JSON. No prose, no markdown fences."
        : "You return strict JSON only.",
    };
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [sys, ...messages],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) {
      throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty LLM response");
    return {
      content,
      usage: {
        promptTokens: Number(data.usage?.prompt_tokens ?? 0),
        completionTokens: Number(data.usage?.completion_tokens ?? 0),
      },
    };
  }
}

let _client: LlmClient | null = null;
export function getLlm(): LlmClient {
  if (!_client) _client = new DeepSeekClient();
  return _client;
}

/** Test seam. */
export function setLlm(client: LlmClient): void {
  _client = client;
}
