
const axios = require('axios');


function mkEvidenceItem(title, url, snippet, source) {
  return {
    title: (title || 'Untitled').slice(0, 200),
    url: url || '',
    snippet: (snippet || '').slice(0, 800).replace(/\s+/g, ' ').trim(),
    source: source || 'Unknown'
  };
}

function cleanText(text) {
  if (!text) return '';
  return String(text)
    .replace(/\[[\d\s\+]+chars\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function serperSearch(query, limit = 10) {
  const SERPER_KEY = process.env.SERPER_API_KEY || '';
  if (!SERPER_KEY) return [];
  
  try {
    console.log('[Serper] Searching Google...');
    
    const resp = await axios.post(
      'https://google.serper.dev/search',
      {
        q: query,
        num: limit
      },
      {
        headers: {
          'X-API-KEY': SERPER_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
    
    const results = [];
    
    // Regular organic results
    const organic = resp.data?.organic || [];
    organic.forEach(r => {
      results.push(mkEvidenceItem(
        r.title,
        r.link,
        cleanText(r.snippet || ''),
        'Google (Serper)'
      ));
    });
    
    // News results if available
    const news = resp.data?.news || [];
    news.forEach(r => {
      results.push(mkEvidenceItem(
        r.title,
        r.link,
        cleanText(r.snippet || ''),
        r.source || 'Google News'
      ));
    });
    
    console.log(`[Serper] Found ${results.length} results`);
    return results;
  } catch (e) {
    console.error('[Serper] Error:', e.response?.data || e.message);
    return [];
  }
}


async function valueSerpSearch(query, limit = 10) {
  const VALUESERP_KEY = process.env.VALUESERP_API_KEY || '';
  if (!VALUESERP_KEY) return [];
  
  try {
    console.log('[ValueSerp] Searching Google...');
    
    const resp = await axios.get('https://api.valueserp.com/search', {
      params: {
        api_key: VALUESERP_KEY,
        q: query,
        num: limit,
        location: 'United States',
        google_domain: 'google.com',
        gl: 'us',
        hl: 'en'
      },
      timeout: 15000
    });
    
    const results = [];
    const organic = resp.data?.organic_results || [];
    
    organic.forEach(r => {
      results.push(mkEvidenceItem(
        r.title,
        r.link,
        cleanText(r.snippet || ''),
        'Google (ValueSerp)'
      ));
    });
    
    console.log(`[ValueSerp] Found ${results.length} results`);
    return results;
  } catch (e) {
    console.error('[ValueSerp] Error:', e.response?.data || e.message);
    return [];
  }
}

async function tavilySearch(query, limit = 10) {
  const TAVILY_KEY = process.env.TAVILY_API_KEY || '';
  if (!TAVILY_KEY) return [];
  
  try {
    console.log('[Tavily] Searching...');
    
    const resp = await axios.post(
      'https://api.tavily.com/search',
      {
        api_key: TAVILY_KEY,
        query: query,
        search_depth: 'basic',
        include_answer: false,
        max_results: limit
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      }
    );
    
    const results = resp.data?.results || [];
    
    const mapped = results.map(r => mkEvidenceItem(
      r.title,
      r.url,
      cleanText(r.content || ''),
      'Tavily'
    ));
    
    console.log(`[Tavily] Found ${mapped.length} results`);
    return mapped;
  } catch (e) {
    console.error('[Tavily] Error:', e.response?.data || e.message);
    return [];
  }
}

async function youComSearch(query, limit = 10) {
  const YOU_API_KEY = process.env.YOU_API_KEY || '';
  if (!YOU_API_KEY) return [];
  
  try {
    console.log('[You.com] Searching...');
    
    const resp = await axios.get('https://api.ydc-index.io/search', {
      params: {
        query: query,
        count: limit
      },
      headers: {
        'X-API-Key': YOU_API_KEY
      },
      timeout: 15000
    });
    
    const results = [];
    const hits = resp.data?.hits || [];
    
    hits.forEach(h => {
      results.push(mkEvidenceItem(
        h.title,
        h.url,
        cleanText(h.description || h.snippets?.join(' ') || ''),
        'You.com'
      ));
    });
    
    console.log(`[You.com] Found ${results.length} results`);
    return results;
  } catch (e) {
    console.error('[You.com] Error:', e.response?.data || e.message);
    return [];
  }
}


async function exaSearch(query, limit = 10) {
  const EXA_API_KEY = process.env.EXA_API_KEY || '';
  if (!EXA_API_KEY) return [];
  
  try {
    console.log('[Exa] Searching...');
    
    const resp = await axios.post(
      'https://api.exa.ai/search',
      {
        query: query,
        numResults: limit,
        useAutoprompt: true,
        type: 'auto'
      },
      {
        headers: {
          'x-api-key': EXA_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
    
    const results = resp.data?.results || [];
    
    const mapped = results.map(r => mkEvidenceItem(
      r.title,
      r.url,
      cleanText(r.text || ''),
      'Exa'
    ));
    
    console.log(`[Exa] Found ${mapped.length} results`);
    return mapped;
  } catch (e) {
    console.error('[Exa] Error:', e.response?.data || e.message);
    return [];
  }
}


async function wikiSearchSnippets(query, limit = 3) {
  try {
    console.log('[Wikipedia] Searching...');
    
    const searchUrl = 'https://en.wikipedia.org/w/api.php';
    const resp = await axios.get(searchUrl, {
      params: {
        action: 'query',
        list: 'search',
        srsearch: query,
        format: 'json',
        srlimit: limit,
        origin: '*'
      },
      timeout: 10000
    });
    
    const searchResults = resp.data?.query?.search || [];
    const out = [];
    
    for (const r of searchResults) {
      const title = r.title;
      try {
        const summaryResp = await axios.get(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
          { timeout: 8000 }
        );
        const data = summaryResp.data;
        out.push(mkEvidenceItem(
          data.title || title,
          data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
          cleanText(data.extract || ''),
          'Wikipedia'
        ));
      } catch (e) {
        out.push(mkEvidenceItem(
          title,
          `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
          cleanText(r.snippet || '').replace(/<[^>]*>/g, ''),
          'Wikipedia'
        ));
      }
    }
    
    console.log(`[Wikipedia] Found ${out.length} results`);
    return out;
  } catch (e) {
    console.error('[Wikipedia] Error:', e.message);
    return [];
  }
}


async function retrieveEvidence(claim) {
  if (!claim || typeof claim !== 'string' || claim.trim().length < 5) {
    return [];
  }

  const q = claim.trim();
  console.log(`\n[Retriever] 🔍 Searching for: "${q.slice(0, 80)}..."`);
  
  let results = [];
  
  // Priority 1: Serper (best free option - 2500/month)
  results = await serperSearch(q, 10);
  if (results.length >= 3) {
    console.log(`[Retriever] ✅ Using ${results.length} results from Serper\n`);
    return results;
  }
  
  // Priority 2: Tavily (designed for AI - 1000/month)
  results = await tavilySearch(q, 10);
  if (results.length >= 3) {
    console.log(`[Retriever] ✅ Using ${results.length} results from Tavily\n`);
    return results;
  }
  
  // Priority 3: You.com (1000/month)
  results = await youComSearch(q, 10);
  if (results.length >= 3) {
    console.log(`[Retriever] ✅ Using ${results.length} results from You.com\n`);
    return results;
  }
  
  // Priority 4: Exa (1000/month)
  results = await exaSearch(q, 10);
  if (results.length >= 3) {
    console.log(`[Retriever] ✅ Using ${results.length} results from Exa\n`);
    return results;
  }
  
  // Priority 5: ValueSerp (100/month)
  results = await valueSerpSearch(q, 10);
  if (results.length >= 3) {
    console.log(`[Retriever] ✅ Using ${results.length} results from ValueSerp\n`);
    return results;
  }
  
  // Last resort: Wikipedia
  results = await wikiSearchSnippets(q, 3);
  if (results.length > 0) {
    console.log(`[Retriever] ✅ Using ${results.length} results from Wikipedia\n`);
    return results;
  }
  
  console.log('[Retriever] ❌ No results found\n');
  return [];
}

module.exports = {
  retrieveEvidence,
  serperSearch,
  tavilySearch,
  youComSearch,
  exaSearch,
  valueSerpSearch,
  wikiSearchSnippets
};