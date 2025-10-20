// backend/server.js
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { retrieveEvidence } = require('./retriever');
const { callOpenRouterChat, extractJsonFromText } = require('./llm');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '6mb' }));
app.use(express.urlencoded({ extended: true }));

// simple upload (for video route stub)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const upload = multer({ dest: uploadDir, limits: { fileSize: 200 * 1024 * 1024 } });

// --- local heuristics (ported from your python)
const FAKE_INDICATORS = [
  'shocking', 'unbelievable', 'breaking', 'must see', "you won't believe",
  'doctors hate', 'secret', "they don't want you to know", 'miracle',
  'amazing', 'revealed', 'exposed', 'truth', 'hoax', 'conspiracy'
];
const TRUSTED_SOURCES = ['bbc', 'reuters', 'ap news', 'associated press', 'npr', 'pbs', 'wall street journal', 'new york times', 'washington post', 'the guardian'];

function analyzeEmotionalLanguage(text) {
  const txt = (text || '').toLowerCase();
  const count = FAKE_INDICATORS.reduce((acc, w) => acc + (txt.includes(w) ? 1 : 0), 0);
  const exclam = (text.match(/!/g) || []).length;
  const caps = (text.match(/\b[A-Z]{3,}\b/g) || []).length;
  const score = (count * 2 + exclam + caps) / (Math.max(1, (text.split(/\s+/).length) / 10));
  return Math.min(Math.round(score * 10), 100);
}

function checkSourceTrust(text) {
  const txt = (text || '').toLowerCase();
  const trusted_count = TRUSTED_SOURCES.reduce((acc, s) => acc + (txt.includes(s) ? 1 : 0), 0);
  return trusted_count > 0 ? 100 : 35;
}

function analyzeClaimVerification(text) {
  const hasNumbers = /\d+/.test(text);
  const hasDates = /\b\d{4}\b|\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(text);
  const hasQuotes = /["“”«»]/.test(text);
  const score = (hasQuotes ? 30 : 0) + (hasNumbers ? 20 : 0) + (hasDates ? 20 : 0) + 30;
  return Math.min(score, 100);
}

// Basic claim extraction: split into sentences and pick sentences with entities or numbers
function extractClaims(text, maxClaims = 3) {
  if (!text) return [];
  // naive split by punctuation
  const sents = text
    .replace(/\n/g, ' ')
    .split(/(?<=[\.\?\!])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
  const claims = [];
  for (const s of sents) {
    // choose sentences longer than 6 words that include digits or capitalized words (proper nouns)
    const words = s.split(/\s+/);
    const hasNum = /\d/.test(s);
    const hasCaps = /\b[A-Z][a-z]{2,}\b/.test(s); // simple proper noun detection
    if (words.length >= 6 && (hasNum || hasCaps)) {
      claims.push(s);
      if (claims.length >= maxClaims) break;
    }
  }
  if (claims.length === 0 && sents.length) claims.push(sents[0]); // fallback: headline
  return claims;
}

// Compose LLM prompt for OpenRouter — ask for strict JSON
function buildPrompt(fullText, claimsAndEvidence) {
  const pre = `You are a strict, objective fact-check assistant. For each claim provided, evaluate based on the evidence given and return STRICT VALID JSON only (no extra commentary). The JSON must contain:
{
  "isFake": boolean,
  "confidence": number,                // 0-100, higher means more likely fake
  "claims": [
    {
      "claim": string,
      "verdict": "SUPPORTED"|"REFUTED"|"INSUFFICIENT",
      "confidence": number,            // 0-100 for this claim being true/false
      "explanation": string,           // 1-2 sentence reason
      "topEvidence": [ { "title": string, "url": string, "snippet": string } ]
    }
  ],
  "isAIWritten": boolean,
  "aiConfidence": number,
  "aiExplanation": string
}

Make decisions using only the provided evidence snippets. If evidence is mixed, say INSUFFICIENT. Also evaluate whether the full input text looks AI-generated and provide aiConfidence and aiExplanation. Do NOT output anything except valid JSON.`;

  let body = `\n\nINPUT_TEXT:\n${fullText}\n\nCLAIMS AND EVIDENCE:\n`;
  for (let i = 0; i < claimsAndEvidence.length; i++) {
    const c = claimsAndEvidence[i];
    body += `\nCLAIM ${i + 1}: ${c.claim}\nEVIDENCE:\n`;
    for (const e of c.evidence) {
      body += `- TITLE: ${e.title}\n  URL: ${e.url}\n  SNIPPET: ${e.snippet}\n`;
    }
    body += '\n';
  }
  body += '\nReturn only JSON as described above.';
  return pre + body;
}

// Route: analyze news (text)
app.post('/api/analyze-news', async (req, res) => {
  try {
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Text is required' });

    // local heuristics
    const emotional = analyzeEmotionalLanguage(text);
    const trust = checkSourceTrust(text);
    const verification = analyzeClaimVerification(text);

    // extract claims
    const claims = extractClaims(text, 3);

    // fetch evidence for each claim (wiki/news)
    const claimsAndEvidence = [];
    for (const c of claims) {
      const docs = await retrieveEvidence(c);
      claimsAndEvidence.push({ claim: c, evidence: docs || [] });
    }

    // build prompt and call OpenRouter LLM
    const prompt = buildPrompt(text, claimsAndEvidence);

    // messages format for chat
    const messages = [
      { role: 'system', content: 'You are a neutral fact-check assistant.' },
      { role: 'user', content: prompt }
    ];

    let modelText;
    try {
      modelText = await callOpenRouterChat(messages, 1200);
    } catch (llmErr) {
      console.error('LLM error:', llmErr.message || llmErr);
      // LLM failed — fallback to heuristic aggregation
      const fallbackClaims = claimsAndEvidence.map(cae => ({
        claim: cae.claim,
        verdict: 'INSUFFICIENT',
        confidence: 40,
        explanation: 'No model available; insufficient evidence locally.',
        topEvidence: cae.evidence.slice(0, 2)
      }));
      const fakeProb = Math.min(100, Math.round((emotional * 0.5 + (100 - trust) * 0.4 + (100 - verification) * 0.1)));
      return res.json({
        type: 'news',
        isFake: fakeProb > 50,
        confidence: fakeProb,
        claims: fallbackClaims,
        isAIWritten: false,
        aiConfidence: 0,
        aiExplanation: 'LLM unavailable, used heuristic fallback.',
        details: {
          emotionalLanguage: emotional > 50 ? 'High' : 'Low',
          sourceTrust: trust > 60 ? 'Trusted' : 'Questionable',
          claimVerification: verification > 60 ? 'Verified' : 'Unverified'
        }
      });
    }

    // parse JSON out of modelText
    const parsed = extractJsonFromText(modelText);
    if (!parsed) {
      // parsing failed -> return LLM raw and heuristic fallback
      return res.json({
        type: 'news',
        isFake: false,
        confidence: 0,
        rawModelText: modelText,
        claims: claimsAndEvidence.map(cae => ({
          claim: cae.claim,
          verdict: 'INSUFFICIENT',
          confidence: 0,
          explanation: 'Failed to parse model output, check rawModelText',
          topEvidence: cae.evidence.slice(0, 2)
        })),
        isAIWritten: false,
        aiConfidence: 0,
        aiExplanation: 'Parsing failure',
        details: {
          emotionalLanguage: emotional > 50 ? 'High' : 'Low',
          sourceTrust: trust > 60 ? 'Trusted' : 'Questionable',
          claimVerification: verification > 60 ? 'Verified' : 'Unverified'
        }
      });
    }

    // attach our heuristic details as well
    parsed.details = {
      emotionalLanguage: emotional > 50 ? 'High' : 'Low',
      sourceTrust: trust > 60 ? 'Trusted' : 'Questionable',
      claimVerification: verification > 60 ? 'Verified' : 'Unverified'
    };

    // ensure normalized fields
    parsed.type = 'news';
    // ensure claims array exists
    parsed.claims = parsed.claims || claimsAndEvidence.map(cae => ({
      claim: cae.claim,
      verdict: 'INSUFFICIENT',
      confidence: 0,
      explanation: 'No model result',
      topEvidence: cae.evidence.slice(0, 2)
    }));

    return res.json(parsed);

  } catch (err) {
    console.error('analyze-news crashed:', err);
    return res.status(500).json({ error: err.message || 'server error' });
  }
});

// Video endpoint stub (keeps previous behavior)
app.post('/api/analyze-video', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    // For a demo: return placeholder or run your existing deepfake pipeline if you add it
    // We'll return a friendly placeholder with instructive message.
    const filename = req.file.filename;
    // delete uploaded file immediately to avoid storage bloat
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    return res.json({
      type: 'video',
      isDeepfake: false,
      confidence: 0,
      explanation: 'Video deepfake detection not implemented in this Node demo. Use Python/CV pipeline for deepfake analysis.',
      details: {
        note: 'Upload received and removed. Add deepfake model pipeline for full video analysis.'
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server error' });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Truth-detector backend running on port ${PORT}`);
});
