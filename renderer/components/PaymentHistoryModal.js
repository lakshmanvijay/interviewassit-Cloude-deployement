const { ipcRenderer } = require('electron');
const { html } = require('../html');
const { useState, useEffect } = require('preact/hooks');
const { useStoreSlice } = require('../hooks');

const STATUS_LABEL = { PAID: '✓ Paid', FAILED: '✕ Failed', CREATED: '… Pending' };

function formatDate(iso) {
  try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch (e) { return iso; }
}

function formatAmount(amountPaise, currency) {
  const amount = (amountPaise || 0) / 100;
  return `${currency || 'INR'} ${amount.toFixed(2)}`;
}

// GET /api/payments/me — PaymentHistoryItem[]: [{ id, description,
// amountPaise, currency, status, createdAt }]. Fetched lazily each time the
// modal opens (not kept live/polled) — purchase history doesn't need to be
// real-time, and this avoids a background fetch loop for a rarely-opened view.
function PaymentHistoryModal({ store, onClose }) {
  const open = useStoreSlice(store, s => s.paymentHistoryOpen);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setHistory(null);
    setError(null);
    ipcRenderer.invoke('get-payment-history').then(result => {
      if (result.ok) setHistory(result.history || []);
      else setError(result.message || 'Failed to load purchase history');
    });
  }, [open]);

  if (!open) return null;

  return html`
    <div id="shortcuts-backdrop" onClick=${onClose}>
      <div id="shortcuts-modal" onClick=${e => e.stopPropagation()}>
        <div class="shortcuts-modal-header">
          <span>◈ Purchase History</span>
          <button class="icon-btn" onClick=${onClose} title="Close">✕</button>
        </div>
        ${error ? html`<div class="session-error">${error}</div>`
          : history === null ? html`<div class="welcome-caption">Loading…</div>`
          : history.length === 0 ? html`<div class="welcome-caption">No purchases yet.</div>`
          : html`
            <div class="payment-list">
              ${history.map(item => html`
                <div class="payment-row" key=${item.id}>
                  <div class="payment-row-main">
                    <span class="payment-desc">${item.description}</span>
                    <span class="payment-amount">${formatAmount(item.amountPaise, item.currency)}</span>
                  </div>
                  <div class="payment-row-meta">
                    <span class="payment-date">${formatDate(item.createdAt)}</span>
                    <span class="payment-status ${(item.status || '').toLowerCase()}">${STATUS_LABEL[item.status] || item.status}</span>
                  </div>
                </div>
              `)}
            </div>
          `}
      </div>
    </div>
  `;
}

module.exports = { PaymentHistoryModal };
