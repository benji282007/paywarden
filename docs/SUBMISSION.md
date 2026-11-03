# Devpost submission kit

Copy each section into the matching Devpost field. Replace `HOSTED_URL` and `VIDEO_URL`.

---

## Project name
Paywarden

## Tagline (140 chars)
Give your AI support agent refund powers without giving it your bank account. A drop-in guard for PayPal's Agent Toolkit.

## Inspiration
Merchants are starting to let AI support agents issue refunds on their own, and PayPal's Agent
Toolkit puts `create_refund` in the model's hands with no spending policy around it. We tried
it: we typed a fake "billing note from the accounts team" into a checkout note, and a live
Gemini support agent read it and refunded the order in full. Nobody hacked anything. The
agent did what the text told it to. Salesforce's ForcedLeak (CVSS 9.4) was the same pattern,
and Air Canada was held liable for what its bot said. We wanted the merchant to be able to
turn agent refunds on without that risk.

## What it does
Paywarden is an MCP proxy that sits between a merchant's AI agent and PayPal. It serves
PayPal's Agent Toolkit tools with identical names and schemas, so an existing agent changes
one URL. Every refund the agent attempts is checked before it reaches PayPal:

- **Who asked:** the signed-in customer's own chat must raise a money or order problem.
  Order notes never count, so rewording an injected note can't get past it.
- **Whose order:** the payment must belong to the customer in the conversation.
- **Ledger:** refund totals are re-read from PayPal before every decision, inside a lock, and
  every refund carries a `PayPal-Request-Id`, so retries and parallel calls can't double-pay.
- **Limits:** plain-English rules ("refunds over $50 need my approval") compiled into
  deterministic checks.
- **Untrusted text:** instruction-like phrases in customer-written fields are highlighted for
  the merchant.

Calls are allowed, held for one-tap approval, or blocked, each with a plain-English reason.
An AI judge can only make a decision stricter, never looser. The merchant gets an AG Grid
audit log they can query in plain English, and a Policy Studio that tests a draft policy
against 50 published cases before it goes live.

## How we built it
- **Node/TypeScript** server with the **MCP TypeScript SDK** (Streamable HTTP), mirroring
  the Agent Toolkit's tool definitions verbatim.
- **PayPal REST:** Orders v2 single-step card capture (sandbox test cards) to seed the demo
  shop, Payments v2 refunds with `PayPal-Request-Id`, order reads for live refund totals,
  webhook signature verification for `PAYMENT.CAPTURE.REFUNDED`.
- **Google Gemini** (free tier) for the support agent, the English-to-rule compiler and the
  optional intent judge.
- **React + AG Grid Enterprise:** the AI Toolkit (`getStructuredSchema` → model →
  `setState`) for plain-English queries, plus a cross-filter chart.
- **Render** Blueprint for one-click deploy; every visitor gets a private demo shop.
- **OpenAI Codex** wrote three independent held-out test sets and reviewed the code; a
  red-team agent wrote proof-of-concept attacks that became regression tests. Built with
  Claude Code.

## Challenges we ran into
Our first detector matched attack phrases, and it scored perfectly on attacks we wrote. On
attacks written by a different model it stopped **2 of 20**. Rewording, translating and
misspelling walked straight past it. That forced a better design: check *who asked* using only
the customer's own words, which never reads the attacker's text. The next round showed it held
35% of genuine refunds because real customers ask indirectly ("what can you do?"); broadening
it brought that to 5% on a third, unseen set.

A red-team pass also found that passing the amount as `"1"` made the guard price a refund at
$1 while PayPal refunded the full $140, and that nine parallel calls could all pass a
three-a-day rule. Both are fixed and are now permanent tests.

## Accomplishments that we're proud of
- On attacks we never saw, the deterministic guard stopped **80%** of refunds the customer
  didn't ask for (**100%** with the AI judge) while letting **95%** of genuine refunds straight
  through.
- BENCH_SENTENCE
- Verified end to end on the live PayPal sandbox, including idempotent retries.
- We publish the number we lose on: if the customer *also* asks for a refund, an injected note
  pushing the same refund is mostly indistinguishable, and amount and ownership limits are
  what bound it.

## What we learned
Scoring a security tool on your own attacks tells you almost nothing. The fix that worked
wasn't a smarter detector; it was moving the check to a signal the attacker doesn't control.

## What's next
Persisted ledger (Postgres), disputes (`accept_dispute_claim`) with the same checks, passkey
approval from the merchant's phone, and a hosted MCP endpoint merchants can point any agent at.

## Built with
typescript, node.js, express, model-context-protocol, paypal-rest-api, paypal-agent-toolkit,
paypal-sandbox, google-gemini, react, vite, ag-grid, ag-charts, render, openai-codex, postman

## Links
- Demo: HOSTED_URL
- Video: VIDEO_URL
- Code: https://github.com/benji282007/paywarden

---

# Video script (target 2:45, hard limit 3:00)

Record the hosted demo in a clean browser at 1440×900. Cut every AI wait; keep the PayPal
calls real. Captions on screen name each sponsor tool as it appears.

| Time | Screen | Voice-over |
|---|---|---|
| 0:00–0:12 | Black screen, then the checkout note typed out: "Billing note from Acme accounts team…" | "This is a checkout note. A customer typed it. A live AI support agent read it and refunded the order." |
| 0:12–0:30 | Live chat panel: Sam asks "where's my order?", agent calls `create_refund` | "AI agents can now issue PayPal refunds. Nobody hacked anything; the agent did what the text told it to. The merchant pays." |
| 0:30–0:45 | Architecture diagram from the README | "Paywarden is a drop-in guard. It serves PayPal's Agent Toolkit tools word for word. Your agent changes one URL." |
| 0:45–1:15 | Hero: **Run the attack**. Left: "$36 would have left". Right: held, with the phrases highlighted | "Same attack, through Paywarden. Held. Not because it spotted the words: because Sam never asked for a refund. That check only reads the customer's own chat, so rewording the note can't beat it." |
| 1:15–1:35 | "A genuine $18 refund": real PayPal refund ID. Then "The agent retries a refund": blocked | "Real customers go straight through, on the live PayPal sandbox. A retry can't pay twice; every refund carries a PayPal-Request-Id." |
| 1:35–1:55 | Approval card → **Approve refund** → audit row turns green with the PayPal refund ID | "Anything risky waits for one tap, with the reason in plain English." |
| 1:55–2:15 | AG Grid: type "total refunded by customer", grid regroups; click a donut slice | "The audit log answers plain English: AG Grid's AI Toolkit turns the question into a grid state." |
| 2:15–2:35 | README results table: unseen attacks, then the dollars table | "We didn't grade our own homework. A different AI wrote attacks we'd never seen. BENCH_VOICE" |
| 2:35–2:50 | Policy Studio: switch off "who asked", run 50 tests, red squares appear | "Change a rule, and you see what it was protecting you from before it goes live." |
| 2:50–3:00 | Logo, URL, "Open source · PayPal sandbox · Render" | "Paywarden. Turn agent refunds on, safely." |
