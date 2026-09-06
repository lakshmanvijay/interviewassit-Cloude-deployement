const { ipcRenderer } = require('electron');
const { html } = require('../html');
const { useState, useEffect } = require('preact/hooks');
const { useStoreSlice } = require('../hooks');

// Shown right after App.js's quitSession() ends a Live Assist or trial
// session (store.feedbackOpen set true there) — a quick "how did that go"
// prompt while the interview is still fresh, instead of leaving feedback to
// be volunteered unprompted. Posts to POST /api/feedback (see
// FeedbackController/FeedbackService on the backend).
function FeedbackModal({ store, onClose }) {
  const open = useStoreSlice(store, s => s.feedbackOpen);
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState(null);

  // Reset to a blank form each time the modal is freshly opened, rather than
  // carrying over whatever was left from a previous session's feedback.
  useEffect(() => {
    if (!open) return;
    setRating(0);
    setHoverRating(0);
    setMessage('');
    setSubmitting(false);
    setSubmitted(false);
    setError(null);
  }, [open]);

  if (!open) return null;

  async function submit() {
    if (!rating || submitting) return;
    setSubmitting(true);
    setError(null);
    const result = await ipcRenderer.invoke('submit-feedback', { rating, message: message.trim() });
    setSubmitting(false);
    if (!result.ok) {
      setError((result.body && result.body.message) || 'Failed to send feedback');
      return;
    }
    setSubmitted(true);
    // Brief thank-you before auto-closing, rather than just vanishing the
    // instant the request resolves.
    setTimeout(onClose, 1400);
  }

  const shownRating = hoverRating || rating;

  return html`
    <div id="shortcuts-backdrop" onClick=${onClose}>
      <div id="shortcuts-modal" onClick=${e => e.stopPropagation()}>
        <div class="shortcuts-modal-header">
          <span>★ Rate this session</span>
          <button class="icon-btn" onClick=${onClose} title="Close">✕</button>
        </div>

        ${submitted ? html`
          <div class="feedback-thanks">🎉 Thanks for the feedback!</div>
        ` : html`
          <div class="feedback-body">
            <p class="feedback-note">If you find any issues, please let us know. We'll work on fixing them, and your feedback will help us improve the application's performance and overall experience.</p>
            <div class="feedback-stars" role="radiogroup" aria-label="Rating">
              ${[1, 2, 3, 4, 5].map(n => html`
                <button
                  key=${n}
                  type="button"
                  class="feedback-star ${n <= shownRating ? 'filled' : ''}"
                  onMouseEnter=${() => setHoverRating(n)}
                  onMouseLeave=${() => setHoverRating(0)}
                  onClick=${() => setRating(n)}
                  title=${`${n} star${n > 1 ? 's' : ''}`}
                >★</button>
              `)}
            </div>
            <textarea
              class="feedback-textarea"
              placeholder="Anything you'd like to share about this session? (optional)"
              value=${message}
              onInput=${e => setMessage(e.currentTarget.value)}
              maxlength="2000"
            ></textarea>
            ${error && html`<div class="session-error">${error}</div>`}
            <div class="feedback-actions">
              <a class="setup-back" onClick=${onClose}>Maybe later</a>
              <button class="cta-btn feedback-submit-btn" disabled=${!rating || submitting} onClick=${submit}>
                ${submitting ? 'Sending…' : 'Submit feedback'}
              </button>
            </div>
          </div>
        `}
      </div>
    </div>
  `;
}

module.exports = { FeedbackModal };
