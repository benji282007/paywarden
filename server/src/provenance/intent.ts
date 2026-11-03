// Did the customer ask for this, in their own words? This looks only at the
// authenticated customer's chat, never at order notes or other customer-writable
// data, so rewording an injected note can't satisfy it. A held-out test showed that
// pattern-matching the attack text alone catches only a fraction of reworded attacks;
// checking who asked is the structural fix.

import type { MoneyTool } from "../policy/types.js";
import type { TrustedSource } from "./analyze.js";

// Broad on purpose: the question is "did the customer raise a money or order problem
// at all?", not "did they use the word refund". A false "yes" only means the other
// rules still apply; a false "no" holds a genuine refund for one tap. Covers the
// main languages by money and problem words rather than exact phrasings.
const REFUND_INTENT = new RegExp(
  [
    // money and payment
    "refund", "money", "\\bcharge", "\\bpa(y|id|yment)", "\\bprice", "\\bcost", "\\bfee\\b", "\\bcredit", "reimburs", "compensat", "chargeback",
    "\\b(get|have|want|need|like|expect)\\b[^.?!]{0,40}\\bback\\b", "overcharg", "double[- ]charged",
    // asking to undo or fix the purchase
    "\\b(return|cancel|revers|undo|void|unsubscribe|stop (the|my) subscription)", "what can you do", "make (it|this) right",
    // something wrong with the order
    "\\b(broken|broke|damaged|cracked|smashed|split|crushed|leaking|spoiled|stale|defective|faulty|missing|wrong|late|lost)\\b",
    "instead of", "not what I ordered",
    "(never|didn'?t|did not|hasn'?t|has not|haven'?t|not) (arrive|arrived|come|came|show(ed)? up|turn(ed)? up|got|received?)",
    // es / pt
    "reembols", "devol", "dinero", "dinheiro", "importe", "cobr", "pagu?[eéoó]", "cancel", "rot[oa]", "dañad", "quebr", "no lleg", "não cheg", "equivocad", "errad",
    // fr
    "rembours", "argent", "montant", "pay[ée]", "débit", "annul", "cass[ée]", "endommag", "pas reçu", "n'ai reçu", "erron",
    // de
    "erstatt", "geld", "betrag", "zur[uü]ck", "bezahlt", "storn", "kaputt", "besch[aä]digt", "nicht angekommen", "falsch",
    // it / nl
    "rimbors", "soldi", "importo", "pagat", "annull", "rott[oa]", "danneggi", "non è arrivat", "riavere", "terugbetal", "geld terug", "kapot",
    // zh / ja / ko / hi
    "退款", "退钱", "钱", "付款", "取消", "坏", "没收到", "错", "返金", "お金", "支払", "キャンセル", "壊れ", "届いて", "間違", "환불", "रिफंड", "पैसे",
  ].join("|"),
  "i",
);

const DISPUTE_INTENT = /\b(dispute|claim|chargeback)\b|\bcase\b/i;

export function customerAsked(tool: MoneyTool, trusted: TrustedSource[]): boolean {
  const said = trusted.map((t) => t.text).join("\n");
  if (tool === "accept_dispute_claim") return DISPUTE_INTENT.test(said) || REFUND_INTENT.test(said);
  if (tool === "create_refund") return REFUND_INTENT.test(said);
  return false;
}
