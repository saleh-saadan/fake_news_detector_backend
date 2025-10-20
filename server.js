// backend/server.js
require('dotenv').config();

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

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const upload = multer({ dest: uploadDir, limits: { fileSize: 200 * 1024 * 1024 } });

// IMPROVED: Better claim extraction using LLM
async function extractClaimsWithLLM(text) {
  const prompt = `Extract 2-4 specific, verifiable factual claims from this text. Return ONLY valid JSON:
{"claims": ["claim 1", "claim 2", ...]}

Focus on:
- Specific events (who did what, when, where)
- Named entities (people, places, organizations)
- Numbers, statistics, dates
- Avoid opinions or vague statements

TEXT:
${text}`;

  try {
    const messages = [
      { role: 'system', content: 'You extract factual claims as JSON.' },
      { role: 'user', content: prompt }
    ];
    const response = await callOpenRouterChat(messages, 300);
    const parsed = extractJsonFromText(response);
    if (parsed && Array.isArray(parsed.claims)) {
      return parsed.claims.filter(c => c && c.length > 10).slice(0, 4);
    }
  } catch (e) {
    console.error('LLM claim extraction failed:', e.message);
  }
  
  // Fallback to basic extraction
  const sentences = text
    .replace(/\n/g, ' ')
    .split(/(?<=[\.\?\!])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 20);
  
  return sentences.slice(0, 3);
}

// IMPROVED: More sophisticated prompt with better instructions
function buildAnalysisPrompt(fullText, claimsAndEvidence) {
  const systemPrompt = `You are a professional fact-checker. Analyze claims based on provided evidence and return STRICT JSON only.

RULES:
1. SUPPORTED = Evidence clearly confirms the claim is TRUE
2. REFUTED = Evidence clearly shows the claim is FALSE or CONTRADICTS it
3. INSUFFICIENT = Not enough evidence, or evidence is ambiguous

CRITICAL: If you find NO relevant evidence for a claim about a specific event/person, it's likely FALSE. Real events have documentation.

Return JSON format:
{
  "claims": [
    {
      "claim": "exact claim text",
      "verdict": "SUPPORTED" | "REFUTED" | "INSUFFICIENT",
      "confidence": 0-100,
      "explanation": "1-2 sentence reasoning",
      "topEvidence": [{"title": "...", "url": "...", "snippet": "..."}]
    }
  ],
  "overallAssessment": "2-3 sentence summary of content credibility"
}`;

  let userPrompt = `FULL TEXT TO ANALYZE:\n${fullText}\n\n`;
  userPrompt += `CLAIMS AND EVIDENCE:\n\n`;

  for (let i = 0; i < claimsAndEvidence.length; i++) {
    const { claim, evidence } = claimsAndEvidence[i];
    userPrompt += `CLAIM ${i + 1}: "${claim}"\n`;
    
    if (evidence.length === 0) {
      userPrompt += `EVIDENCE: NONE FOUND (suspicious - real events should have sources)\n\n`;
    } else {
      userPrompt += `EVIDENCE:\n`;
      evidence.forEach((e, idx) => {
        userPrompt += `${idx + 1}. ${e.title}\n   URL: ${e.url}\n   SNIPPET: ${e.snippet.slice(0, 400)}\n\n`;
      });
    }
  }

  userPrompt += '\nReturn ONLY valid JSON with the structure above. No markdown, no extra text.';
  
  return { systemPrompt, userPrompt };
}

// IMPROVED: AI detection with MUCH better prompt and scoring system
async function detectAIContent(text) {
  const prompt = `You are an expert at detecting AI-generated text. Analyze this text and assign a score from 0-100:

**SCORING GUIDE (be specific and varied):**
- **0-20**: Clearly human (typos, informal, personal anecdotes, emotional, imperfect grammar, slang, first-person storytelling)
- **21-40**: Probably human (natural flow, some informality, minor errors, human-like structure)
- **41-60**: Uncertain (could be either - mixed signals)
- **61-80**: Probably AI (formal, structured, polished, generic phrasing, lacks personality)
- **81-100**: Clearly AI (perfect grammar, repetitive structure, overly formal, generic transitions like "Furthermore", "Moreover", lacks any personal touch)

**AI INDICATORS (increase score):**
- Perfect grammar and punctuation throughout
- Repetitive sentence structures (e.g., all sentences same length)
- Generic phrases: "delve into", "it's important to note", "in conclusion", "furthermore", "moreover"
- Overly balanced/diplomatic tone (no strong opinions)
- Lists and bullet points for everything
- Academic formality in casual context
- Lacks contractions (says "cannot" instead of "can't")
- No typos, no informal language whatsoever

**HUMAN INDICATORS (decrease score):**
- Typos, grammatical errors, punctuation mistakes
- Informal language, slang, contractions
- Personal experiences ("I remember when...", "My friend told me...")
- Emotional language (excitement, frustration, humor)
- Stream-of-consciousness or rambling
- Inconsistent formatting or structure
- Abbreviations (like "bruh", "lol", "idk")
- Direct address to reader in casual way
- Incomplete sentences or thoughts

**IMPORTANT:** Don't default to 70%! Be decisive. Most texts are clearly one or the other.

Return ONLY valid JSON:
{
  "aiConfidence": <number 0-100>,
  "aiExplanation": "<1 sentence explaining the score>",
  "keyIndicators": ["<indicator 1>", "<indicator 2>", "<indicator 3>"]
}

TEXT TO ANALYZE:
${text}`;

  const messages = [
    { role: 'system', content: 'You are a decisive AI content detector. You give varied scores from 0-100, not just 70.' },
    { role: 'user', content: prompt }
  ];

  try {
    const response = await callOpenRouterChat(messages, 350);
    const parsed = extractJsonFromText(response);
    
    if (parsed && typeof parsed.aiConfidence === 'number') {
      const confidence = Math.max(0, Math.min(100, parsed.aiConfidence)); // Clamp 0-100
      const isAIWritten = confidence >= 60;
      
      return {
        isAIWritten,
        aiConfidence: confidence,
        aiExplanation: parsed.aiExplanation || 'Analysis completed',
        keyIndicators: parsed.keyIndicators || []
      };
    }
  } catch (e) {
    console.error('AI detection failed:', e.message);
  }
  
  // Fallback - analyze basic patterns
  return analyzeTextPatterns(text);
}

// Fallback heuristic analyzer if LLM fails
function analyzeTextPatterns(text) {
  let score = 50; // Start neutral
  
  // AI indicators (increase score)
  const aiPhrases = ['furthermore', 'moreover', 'it is important to note', 'in conclusion', 'delve into', 'comprehensive', 'leverage', 'utilize'];
  const foundAiPhrases = aiPhrases.filter(phrase => text.toLowerCase().includes(phrase));
  score += foundAiPhrases.length * 8;
  
  // Check for perfect grammar (no typos)
  const hasTypos = /\b(teh|recieve|occured|thier|definately|seperate)\b/i.test(text);
  if (!hasTypos && text.length > 100) score += 10;
  
  // Check for contractions (humans use them more)
  const contractions = (text.match(/\b(can't|don't|won't|isn't|aren't|wasn't|weren't|haven't|hasn't|wouldn't|couldn't|shouldn't)\b/gi) || []).length;
  const words = text.split(/\s+/).length;
  const contractionRate = contractions / words;
  if (contractionRate < 0.01 && words > 50) score += 15; // Very few contractions = AI-like
  
  // Human indicators (decrease score)
  const humanPhrases = ['lol', 'lmao', 'bruh', 'tbh', 'idk', 'omg', 'wtf', 'ngl'];
  const foundHumanPhrases = humanPhrases.filter(phrase => text.toLowerCase().includes(phrase));
  score -= foundHumanPhrases.length * 12;
  
  // Check for emotional punctuation
  const exclamations = (text.match(/!/g) || []).length;
  const questions = (text.match(/\?/g) || []).length;
  if (exclamations + questions > 3) score -= 10;
  
  // Check for personal pronouns
  const personalPronouns = (text.match(/\b(I|me|my|mine|myself)\b/g) || []).length;
  if (personalPronouns > 3) score -= 15;
  
  // Clamp score
  score = Math.max(0, Math.min(100, score));
  
  let explanation = '';
  if (score >= 70) {
    explanation = 'Text shows formal structure and polished language typical of AI generation';
  } else if (score >= 40) {
    explanation = 'Mixed signals - text has both human and AI-like characteristics';
  } else {
    explanation = 'Text contains informal language and personal elements typical of human writing';
  }
  
  return {
    isAIWritten: score >= 60,
    aiConfidence: score,
    aiExplanation: explanation,
    keyIndicators: []
  };
}

// MAIN ROUTE: Analyze news with improved logic
app.post('/api/analyze-news', async (req, res) => {
  try {
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Text is required' });

    console.log('\n=== Starting Analysis ===');

    // Step 1: Extract claims using LLM
    console.log('Extracting claims...');
    const claims = await extractClaimsWithLLM(text);
    console.log('Extracted claims:', claims);

    // Step 2: Retrieve evidence for each claim
    console.log('Retrieving evidence...');
    const claimsAndEvidence = [];
    for (const claim of claims) {
      const evidence = await retrieveEvidence(claim);
      console.log(`Evidence for "${claim.slice(0, 50)}...": ${evidence.length} sources`);
      claimsAndEvidence.push({ claim, evidence });
    }

    // Step 3: Fact-check with LLM
    console.log('Calling LLM for fact-checking...');
    const { systemPrompt, userPrompt } = buildAnalysisPrompt(text, claimsAndEvidence);
    
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    let factCheckResponse;
    try {
      factCheckResponse = await callOpenRouterChat(messages, 1500);
    } catch (llmErr) {
      console.error('LLM error:', llmErr.message);
      return res.status(502).json({ 
        error: 'LLM service unavailable',
        details: llmErr.message 
      });
    }

    const factCheckResult = extractJsonFromText(factCheckResponse);
    if (!factCheckResult) {
      console.error('Failed to parse LLM response:', factCheckResponse);
      return res.status(502).json({ 
        error: 'Invalid LLM response format',
        rawResponse: factCheckResponse 
      });
    }

    // Step 4: AI detection
    console.log('Detecting AI authorship...');
    const aiDetection = await detectAIContent(text);

    // Step 5: Combine results
    const finalResult = {
      type: 'news',
      claims: factCheckResult.claims || [],
      overallAssessment: factCheckResult.overallAssessment || '',
      isAIWritten: aiDetection.isAIWritten,
      aiConfidence: aiDetection.aiConfidence,
      aiExplanation: aiDetection.aiExplanation
    };

    console.log('=== Analysis Complete ===\n');
    return res.json(finalResult);

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Standalone AI detection endpoint (optional)
app.post('/api/detect-ai', async (req, res) => {
  try {
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Text required' });

    const result = await detectAIContent(text);
    return res.json(result);
  } catch (e) {
    console.error('AI detection error:', e);
    return res.status(500).json({ error: e.message });
  }
});

// Video analysis (unchanged)
app.post('/api/analyze-video', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const videoPath = req.file.path;

    const pyPath = path.join(__dirname, 'ai_models', 'deepfake_detector.py');
    if (!fs.existsSync(pyPath)) {
      try { fs.unlinkSync(videoPath); } catch (e) {}
      return res.status(501).json({ error: 'Deepfake detector not available' });
    }

    const { spawn } = require('child_process');
    const py = spawn('python3', [pyPath, videoPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';

    py.stdout.on('data', (d) => { out += d.toString(); });
    py.stderr.on('data', (d) => { err += d.toString(); });

    py.on('close', (code) => {
      try { fs.unlinkSync(videoPath); } catch (e) {}
      if (code !== 0) {
        console.error('Python error:', err);
        return res.status(502).json({ error: 'Deepfake analysis failed', details: err });
      }
      try {
        const result = JSON.parse(out);
        return res.json(result);
      } catch (e) {
        return res.status(502).json({ error: 'Invalid python output', raw: out });
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