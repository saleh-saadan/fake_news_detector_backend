// backend/llm.js
const axios = require('axios');
require('dotenv').config();

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o'; // change if needed
if (!OPENROUTER_KEY) {
  console.warn('Warning: OPENROUTER_API_KEY not set. LLM calls will fail.');
}
console.log('API KEY:', process.env.OPENROUTER_API_KEY ? 'LOADED' : 'MISSING');
  console.log("model", OPENROUTER_MODEL)
async function callOpenRouterChat(messages,  max_tokens = 1000) {
  if (!OPENROUTER_KEY) throw new Error('OPENROUTER_API_KEY missing');

  const url = 'https://openrouter.ai/api/v1/chat/completions';
  const payload = {
    model: OPENROUTER_MODEL,
    messages,
    max_tokens,
    temperature: 0.0
  };
  const headers = {
    Authorization: `Bearer ${OPENROUTER_KEY}`,
    'Content-Type': 'application/json'
  };
  const resp = await axios.post(url, payload, { headers, timeout: 120000 });
  // the response structure follows OpenRouter docs: choices[0].message.content
  const content = resp.data?.choices?.[0]?.message?.content;
  return content;
}

/**
 * Extract JSON from the LLM response text. Tolerant.
 */
function extractJsonFromText(text) {
  if (!text || typeof text !== 'string') return null;
  // try direct parse first
  try {
    return JSON.parse(text);
  } catch (_) {}
  // find first { ... } block
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    const sub = text.slice(start, end + 1);
    try {
      return JSON.parse(sub);
    } catch (_) {}
  }
  // find JSON inside markdown code block
  const codeBlockMatch = text.match(/```(?:json)?\n([\s\S]*?)\n```/i);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1]);
    } catch (_) {}
  }
  // fallback: try to clean trailing commas and parse
  const cleaned = text.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
  try {
    return JSON.parse(cleaned);
  } catch (_) {}
  return null;
}

module.exports = { callOpenRouterChat, extractJsonFromText };
