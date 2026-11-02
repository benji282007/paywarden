## Scores

| Criterion | Score | Why |
|---|---:|---|
| Technological implementation | 7/10 | PayPal has real refund and dispute tools, and the idea combines policy checks with sandbox transactions. But the hard parts—secure identity binding, reliable enforcement, and usable integration—are not solved by naming them. |
| Design | 5/10 | A proxy plus audit grid risks feeling like security plumbing. A merchant approval flow and polished incident review could make it a product. |
| Potential impact | 5/10 | Refund mistakes are real; widespread autonomous support agents with direct PayPal refund access is less established. |
| Innovation | 6/10 | Merchant-side authorization is a useful distinction, but MCP policy proxies and payment firewalls already exist. |
| Presentation | 7/10 potential | The attack is legible on video, but the proposed “six real refunds” spectacle could look staged or reckless. |

**Chance of any cash prize: roughly 3–7%.** The pool is large, and multiple prizes help, but a competent build alone won’t stand out. A sponsor prize could be more reachable than a grand prize if the product has a credible demo and sharp story. The official rules say criteria are equally weighted and judges may judge from the submission materials alone, so video and description matter as much as the live demo. [Official rules](https://paypalaihackathon.devpost.com/rules)

## Why it could lose—and fixes

- **The audience sounds ahead of the market.** “Shops are connecting support agents to PayPal” needs proof. Show a real workflow, cite a merchant interview or documented deployment, and frame the product for merchants piloting AI support now—not as universal infrastructure.
- **The hero attack proves too little.** A customer-written note saying “refund all orders” is an obvious prompt-injection demo, and six sandbox refunds may look contrived. Show the same agent and request with and without the proxy; use seeded data and clearly label the unprotected run as a simulation. Demonstrate legitimate refunds still pass.
- **The product scope is too broad for ten days.** Taint tracking, account/customer identity, ledger checks, policy compilation, attack generation, webhooks, charts, and natural-language grid queries are several projects. Ship one narrow, reliable case: authenticated customer, eligible capture, refund cap, duplicate prevention, approval, execution, audit trail.
- **“24/24 attacks blocked” is weak evidence.** It can be gamed by the test generator. Publish the cases, include benign edge cases, and report false blocks as well as blocked attacks.

## Audience and impact

It’s **believable as an emerging use case, not yet a proven mass-market one**. PayPal’s own toolkit exposes `create_refund` and `accept_dispute_claim`; the refund tool defaults to a full refund when amount is omitted. That makes the integration timely, but does not prove merchants are deploying autonomous refund agents. [PayPal Agent Toolkit tools](https://github.com/paypal/agent-toolkit/blob/main/PROMPTS.md) Gartner’s 2026 survey reports customer-service AI investment and expectations for human escalation, supporting the broader trend—not this exact workflow. [Gartner](https://www.gartner.com/en/newsroom/press-releases/2026-07-08-gartner-survey-finds-customers-are-three-times-more-likely-to-use-third-party-genai-than-company-provided-chatbots-for-customer-service)

To push Impact toward 8: target **small PayPal merchants trialing AI support**, quantify a specific cost (refund leakage or manual review time), and show how the tool preserves fast low-risk refunds while escalating suspicious or high-value ones. Don’t claim industry-wide need without evidence.

## Alternatives

I wouldn’t bet on a rejected alternative as clearly better. Disputes have the same sandbox and scope problems; AgentGate trades this idea’s timely integration for fragile browser automation. Keep Paywarden, but cut it down.

## Technical red flags

- **MCP proxy:** Tool-call interception is plausible, but ensure every money-moving path goes through it; otherwise the agent can bypass policy. Don’t present it as production-grade security after a single demo.
- **Taint detection:** Highlighting suspicious text is useful; proving that text *caused* arguments is much harder. Treat provenance labels as conservative evidence, not certainty.
- **LLM judge and policy compiler:** The “stricter only” rule must be enforced in code. Prefer deterministic policy for allow/deny; make unclear cases hold. Validate generated rules against a fixed schema.
- **Idempotency:** The claim that PayPal has no idempotency is too broad. PayPal’s refund API documents a request ID header for idempotency; verify whether the toolkit exposes it and use it if available. [Refund API](https://developer.paypal.com/api/payments/v2/captures-refund)
- **Free tiers and sandbox:** Cold starts, quotas, expiring trials, and sandbox realism threaten judging access. Provide seeded demo accounts, a reset path, and a recorded end-to-end video. The rules require access through judging; don’t depend on a trial key still working then. [Official rules](https://paypalaihackathon.devpost.com/rules)

**Single highest-impact change:** replace the broad “AI agent security platform” pitch with a working, narrow **refund approval gateway** that proves one complete loop—customer identity, capture eligibility, policy decision, human approval, PayPal sandbox refund, and audit record.
