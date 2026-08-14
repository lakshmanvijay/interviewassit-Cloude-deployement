const { askBackend } = require('./interviewSocket');
const { SCREEN_ANALYZE_PROMPT } = require('./prompts');

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
function screenAnalyze(images, text, onChunk) {
  const capped = images.length > MAX_VISION_IMAGES ? images.slice(0, MAX_VISION_IMAGES) : images;

  const question = `${SCREEN_ANALYZE_PROMPT}\n\n${
    text
      ? `My question: ${text}\n\nAlso solve any coding/interview problem visible in the screenshot(s) above.`
      : 'Read the question or coding problem shown in the screenshot(s) and give a complete answer with code.'
  }`;

  return askBackend(question, onChunk, 'groq', capped);
}

module.exports = { screenAnalyze };
