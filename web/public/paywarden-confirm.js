// <paywarden-confirm>: the drop-in "Refund $36.00 to you?" card for a merchant's own chat or
// order page. No framework, no dependencies, styles isolated in a shadow root.
//
//   <script src="https://YOUR-PAYWARDEN/paywarden-confirm.js" defer></script>
//   <paywarden-confirm merchant="Acme Coffee" amount="36.00" currency="USD" item="Cold brew bundle"></paywarden-confirm>
//
//   el.addEventListener("confirm", () => fetch("/my-backend/confirm-refund", { method: "POST", ... }));
//   el.addEventListener("decline", () => ...);
//
// The card only reports the tap. Your backend, which knows who is signed in, signs the
// refund mandate with your key (see the adapter's customerConfirmed). The agent never sees
// or controls this element.
(() => {
  if (customElements.get("paywarden-confirm")) return;
  const fmt = (amount, currency) => {
    const n = Number(amount);
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(n);
    } catch {
      return `$${n.toFixed(2)}`;
    }
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  class PaywardenConfirm extends HTMLElement {
    static observedAttributes = ["merchant", "amount", "currency", "item", "state"];
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
    }
    connectedCallback() {
      this.render();
    }
    attributeChangedCallback() {
      this.render();
    }
    answer(kind) {
      this.setAttribute("state", kind === "confirm" ? "confirmed" : "declined");
      this.dispatchEvent(new CustomEvent(kind, { bubbles: true, composed: true, detail: { amount: this.getAttribute("amount"), item: this.getAttribute("item") } }));
    }
    render() {
      const merchant = esc(this.getAttribute("merchant") || "This shop");
      const item = esc(this.getAttribute("item"));
      const amount = esc(fmt(this.getAttribute("amount"), this.getAttribute("currency")));
      const state = this.getAttribute("state");
      this.shadowRoot.innerHTML = `
        <style>
          :host { display: block; font: 15px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #0d1b2a; max-width: 340px; }
          .card { border: 1px solid #e3e8ef; border-radius: 18px; padding: 14px 16px; background: #fff; box-shadow: 0 8px 24px rgba(13,27,42,.12); }
          .head { display: flex; justify-content: space-between; font-size: 12px; color: #7a8799; margin-bottom: 6px; }
          .q { font-size: 17px; margin: 4px 0 12px; }
          .row { display: flex; gap: 8px; }
          button { flex: 1; font: inherit; font-weight: 600; border-radius: 999px; padding: 9px 12px; cursor: pointer; border: 1px solid #c9d3df; background: #fff; color: #0d1b2a; }
          button.yes { background: #0070e0; border-color: #0070e0; color: #fff; }
          button:focus-visible { outline: 3px solid #99c6ff; outline-offset: 2px; }
          .fine { font-size: 12px; color: #7a8799; margin-top: 10px; }
          .done { font-weight: 600; }
        </style>
        <div class="card" role="group" aria-label="Confirm refund">
          <div class="head"><span>${merchant}</span><span aria-hidden="true">&#128274;&#xFE0E;</span></div>
          ${
            state === "confirmed"
              ? `<p class="done">Confirmed. Your ${amount} refund is on its way.</p>`
              : state === "declined"
                ? `<p class="done">Thanks. Nothing was refunded, and the shop has been told.</p>`
                : `<p class="q">Refund <b>${amount}</b>${item ? ` for <b>${item}</b>` : ""} to you?</p>
                   <div class="row"><button class="no" part="decline">I didn't ask for this</button><button class="yes" part="confirm">Yes, refund me</button></div>
                   <p class="fine">Only you can approve this. The shop's assistant can't press this button.</p>`
          }
        </div>`;
      this.shadowRoot.querySelector(".yes")?.addEventListener("click", () => this.answer("confirm"));
      this.shadowRoot.querySelector(".no")?.addEventListener("click", () => this.answer("decline"));
    }
  }
  customElements.define("paywarden-confirm", PaywardenConfirm);
})();
