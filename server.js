
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


async function extractClaimsWithLLM(text) {
  // quick guard
  text = (text || '').trim();
  if (!text || text.length < 20) {
    console.log('[ClaimsExtractor] input too short for LLM, using tiny fallback');
  
    return text ? [text.slice(0, 400)] : [];
  }

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

    const response = await callOpenRouterChat(messages, 400);
    console.log('[ClaimsExtractor] raw LLM response:', String(response).slice(0, 1200));

    const parsed = extractJsonFromText(response);
    if (parsed && Array.isArray(parsed.claims) && parsed.claims.length) {
      // normalize and trim
      const cleaned = parsed.claims
        .map(c => (c || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 4);
      if (cleaned.length) {
        console.log('[ClaimsExtractor] got claims from LLM:', cleaned);
        return cleaned;
      }
    }

    console.log('[ClaimsExtractor] LLM returned no usable JSON claims; falling back to heuristic extraction');
  } catch (err) {
    console.error('[ClaimsExtractor] LLM call error:', err && (err.message || err.toString()));
  }


  const sentences = text
    .replace(/\n+/g, ' ')
    .split(/(?<=[.?!])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 20);

  const facts = [];
  const factyWords = /\b(Inc|Ltd|Corp|Company|University|said|announced|acquired|acquisition|acquires|acquired|bought|sold|deal|agreement|%|\d{4}|\d+)\b/i;

  for (const s of sentences) {
    if (facts.length >= 4) break;
    
    if (factyWords.test(s) || /[A-Z][a-z]{2,}\s[A-Z][a-z]{2,}/.test(s)) {
      facts.push(s.replace(/\s+/g, ' ').trim());
    }
  }

  if (facts.length === 0) {
    const fallback = sentences
      .sort((a, b) => b.length - a.length)
      .slice(0, 3)
      .map(s => s.replace(/\s+/g, ' ').trim());
    if (fallback.length) {
      console.log('[ClaimsExtractor] fallback long-sentences used:', fallback);
      return fallback;
    }
  }

  console.log('[ClaimsExtractor] heuristic claims:', facts);
  return facts;
}



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


app.post('/api/analyze-news', async (req, res) => {
  try {
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Text is required' });

    console.log('\n=== Starting Analysis ===');


    console.log('Extracting claims...');
    const claims = await extractClaimsWithLLM(text);
    console.log('Extracted claims:', claims);


    console.log('Retrieving evidence...');
    const claimsAndEvidence = [];
    for (const claim of claims) {
      const evidence = await retrieveEvidence(claim);
      console.log(`Evidence for "${claim.slice(0, 50)}...": ${evidence.length} sources`);
      claimsAndEvidence.push({ claim, evidence });
    }

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


    console.log('Detecting AI authorship...');
    let aiDetection;
    try {
      aiDetection = await detectAIWithGPTZero(text);
      console.log('✅ Used GPTZero for AI detection');
    } catch (e) {
      console.log('⚠️ GPTZero unavailable, using fallback detector');
      aiDetection = await detectAIFallback(text);
    }

   
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




app.post('/api/analyze-video', upload.single('video'), async (req, res) => {
  let videoPath = null;
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }
    
    videoPath = req.file.path;
    console.log('Video uploaded:', videoPath);

    const pyPath = path.join(__dirname, 'ai_models', 'deepfake_detector.py');
    
    if (!fs.existsSync(pyPath)) {
      console.error('Python script not found:', pyPath);
      if (videoPath) {
        try { fs.unlinkSync(videoPath); } catch (e) {}
      }
      return res.status(501).json({ 
        error: 'Deepfake detector not available',
        path: pyPath 
      });
    }

    console.log('Running Python detector...');
    
    const { spawn } = require('child_process');
    const py = spawn('python3', [pyPath, videoPath], { 
      stdio: ['ignore', 'pipe', 'pipe'] 
    });
    
    let stdout = '';
    let stderr = '';

    py.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    py.stderr.on('data', (data) => {
      stderr += data.toString();
      console.log('Python stderr:', data.toString());
    });

    py.on('error', (error) => {
      console.error('Failed to start Python process:', error);
      if (videoPath) {
        try { fs.unlinkSync(videoPath); } catch (e) {}
      }
      return res.status(502).json({ 
        error: 'Failed to start deepfake detector',
        details: error.message 
      });
    });

    py.on('close', (code) => {
     
      if (videoPath) {
        try { 
          fs.unlinkSync(videoPath); 
          console.log('Video file deleted');
        } catch (e) {
          console.error('Failed to delete video:', e.message);
        }
      }

      console.log('Python process exited with code:', code);
      console.log('Python stdout:', stdout);
      
      if (code !== 0) {
        console.error('Python error (code ' + code + '):', stderr);
        return res.status(502).json({ 
          error: 'Deepfake analysis failed',
          exitCode: code,
          details: stderr,
          stdout: stdout
        });
      }

      try {
        const result = JSON.parse(stdout.trim());
        console.log('Analysis result:', result);
        return res.json(result);
      } catch (parseError) {
        console.error('Failed to parse Python output:', parseError.message);
        console.error('Raw stdout:', stdout);
        return res.status(502).json({ 
          error: 'Invalid JSON from deepfake detector',
          details: parseError.message,
          raw: stdout,
          stderr: stderr
        });
      }
    });

  } catch (err) {
    console.error('Video analysis error:', err);
    if (videoPath) {
      try { fs.unlinkSync(videoPath); } catch (e) {}
    }
    return res.status(500).json({ 
      error: 'Server error',
      details: err.message 
    });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Truth-detector backend running on port ${PORT}`);
});