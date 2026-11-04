"""Turn the UCI "Online Retail II" dataset into a PayPal-activity-shaped CSV for Paywarden's backtest.

Dataset: Chen, D. (2019). Online Retail II. UCI Machine Learning Repository. CC BY 4.0.
https://archive.ics.uci.edu/dataset/502/online+retail+ii
Real transactions of a UK-based online gift retailer. Invoices starting with "C" are
cancellations/returns, i.e. money given back to the customer: the refunds an AI support agent
would be issuing.

Mapping (standard library only, streams the 160 MB sheet):
  * each normal invoice with a customer id  -> one "Payment" row (Gross = sum of lines)
  * each "C" invoice with a customer id     -> one "Refund" row (Gross negative), linked through
    "Reference Txn ID" to that customer's most recent earlier invoice containing the same
    products (the dataset doesn't record which order a return belongs to)
  * non-product codes (postage, manual adjustments, discounts, bank and Amazon fees) are skipped
Amounts are GBP in the dataset; the CSV keeps the numbers as they are.

    python3 -I uci-to-paypal.py online_retail_II.xlsx out.csv [sheet-number, default 2 = Dec 2010-Dec 2011]
"""

import csv
import re
import sys
import zipfile
from collections import defaultdict
from datetime import datetime, timedelta
from xml.etree.ElementTree import iterparse

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
PRODUCT = re.compile(r"^\d{5}")


def shared_strings(z):
    out = []
    for _, el in iterparse(z.open("xl/sharedStrings.xml")):
        if el.tag == NS + "si":
            out.append("".join(t.text or "" for t in el.iter(NS + "t")))
            el.clear()
    return out


def rows(z, sheet, strings):
    for _, el in iterparse(z.open(f"xl/worksheets/sheet{sheet}.xml")):
        if el.tag != NS + "row":
            continue
        vals = {}
        for c in el.iter(NS + "c"):
            col = re.match(r"[A-Z]+", c.get("r")).group(0)
            v = c.find(NS + "v")
            if v is None:
                continue
            vals[col] = strings[int(v.text)] if c.get("t") == "s" else v.text
        el.clear()
        yield vals


def main(src, dst, sheet="2"):
    z = zipfile.ZipFile(src)
    strings = shared_strings(z)
    invoices = {}  # invoice -> {customer, at, lines: {stock: value}}
    for i, r in enumerate(rows(z, sheet, strings)):
        if i == 0:
            continue
        inv, stock, qty, at, price, cust = r.get("A"), r.get("B"), r.get("D"), r.get("E"), r.get("F"), r.get("G")
        if not inv or not cust or not stock or not PRODUCT.match(str(stock)):
            continue
        value = float(qty) * float(price)
        d = invoices.setdefault(str(inv), {"customer": str(int(float(cust))), "at": datetime(1899, 12, 30) + timedelta(days=float(at)), "lines": defaultdict(float)})
        d["lines"][str(stock)] += value

    by_customer = defaultdict(list)
    for inv, d in invoices.items():
        if not inv.startswith("C"):
            by_customer[d["customer"]].append((d["at"], inv, d))
    for lst in by_customer.values():
        lst.sort()

    out = []
    linked = 0
    for inv, d in invoices.items():
        total = round(sum(d["lines"].values()), 2)
        who = f"customer-{d['customer']}@retail.example"
        if not inv.startswith("C"):
            if total > 0:
                out.append((d["at"], "Payment", total, who, inv, ""))
            continue
        if total >= 0:
            continue
        # The customer's most recent earlier invoice that shares the most returned products.
        best, best_score = "", 0.0
        for at, pinv, p in reversed(by_customer[d["customer"]]):
            if at >= d["at"]:
                continue
            score = sum(min(abs(v), p["lines"].get(s, 0)) for s, v in d["lines"].items() if s in p["lines"])
            if score > best_score:
                best, best_score = pinv, score
        if best:
            linked += 1
        out.append((d["at"], "Refund", total, who, inv, best))

    out.sort()
    with open(dst, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date", "Time", "Name", "Type", "Status", "Currency", "Gross", "From Email Address", "Transaction ID", "Reference Txn ID"])
        for at, typ, gross, who, txn, ref in out:
            w.writerow([at.strftime("%m/%d/%Y"), at.strftime("%H:%M:%S"), who, typ, "Completed", "GBP", f"{gross:.2f}", who, txn, ref])
    refunds = sum(1 for o in out if o[1] == "Refund")
    print(f"{len(out) - refunds} payments, {refunds} refunds ({linked} linked to an earlier order), {len(by_customer)} customers -> {dst}")


if __name__ == "__main__":
    main(*sys.argv[1:])
