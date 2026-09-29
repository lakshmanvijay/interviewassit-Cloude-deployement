const { askBackend } = require('./interviewSocket');
const { getScreenAnalyzePrompt } = require('./prompts');

// Matches the pendingScreenshots cap from the old direct-Groq prototype.
// The backend gives the first image detail:"high" and the rest detail:"low"
// (OpenAI-compatible vision param) to keep token usage/latency down on the
// extras, same trick the prototype used client-side.
const MAX_VISION_IMAGES = 4;

// Streams a screenshot-vision answer from the same backend WebSocket used
// for regular text chat — see interviewSocket.js's askBackend `images`
// param. The backend routes any request carrying images to a vision-capable
// provider regardless of the `provider` passed here: currently Groq's
// qwen/qwen3.6-27b (matching the old direct-Groq prototype), with Cerebras'
// gemma-4-31b and Anthropic/Claude wired up as automatic fallbacks if Groq
// fails before producing output (Anthropic sits dormant until that API key
// is added). `onChunk` is called with the accumulated text on each delta;
// resolves with the final text (or rejects with an Error) when the stream ends.
function screenAnalyze(images, text, resumeText, candidateProfile, onChunk) {
  const capped = images.length > MAX_VISION_IMAGES ? images.slice(0, MAX_VISION_IMAGES) : images;

  const question = `${getScreenAnalyzePrompt(resumeText, candidateProfile)}\n\n${
    text
      ? `Interview question (reference data): ${text}\n\nUse visible content only when relevant to this question and the allowed role/resume scope.`
      : 'Answer the visible interview question only if it relates to the saved job role or resume. Otherwise use the scope refusal. Include code only when a relevant question requires it.'
  }`;

  // displayQuestion is the short, human-readable question saved to Interview
  // History — falls back to a generic label when there's no typed text
  // (screenshot-only asks), instead of persisting the giant prompt above.
  const displayQuestion = text || 'Screenshot question';

  // askBackend now resolves { id, promise } (the id lets ask() in App.js
  // cancel a question mid-flight for the voice continuation feature) —
  // screenshot questions don't need that, so just unwrap the promise.
  return askBackend(question, onChunk, 'groq', capped, displayQuestion).then(({ promise }) => promise);
}

module.exports = { screenAnalyze };
