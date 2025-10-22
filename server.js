// backend/server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { retrieveEvidence } = require('./retriever');
const { callOpenRouterChat, extractJsonFromText } = require('./llm');
const { detectAIWithGPTZero, detectAIFallback } = require('./ai-detector');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '6mb' }));
app.use(express.urlencoded({ extended: true }));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const upload = multer({ dest: uploadDir, limits: { fileSize: 200 * 1024 * 1024 } });

// Extract claims using LLM
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

// Build fact-checking prompt
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

// MAIN ROUTE: Analyze news
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

    // Step 4: AI detection with GPTZero (primary) or fallback
    console.log('Detecting AI authorship...');
    let aiDetection;
    try {
      aiDetection = await detectAIWithGPTZero(text);
      console.log('✅ Used GPTZero for AI detection');
    } catch (e) {
      console.log('⚠️ GPTZero unavailable, using fallback detector');
      aiDetection = await detectAIFallback(text);
    }

    // Step 5: Combine results
    const finalResult = {
      type: 'news',
      claims: factCheckResult.claims || [],
      overallAssessment: factCheckResult.overallAssessment || '',
      isAIWritten: aiDetection.isAIWritten,
      aiConfidence: aiDetection.aiConfidence,
      aiExplanation: aiDetection.aiExplanation,
      detectionMethod: aiDetection.method || 'unknown'
    };

    console.log('=== Analysis Complete ===\n');
    return res.json(finalResult);

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Standalone AI detection endpoint
app.post('/api/detect-ai', async (req, res) => {
  try {
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Text required' });

    let result;
    try {
      result = await detectAIWithGPTZero(text);
    } catch (e) {
      result = await detectAIFallback(text);
    }
    
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