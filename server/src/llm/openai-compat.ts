import { LlmError } from "./gemini.js";
import type { ChatMessage, ChatPart, JsonSchema, Llm, ToolSpec } from "./types.js";

type OaMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

/**
 * Any OpenAI-compatible chat endpoint with a free tier (Groq, OpenRouter). Used for the
 * support bot when its key is set, because Gemini's free tier can take 15-45 s per turn.
 */
export class OpenAiCompatLlm implements Llm {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    readonly model: string,
  ) {}

  private async complete(body: Record<string, unknown>, timeoutMs: number) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, ...body }),
        signal: AbortSignal.timeout(timeoutMs),
      }).catch((err: Error) => {
        throw new LlmError(`${this.model} request failed: ${err.message}`);
      });
      const text = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new LlmError(`${this.model} ${res.status}: ${text.slice(0, 300)}`, res.status);
      const json = JSON.parse(text) as {
        choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
      };
      return json.choices[0].message;
    }
  }

  async json<T>({ system, prompt, schema, timeoutMs = 60_000 }: { system: string; prompt: string; schema: JsonSchema; timeoutMs?: number }): Promise<T> {
    const msg = await this.complete(
      {
        messages: [
          { role: "system", content: `${system}\nRespond with JSON only, matching this JSON Schema:\n${JSON.stringify(schema)}` },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
      },
      timeoutMs,
    );
    try {
      return JSON.parse(msg.content ?? "") as T;
    } catch {
      throw new LlmError(`${this.model} returned invalid JSON`);
    }
  }

  async chat({ system, messages, tools, timeoutMs = 60_000 }: { system: string; messages: ChatMessage[]; tools: ToolSpec[]; timeoutMs?: number }): Promise<ChatMessage> {
    const oa: OaMessage[] = [{ role: "system", content: system }];
    for (const m of messages) {
      const texts = m.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text);
      const calls = m.parts.filter((p): p is Extract<ChatPart, { kind: "call" }> => p.kind === "call");
      const results = m.parts.filter((p): p is Extract<ChatPart, { kind: "result" }> => p.kind === "result");
      if (m.role === "model") {
        oa.push({
          role: "assistant",
          content: texts.join("\n") || null,
          tool_calls: calls.length ? calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) : undefined,
        });
      } else {
        for (const r of results) oa.push({ role: "tool", tool_call_id: r.id, content: JSON.stringify(r.result) });
        if (texts.length) oa.push({ role: "user", content: texts.join("\n") });
      }
    }
    const msg = await this.complete(
      {
        messages: oa,
        tools: tools.length ? tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) : undefined,
      },
      timeoutMs,
    );
    const parts: ChatPart[] = [];
    if (msg.content) parts.push({ kind: "text", text: msg.content });
    for (const c of msg.tool_calls ?? []) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(c.function.arguments || "{}");
      } catch {
        /* malformed arguments: pass none, the tool will reject */
      }
      parts.push({ kind: "call", id: c.id, name: c.function.name, args });
    }
    return { role: "model", parts };
  }
}
