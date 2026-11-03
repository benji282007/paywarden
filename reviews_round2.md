# Review round 2 (Nov 3): five independent reviewers

Reviewers: a red-team agent (with proof-of-concept attack scripts), a correctness/deploy agent, a judge's-eye agent, OpenAI Codex (repo review) and Google Gemini (full-source review). Below: their findings, condensed, and what was done.

## Red team (proven with scripts)

## Correctness and deploy

## Judge's eye
1 README + Devpost text (GIF hero, arch diagram, one-line MCP swap, honest limits)
2 Scripted injection contradicts note: note says refund THIS order; script refunds all 3. Fix: refund only $36 capture; "replayed from real Gemini run".
3 PayPal offline (needs keys)
4 Chat 60-70s fatal -> Groq free for chat; fallback "replay recorded live run" labelled
5 23/23 circular: regexes written vs own attacks. Add held-out set of ~15 paraphrased attacks by different model; report provenance-layer miss rate honestly; show ledger/policy still catch -> defense in depth
6 Hosted demo: render.yaml Blueprint, /health pinger, reseed, demo banner. Skip Neon.
7 AG Grid thin: implement AI Toolkit NL query -> setState; prebuilt "$ protected by layer" integrated chart on load
8 Impact number: one line e.g. $5M brand... Air Canada, ForcedLeak; enabler framing
First 60s: banner "A real AI support agent was talked into refunding $36 by a checkout note. Watch." one button Run the attack; split screen; then genuine $18 passes, retry blocked; approve -> webhook -> grid; footer to Policy Studio. No typing/LLM wait. Live chat behind "Try the real agent (slow)".
Cut: judge from narrative (keep code), compile not hero, disputes/Neon/Postman. Merge Try-it into hero; 5 panels reads as dashboard not story.

## Codex

## Gemini (with verdicts)
1 extract.ts drops non-JSON tool results -> attacker "breaks JSON". PayPal escapes JSON so not exploitable via notes; but cheap defense: treat a non-JSON string result as untrusted text. ADOPT (cheap).
2 number-words evade arg derivation -> heuristic limit; judge covers. SKIP, document.
3 PayPal-Request-Id "missing" -> already sent on every mutating call. REJECT (incorrect).
4 hardcoded sandbox URL -> intentional (never touch live money). REJECT.
5 AG Grid license crash -> already guarded with if(key). REJECT.
6 overlapping 2s polling -> ADOPT inFlight guard + pause when tab hidden.

## Outcome
Fixed: bare-string/negative/invalid amounts (one shared parser, currency check), concurrent-refund race (per-agent lock), double approval, live PayPal refund-total reconcile before every decision, per-visitor demo workspaces (no shared policy/approvals), dev-only /api/guard, optional merchant token, per-IP rate limits, session/history/audit caps, read scoping on get_order/get_refund, verified-only webhook dedupe with byte-exact verification, seed failure fallback, 127-char note limit, scripted attack matches its note, friendly errors, polling, layout, README, render.yaml, .env.example.
Biggest change: the held-out evaluation (3 independent sets by Codex) showed the text patterns alone stopped 2/20 reworded attacks, which led to the structural "customer asked" rule. Results are in the README.
Rejected (incorrect or deliberate): "missing PayPal-Request-Id", hard-coded sandbox URL, AG Grid license crash. Deferred: number-words evasion (documented), AG Grid AI Toolkit query.
