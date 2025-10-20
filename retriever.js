// backend/retriever.js
const axios = require('axios');

const NEWSAPI_KEY = process.env.NEWSAPI_KEY || '';

/**
 * Simple Wikipedia search + summary retriever using MediaWiki API.
 * Returns array of { title, url, snippet }.
 */
async function wikiSearchSnippets(query, limit = 3) {
  try {
    const searchUrl = 'https://en.wikipedia.org/w/api.php';
    const searchParams = {
      action: 'query',
      list: 'search',
      srsearch: query,
      format: 'json',
      srlimit: limit
    };
    const resp = await axios.get(searchUrl, { params: searchParams, timeout: 8000 });
    const searchResults = resp.data?.query?.search || [];
    const out = [];

    for (const r of searchResults) {
      const title = r.title;
      // use summary endpoint
      try {
        const summaryResp = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, { timeout: 8000 });
        const data = summaryResp.data;
        out.push({
          title: data.title || title,
          url: data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
          snippet: (data.extract || '').slice(0, 1200)
        });
      } catch (e) {
        // fallback to basic
        out.push({
          title,
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
          snippet: ''
        });
      }
    }
    return out;
  } catch (e) {
    return [];
  }
}

/**
 * Optional: NewsAPI search (requires NEWSAPI_KEY)
 */
async function newsApiSearch(query, limit = 4) {
  if (!NEWSAPI_KEY) return [];
  try {
    const resp = await axios.get('https://newsapi.org/v2/everything', {
      params: {
        q: query,
        language: 'en',
        sortBy: 'relevancy',
        pageSize: limit,
        apiKey: NEWSAPI_KEY
      },
      timeout: 8000
    });
    return (resp.data.articles || []).map(a => ({
      title: a.title,
      url: a.url,
      snippet: (a.description || a.content || '').slice(0, 1200),
      source: a.source?.name || ''
    }));
  } catch (e) {
    return [];
  }
}

/**
 * Top-level retriever: try news first (if API key), then wiki fallback.
 * Returns combined results (news first then wiki).
 */
async function retrieveEvidence(claim) {
  const news = await newsApiSearch(claim, 4);
  if (news && news.length) return news;
  const wiki = await wikiSearchSnippets(claim, 3);
  return wiki;
}

module.exports = { retrieveEvidence, wikiSearchSnippets, newsApiSearch };
