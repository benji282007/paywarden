# Gemini review (Nov 2, pasted by the user)

Scores: Tech 8 · Design 7 · Impact 7 · Innovation 9 · Presentation 10. Win probability
"high for a top-3 finish or Best Use of Agentic Commerce, provided the demo actually works."

Reasons it could lose, with fixes:
1. "Taint tracking" as token provenance is impossible → call it heuristic context
   matching (args that map to strings in untrusted text), be honest in the README.
2. An LLM judge in the tool-call path adds 2–5 s → keep the LLM out of runtime; compile
   English rules to deterministic logic at setup time.
3. Render free tier cold starts (~50 s) → ping every 10 min (GitHub Actions or an uptime
   monitor).

Impact: pitch Paywarden as "the security prerequisite that finally allows merchants to
turn on agentic refunds", the enabler of the market.

Alternatives: stick with Paywarden (disputes saturated, AgentGate hard to demo, others
thin on PayPal or dashboard-like).

Technical notes: proxying MCP means handling JSON-RPC in flight (doable, budget time);
PayPal sandbox accounts can behave inconsistently (a past Devpost project, "Ledger Case",
saw Japanese sandbox accounts fail USD refunds) → require a US sandbox business account;
stateful ledger grounding is a technical flex worth emphasizing.

Single biggest change: make Policy CI the star. A "Policy Studio" where the merchant types
a rule, hits Compile & Test, and watches ~50 simulated chats (25 attacks, 25 genuine)
light up a grid of green checks and red blocks in real time.
