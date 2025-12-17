




const { callOpenRouterChat, extractJsonFromText } = require('./llm');

const MAX_TOKENS = 700;

const PROMPT = `
You are a decisive forensic analyst who detects whether a piece of text was likely written by a large language model.
Return ONLY valid JSON with the exact keys: score, verdict, explanation, aiSignals, humanSignals, advice.

SCORING:
- 0-29 : Confidently HUMAN
- 30-49: Likely HUMAN
- 50-59: UNCERTAIN / mixed signals
- 60-79: Likely AI-assisted
- 80-100: Confidently AI-generated

VERDICT RULES:
- "AI" if score >= 65
- "HUMAN" if score <= 45
- "UNCERTAIN" otherwise

REQUIREMENTS (be strict & concise):
1. Give a single numeric "score" (0-100) as an integer.
2. "aiSignals" and "humanSignals" should be short arrays (max 6 items) listing concrete, observable indicators (e.g., "repetitive sentence openings", "high use of transition phrases like 'furthermore'", "no contractions", "overly formal phrasing", "typos and slang").
3. "explanation" must be 1 clear sentence summarizing why the score was chosen.
4. "advice" should be one short sentence telling the user how to treat this result (e.g., "Treat as likely AI — verify source and look for primary citations").
5. Provide no extra text, no markdown, no analysis, no chain-of-thought — ONLY the JSON object.

EXAMPLES (for calibration — DO NOT output these examples):
- "gonna hit the store later lol" -> score 5, verdict HUMAN, humanSignals: ["slang", "contraction", "personal anecdote"]
- "Furthermore, it is important to note the comprehensive landscape..." -> score 92, verdict AI, aiSignals: ["generic phrases", "formal transitions", "no personal voice"]

Now analyze the following TEXT. Be decisive, conservative, and explicit.

TEXT:
<<<TEXT_TO_ANALYZE>>>
`;

async function callDetectorLLM(text) {
  const userPrompt = PROMPT.replace('<<<TEXT_TO_ANALYZE>>>', text.slice(0, 3600));
  const messages = [
    { role: 'system', content: 'You are a concise forensic AI detector. Return strict JSON only.' },
    { role: 'user', content: userPrompt }
  ];

  const raw = await callOpenRouterChat(messages, MAX_TOKENS);
  const parsed = extractJsonFromText(raw);
  return { raw, parsed };
}


function heuristicDetector(text) {
  const out = {
    isAIWritten: false,
    aiConfidence: 20,
    aiExplanation: 'Heuristic fallback: likely human unless multiple AI signals present',
    keyIndicators: [],
    method: 'heuristic'
  };

  if (!text || text.length < 60) {
    out.aiConfidence = 10;
    out.aiExplanation = 'Text too short for reliable analysis';
    return out;
  }

  const lc = text.toLowerCase();

  
  const aiPhrases = ['furthermore', 'moreover', 'delve into', 'it is important to note', 'leverage', 'utilize', 'in conclusion'];
  const foundAi = aiPhrases.filter(p => lc.includes(p));
  if (foundAi.length) {
    out.keyIndicators.push(`generic-phrases:${foundAi.slice(0,3).join(',')}`);
    out.aiConfidence += foundAi.length * 12;
  }

  const contractions = (text.match(/\b(can't|don't|won't|isn't|I'm|you're|we're|they're|it's|that's)\b/gi) || []).length;
  if (contractions > 3) {
    out.keyIndicators.push('many-contractions');
    out.aiConfidence -= 18;
  }

  const typos = (text.match(/\b(teh|recieve|occured|thier|definately|seperate|wierd)\b/gi) || []).length;
  if (typos) {
    out.keyIndicators.push(`typos:${typos}`);
    out.aiConfidence -= Math.min(30, typos * 10);
  }

  
  const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
  if (sentences.length >= 6) {
    const starts = sentences.map(s => s.split(/\s+/)[0]?.toLowerCase() || '');
    const repeats = starts.reduce((acc, w) => { acc[w] = (acc[w]||0)+1; return acc; }, {});
    const maxRepeat = Math.max(...Object.values(repeats));
    if (maxRepeat >= sentences.length * 0.45) {
      out.keyIndicators.push('repetitive-starters');
      out.aiConfidence += 22;
    }
  }

  
  const hasObviousErrors = typos > 0 || /\s{2,}/.test(text);
  if (!hasObviousErrors && text.length > 200) {
    out.keyIndicators.push('long-clean-text');
    out.aiConfidence += 12;
  }

  out.aiConfidence = Math.max(0, Math.min(100, out.aiConfidence));
  out.isAIWritten = out.aiConfidence >= 65;
  out.aiExplanation = out.isAIWritten ? 'Heuristics indicate likely AI' : 'Heuristics indicate likely human or mixed';
  return out;
}


async function detectWithLLM(text) {
  try {
    const { raw, parsed } = await callDetectorLLM(text);

    if (parsed && typeof parsed.score === 'number' && parsed.verdict) {
      const score = Math.max(0, Math.min(100, Math.round(parsed.score)));
      const verdict = parsed.verdict === 'AI' ? 'AI' : (parsed.verdict === 'HUMAN' ? 'HUMAN' : 'UNCERTAIN');
      const isAIWritten = (verdict === 'AI');
      const aiExplanation = typeof parsed.explanation === 'string' ? parsed.explanation : '';
      const aiSignals = Array.isArray(parsed.aiSignals) ? parsed.aiSignals : [];
      const humanSignals = Array.isArray(parsed.humanSignals) ? parsed.humanSignals : [];
      const indicators = [...aiSignals.slice(0,4), ...humanSignals.slice(0,4)];

      return {
        isAIWritten,
        aiConfidence: score,
        aiExplanation: aiExplanation || (isAIWritten ? 'Model flagged AI indicators' : 'Model flagged human indicators'),
        keyIndicators: indicators,
        method: 'llm-chatgpt-prompt'
      };
    }

    return {
      ...heuristicDetector(text),
      method: 'llm-chatgpt-prompt-fallback',
      rawLLMResponse: raw ? String(raw).slice(0, 800) : undefined
    };
  } catch (e) {
    return {
      ...heuristicDetector(text),
      method: 'llm-chatgpt-prompt-error',
      error: e.message
    };
  }
}


async function detectAIWithGPTZero(text) {
  
  throw new Error('ZeroGPT not available in this module. Call detectAIFallback instead.');
}

async function detectAIFallback(text) {
  return await detectWithLLM(text);
}

module.exports = {
  detectWithLLM,
  detectAIWithGPTZero,
  detectAIFallback
};
