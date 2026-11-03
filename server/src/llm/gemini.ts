import type { ChatMessage, ChatPart, JsonSchema, Llm, ToolSpec } from "./types.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * Google Gemini over plain REST (free tier, no SDK). Free-tier latency is often
 * 10-20 s and we've seen transient 404s, so every call has a timeout and retries.
 */
export class GeminiLlm implements Llm {
  constructor(
    private readonly apiKey: string,
    readonly model = "gemini-flash-lite-latest",
  ) {}

  private async generate(body: unknown, timeoutMs: number): Promise<GeminiPart[]> {
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new LlmError(`Gemini timed out after ${timeoutMs} ms`);
      let res: Response;
      try {
        res = await fetch(`${BASE}/${this.model}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(remaining),
        });
      } catch (err) {
        throw new LlmError(`Gemini request failed: ${(err as Error).message}`);
      }
      const text = await res.text();
      if ([404, 429, 500, 503].includes(res.status) && attempt < 3 && deadline - Date.now() > 2000) {
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new LlmError(`Gemini ${res.status}: ${text.slice(0, 300)}`, res.status);
      const json = JSON.parse(text) as { candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[] };
      const parts = json.candidates?.[0]?.content?.parts;
      if (!parts) throw new LlmError(`Gemini returned no content (finish: ${json.candidates?.[0]?.finishReason ?? "none"})`);
      return parts;
    }
  }

  async json<T>({ system, prompt, schema, timeoutMs = 90_000 }: { system: string; prompt: string; schema: JsonSchema; timeoutMs?: number }): Promise<T> {
    const parts = await this.generate(
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, thinkingConfig: { thinkingLevel: "minimal" } },
      },
      timeoutMs,
    );
    const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("");
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new LlmError(`Gemini returned invalid JSON: ${text.slice(0, 200)}`);
    }
  }

  async chat({ system, messages, tools, timeoutMs = 90_000 }: { system: string; messages: ChatMessage[]; tools: ToolSpec[]; timeoutMs?: number }): Promise<ChatMessage> {
    const parts = await this.generate(
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map(toGemini),
        tools: tools.length ? [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }] : undefined,
        generationConfig: { thinkingConfig: { thinkingLevel: "minimal" } },
      },
      timeoutMs,
    );
    const out: ChatPart[] = [];
    parts.forEach((p, i) => {
      if (p.functionCall) {
        // The raw part carries Gemini's thought signature, which must be sent back unchanged.
        out.push({ kind: "call", id: p.functionCall.id ?? `call-${i}`, name: p.functionCall.name, args: p.functionCall.args ?? {}, raw: p });
      } else if (p.text && !p.thought) {
        out.push({ kind: "text", text: p.text });
      }
    });
    return { role: "model", parts: out };
  }
}

function toGemini(m: ChatMessage): { role: string; parts: GeminiPart[] } {
  return {
    role: m.role,
    parts: m.parts.map((p): GeminiPart => {
      if (p.kind === "text") return { text: p.text };
      if (p.kind === "call") return (p.raw as GeminiPart) ?? { functionCall: { id: p.id, name: p.name, args: p.args } };
      return { functionResponse: { id: p.id.startsWith("call-") ? undefined : p.id, name: p.name, response: { result: p.result } } };
    }),
  };
}
