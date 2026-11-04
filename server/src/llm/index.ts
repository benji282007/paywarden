import { GeminiLlm } from "./gemini.js";
import { OpenAiCompatLlm } from "./openai-compat.js";
import type { Llm } from "./types.js";

export interface LlmSet {
  /** Rule compiler and intent judge: structured output, latency tolerated. */
  reasoning?: Llm;
  /** Support bot: several turns per customer message, so the fastest available. */
  chat?: Llm;
}

/** Picks free-tier providers from env. Everything works with only GEMINI_API_KEY. */
export function llmsFromEnv(env: NodeJS.ProcessEnv = process.env): LlmSet {
  const gemini = env.GEMINI_API_KEY ? new GeminiLlm(env.GEMINI_API_KEY, env.GEMINI_MODEL) : undefined;
  const fast = env.GROQ_API_KEY
    ? new OpenAiCompatLlm("https://api.groq.com/openai/v1", env.GROQ_API_KEY, env.GROQ_MODEL ?? "openai/gpt-oss-120b")
    : env.OPENROUTER_API_KEY
      ? new OpenAiCompatLlm("https://openrouter.ai/api/v1", env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL ?? "meta-llama/llama-3.3-70b-instruct:free")
      : undefined;
  return { reasoning: gemini ?? fast, chat: fast ?? gemini };
}
