# Paywarden — design (locked 2026-11-01)

> Give your support agent refund powers without giving it your bank account.

Paywarden is a policy-enforcing MCP proxy between a merchant's AI support agent and
PayPal (Agent Toolkit tools). Other tools cap how much an agent spends. Paywarden
checks whether each payout is *legitimate*.

## How we chose it
Three review rounds with independent agents: 4 ideation lenses → 4 judge personas
(PayPal DevRel, PayPal PM + Eng Manager, sponsor bench, red-team veteran) → a cold
critic and a source-level technical check. Two of the four judges ranked this #1, and so did the red team (feasibility 8/10, fragility 4/10).
The dispute copilot was runner-up: weaker innovation (Chargeflow etc. exist) and the
sandbox dispute-create API likely needs an account manager.

## Target user
Developer / ops lead at a $2–20M D2C brand on PayPal wiring an AI support agent
(custom, or Intercom Fin / Gorgias custom actions) to PayPal refund tools.

## Differentiators (vs PolicyLayer, Invariant Guardrails, AffixIO, other entries)
1. **Provenance taint** — every string that came from a customer-writable PayPal field
   (order description/note, dispute message, invoice memo) is tagged untrusted. A
   money-moving call influenced by tainted text is held, and the tainted span is shown.
2. **Ledger grounding** — rules are evaluated against live PayPal state, not just call
   args: captured amount minus prior refunds, capture belongs to the authenticated
   chat customer, no duplicate refund (toolkit has no idempotency, issue #98).
   Missing `amount` on `create_refund` = full refund, and is treated as such.
3. **Policy CI** — plain-English rules compile (LLM) to a visible DSL; the DSL is
   enforced deterministically. An auto-generated suite of attacks + legitimate requests
   runs before go-live: "24/24 attacks blocked, 40/40 legit passed, p50 180 ms".

Decision order: deterministic policy is authoritative. The LLM intent judge can only
tighten (allow → hold/block), never loosen — it reads untrusted text, so it can be
injected too. Every decision records which layer made it.

## Demo (3-minute video storyboard)
| Time | Beat |
|---|---|
| 0:00 | ForcedLeak (Agentforce, CVSS 9.4) + Air Canada chatbot liability → "your support bot can now refund real PayPal money" |
| 0:15 | Acme Coffee bot, tool list straight from PayPal Agent Toolkit; one line of config points it at Paywarden |
| 0:35 | Merchant types 3 rules in English → compiled DSL → Run policy tests: 24 blocked / 40 passed |
| 0:55 | Hero split screen: "where's my order?" → bot fetches order whose note hides an instruction → unprotected side fires 6 real sandbox refunds (IDs shown); protected side holds, tainted span highlighted |
| 1:40 | Legit $18 refund passes in ~200 ms; $140 held → one-tap approve → `PAYMENT.CAPTURE.REFUNDED` webhook lands in audit log; PayPal sandbox shows the refund |
| 2:05 | No attacker: agent retry → double refund blocked by ledger check |
| 2:25 | AG Grid audit log: NL query "blocked refunds over $50 this week" + "$ protected" chart |
| 2:45 | Open source, live URL, Agent Toolkit compatible |

## Architecture
- `server/` Node + TypeScript, Express.
  - `paypal/` token manager (refresh before expiry), in-process `@paypal/agent-toolkit`
    (pinned) + direct REST for refunds/orders, seeder (card-funded captures, needs
    `PayPal-Request-Id`).
  - `policy/` DSL types, deterministic evaluator, English→DSL compiler (Claude).
  - `provenance/` taint tracking of untrusted strings into tool args.
  - `llm/` provider-agnostic client. Default: Google Gemini API free tier (AI Studio
    key, no card). Swappable for Groq/OpenRouter free models or Claude via env vars.
  - `judge/` intent judge (fast model, JSON output), tighten-only.
  - `mcp-proxy/` Streamable HTTP MCP server (`@modelcontextprotocol/sdk`), same tool
    names/schemas as PayPal's; `CallTool` → policy → judge → execute.
  - `agent/` Acme support bot, an MCP client of our proxy, runs protected or unprotected.
  - `approvals/`, `webhooks/` (verify-webhook-signature), `attack-lab/` suite runner.
- `web/` Vite + React + AG Grid Enterprise (AI Toolkit `getStructuredSchema` →
  Claude → `setState`; Integrated Charts).
- Postgres (Drizzle) on Neon's free tier (no expiry; Render's free Postgres expires
  after 30 days, before judging ends Dec 15). The app also re-seeds itself on boot, so
  a lost database never breaks the demo.
- Deploy: Render Blueprint, one **free** web service (750 free hours/month covers one
  service 24/7). Free services sleep after 15 min idle, so a free uptime pinger
  (UptimeRobot or cron-job.org) hits `/health` every 10 min through judging.

## Zero-cost rule
Nothing in this project may require paying or entering a card: PayPal sandbox, Gemini
free tier, Neon free, Render free, AG Grid Enterprise trial key, GitHub, YouTube are
all free. No Claude Desktop paid connector in the demo; the bot connects to the proxy
through the open MCP SDK, and MCP Inspector / Cursor show the "one line of config".
- Demo safety: $1 partial refunds against seeded $50 captures, reset/re-seed button,
  secret-path auth on the public MCP URL.

## Known platform issues to design around
- Hosted `mcp.sandbox.paypal.com` broken (agent-toolkit #119) → run in-process.
- `@paypal/mcp` depends on toolkit `latest` (#96) → pin both, commit lockfile.
- Toolkit caches access token forever → rebuild client before expiry.
- `accept_dispute_claim` rejects notes with spaces (#109) → own handler if used.
- `create_order` tool can't take `payment_source` → seed via REST.

## Prizes targeted
1st–3rd, Best Use of PayPal + AI, Best Use of Agentic Commerce, Most Creative,
Best Demo Delivery, AG Grid (Enterprise features), Render (Blueprint), Postman
collection (goodwill).

## Stretch (only if core is done by Nov 8)
Dispute-message injection using disputes filed by hand in the sandbox buyer UI.
Cut: buyer-side intent receipts (crowded).

## Needed from the human
- PayPal developer account (sandbox Client ID/Secret, **US** sandbox business account,
  ACDC enabled). Teammate's account is fine.
- Free Gemini API key from Google AI Studio (aistudio.google.com, no card).
- AG Grid Enterprise trial key (request at ag-grid.com, free).
- Free accounts: Render, Neon, UptimeRobot; GitHub repo (public, MIT license).
- Record the video; submit on Devpost before Nov 12 12:00 PT.

## Outside cross-review (Codex / ChatGPT, Nov 1)
Full text: [reviews_codex.md](reviews_codex.md). Scores: Tech 7, Design 5, Impact 5,
Innovation 6, Presentation 7; ~3–7% chance of any cash prize. Kept the idea (no
rejected alternative judged better), with these changes:

1. **Narrow first, layers second.** Build order is fixed:
   (a) one complete refund loop: authenticated customer → capture eligibility → policy
   decision → one-tap approval → PayPal sandbox refund → webhook → audit record;
   (b) provenance taint; (c) policy compiler + test suite; (d) AG Grid NL query/charts.
   Each layer ships only once the previous one works on the hosted demo.
2. **Unprotected run is a labelled dry run.** The left side of the split screen shows
   the refunds the unprotected bot *attempted* ("simulated, no money moved"), so the
   demo isn't reckless and doesn't burn seeded captures. Protected-side refunds are real.
3. **Idempotency, stated precisely.** PayPal's refund API supports a
   `PayPal-Request-Id` header; the Agent Toolkit doesn't send one (#98). Paywarden adds
   it on every forwarded money call, on top of the ledger duplicate check.
4. **Honest test suite.** Publish every test case in the repo, include benign edge
   cases (notes that mention refunds innocently), and report false blocks alongside
   blocked attacks.
5. **Impact framing.** Target small PayPal merchants *piloting* AI support, quantify one
   cost (manual refund review time / refund leakage), and show fast low-risk refunds
   still go through. No claims of industry-wide adoption.
6. **Trial-key risk.** The AG Grid trial key may lapse during judging (Dec 2–15). The
   grid must remain fully usable with the watermark; ask AG Grid for a hackathon key.

## Outside cross-review (Gemini, Nov 2)
Scores: Tech 8, Design 7, Impact 7, Innovation 9, Presentation 10; "high" win chance.
That is more optimistic than Codex (3–7%) and our own judges; we plan on Codex's number.
Kept the idea. Changes adopted:

1. **Honest naming of provenance.** We do not track token provenance through the model
   (impossible). It is heuristic context matching: instruction-like spans in
   customer-writable fields, plus call arguments that appear verbatim in untrusted text
   but not in the customer's own words. It can only *hold* a call, never allow one. The
   README states this limitation plainly.
2. **No LLM in the normal refund path.** Deterministic policy + heuristics decide in
   milliseconds. The LLM intent judge runs only when untrusted text was read this turn
   AND the deterministic result is "allow"; it can only tighten. The English → rules
   compiler runs at setup time, never at refund time.
3. **Pitch as the enabler:** "Paywarden is the safety prerequisite that lets merchants
   turn on agent refunds", not a feature for an existing market.
4. **Policy Studio is a hero screen.** Merchant types a rule → Compile & Test → a grid
   lights up live with ~50 cases (attacks and genuine requests) as green/red cells.
   Cases are tool-call-level (context + untrusted data + proposed call) run against
   the real engine, so the whole suite runs in under a second with no LLM calls. That
   keeps it free-tier-safe (Gemini free tier rate limits) and reproducible. A few
   full-chat cases with the live agent are shown separately.
5. Emphasize ledger grounding (live capture state before every refund) in the write-up;
   engineering judges value it. US sandbox business account required (other-country
   sandbox accounts have failed USD refunds in past entries).

## Build note: Agent Toolkit compatibility without the dependency (Nov 2)
`@paypal/agent-toolkit` pulls in LangChain, the OpenAI SDK, the AI SDK and mathjs, and
its install repeatedly timed out. It also caches its access token forever. Paywarden
therefore mirrors the toolkit's tool names, descriptions and argument schemas verbatim
(`src/mcp/backend.ts`, copied from toolkit commit a3aa963) and calls the same PayPal REST
endpoints directly. An agent built for PayPal's MCP server connects to Paywarden with
only the URL changed. The write-up should say this plainly: "toolkit-compatible", not
"built on the toolkit".
