// Provider-agnostic LLM surface. Paywarden needs two things: structured JSON answers
// (rule compiler, intent judge) and a tool-calling chat loop (the support bot).

export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export type ChatPart =
  | { kind: "text"; text: string }
  | { kind: "call"; id: string; name: string; args: Record<string, unknown>; raw?: unknown }
  | { kind: "result"; id: string; name: string; result: unknown };

export interface ChatMessage {
  role: "user" | "model";
  parts: ChatPart[];
}

export interface Llm {
  readonly model: string;
  /** One structured answer validated by the provider against `schema`. */
  json<T>(input: { system: string; prompt: string; schema: JsonSchema; timeoutMs?: number }): Promise<T>;
  /** One model turn: either text, tool calls, or both. */
  chat(input: { system: string; messages: ChatMessage[]; tools: ToolSpec[]; timeoutMs?: number }): Promise<ChatMessage>;
}
