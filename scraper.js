/**
 * Minimal scraper helper – standalone copy for generated project.
 * Uses axios + cheerio by default, optionally Playwright for JS-rendered.
 */
const axios = require('axios');
const cheerio = require('cheerio');

function isSafeUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(u.protocol)) return false;
  const host = u.hostname.toLowerCase();
  // Block localhost / private / link-local / metadata to prevent SSRF
  if (['localhost', '0.0.0.0', '::1'].includes(host)) return false;
  if (/^127\./.test(host)) return false;
  if (/^10\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (host.endsWith('.local')) return false;
  return true;
}

function mergeHeaders(defaults, extra = {}) {
  // axios defaults.headers can be nested ({ common, get, ... }); flatten safely
  const flat = {};
  if (defaults && typeof defaults === 'object') {
    for (const v of Object.values(defaults)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(flat, v);
      else if (typeof v === 'string') Object.assign(flat, { Accept: v });
    }
    // also copy plain string keys directly set on defaults
    for (const [k, v] of Object.entries(defaults)) {
      if (typeof v === 'string') flat[k] = v;
    }
  }
  return { ...flat, ...extra };
}

const http = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  },
  validateStatus: () => true,
});

async function fetchStatic(url, headers = {}) {
  if (!isSafeUrl(url)) {
    const err = new Error(`Blocked unsafe URL: ${url}`);
    err.status = 400;
    throw err;
  }
  const res = await http.get(url, {
    headers: mergeHeaders(http.defaults.headers, headers),
    maxRedirects: 5,
    maxContentLength: 5 * 1024 * 1024,
  });
  if (res.status >= 400) {
    const err = new Error(`HTTP ${res.status} for ${url}`);
    err.status = res.status;
    throw err;
  }
  return typeof res.data === 'string' ? res.data : String(res.data);
}

// ── Reused browser (avoids launching Chromium per request) ─────────────
let _browserPromise = null;
// One shared context: pages are cheap, contexts carry warm state (cookies,
// storage, JIT) that speeds up repeat mints. Never closed per-request.
let _sharedContextPromise = null;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function getBrowser(playwright) {
  if (!_browserPromise) {
    _browserPromise = (async () => {
      const baseOpts = { headless: true };
      // Render-safe: chromium-headless-shell needs no apt deps and no root.
      // Install with: npx playwright install chromium-headless-shell
      // Override with PLAYWRIGHT_CHANNEL=chromium (full build) if available.
      const channels = process.env.PLAYWRIGHT_CHANNEL
        ? [process.env.PLAYWRIGHT_CHANNEL]
        : ['chromium-headless-shell', undefined];
      let lastErr;
      for (const channel of channels) {
        try {
          return await playwright.chromium.launch(channel ? { ...baseOpts, channel } : baseOpts);
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr;
    })().catch((e) => {
      _browserPromise = null;
      throw e;
    });
  }
  return _browserPromise;
}

async function closeBrowser() {
  if (_browserPromise) {
    const b = await _browserPromise.catch(() => null);
    _browserPromise = null;
    _sharedContextPromise = null;
    if (b) await b.close().catch(() => {});
  }
}

// Drop cached browser/context when the engine dies so the next call relaunches.
function resetBrowserState() {
  _browserPromise = null;
  _sharedContextPromise = null;
}

function isBrowserDeadError(e) {
  return /closed|crashed|destroyed|disconnected|target crashed/i.test(e?.message || '');
}

async function getSharedContext(playwright) {
  const browser = await getBrowser(playwright);
  if (!_sharedContextPromise) {
    _sharedContextPromise = browser
      .newContext({ userAgent: BROWSER_UA })
      .then(async (ctx) => {
        // mint pages only need document+scripts+API calls: abort dead weight
        // so episode pages load in a fraction of the time.
        await ctx
          .route('**/*', (route) => {
            const t = route.request().resourceType();
            if (['image', 'media', 'font', 'stylesheet'].includes(t)) return route.abort();
            return route.continue();
          })
          .catch(() => {});
        return ctx;
      })
      .catch((e) => {
        _sharedContextPromise = null;
        if (isBrowserDeadError(e)) resetBrowserState();
        throw e;
      });
  }
  return { browser, context: await _sharedContextPromise };
}

// Best-effort browser warmup at server boot: pays Chromium launch + context
// creation before the first mint needs it. Silent no-op without Playwright.
async function warmBrowser() {
  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    return false;
  }
  try {
    await getSharedContext(playwright);
    return true;
  } catch (e) {
    console.warn('[warmBrowser] skipped:', e.message);
    return false;
  }
}

process.once('exit', () => {
  if (_browserPromise) {
    _browserPromise.then((b) => b && b.close().catch(() => {})).catch(() => {});
  }
});

async function fetchRendered(url, opts = {}) {
  if (!isSafeUrl(url)) {
    const err = new Error(`Blocked unsafe URL: ${url}`);
    err.status = 400;
    throw err;
  }
  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    throw new Error('Playwright not installed. Run: npm i playwright && npx playwright install chromium');
  }
  const browser = await getBrowser(playwright);
  const context = await browser.newContext({
    userAgent:
      opts.userAgent || BROWSER_UA,
  });
  try {
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: opts.waitUntil || 'domcontentloaded', timeout: opts.timeout || 15000 });
      if (opts.waitForSelector) await page.waitForSelector(opts.waitForSelector, { timeout: 8000 }).catch(() => {});
      if (opts.delayMs) await page.waitForTimeout(opts.delayMs);
      return await page.content();
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await context.close().catch(() => {});
  }
}

async function fetchHtml(url, opts = {}) {
  if (opts.renderJs) return fetchRendered(url, opts);
  return fetchStatic(url, opts.headers);
}

// ── kkey minting (KissKH stream/sub auth) ──────────────────────────────
// Visits the episode page in headless Chromium and sniffs the short-lived
// `kkey` tokens the page itself requests for /api/DramaList/Episode/*.png
// (stream) and /api/Sub/* (subtitles). Requires playwright + chromium.
// kkeys expire in seconds – call /api/episode and /api/sub immediately after.
function slugify(title) {
  return String(title || 'drama')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'drama';
}

function episodePageUrl(base, { title, dramaId, epsNum, epsId }) {
  const slug = slugify(title);
  return `${base}/Drama/${slug}/Episode-${epsNum}?id=${encodeURIComponent(String(dramaId))}&ep=${encodeURIComponent(String(epsId))}&page=0&pageSize=100`;
}

// ── Subtitle language filter ───────────────────────────────────────────
// /api/Sub/:epsId returns [{src, label}] in many languages. `lang` picks one:
// 'en' (default), 'all' to disable, or any code/name ('id', 'indonesian').
// Matched on whole tokens so 'en' never matches 'french'.
const SUB_LANG_ALIASES = {
  en: ['en', 'eng', 'english'],
  id: ['id', 'ind', 'indonesian', 'bahasa'],
  ms: ['ms', 'malay', 'melayu'],
  ar: ['ar', 'arabic'],
  hi: ['hi', 'hindi'],
  es: ['es', 'spanish', 'espanol'],
  pt: ['pt', 'portuguese'],
  fr: ['fr', 'french'],
  de: ['de', 'german'],
  th: ['th', 'thai'],
  vi: ['vi', 'vietnamese'],
  zh: ['zh', 'chinese'],
  ko: ['ko', 'korean'],
  ja: ['ja', 'japanese'],
};

function subAcceptedTokens(lang) {
  const want = String(lang || 'en').toLowerCase();
  for (const [canonical, aliases] of Object.entries(SUB_LANG_ALIASES)) {
    if (want === canonical || aliases.includes(want)) return aliases;
  }
  return [want];
}

function subMatchesLang(label, lang) {
  const tokens = String(label || '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  const accepted = subAcceptedTokens(lang);
  return tokens.some((t) => accepted.includes(t));
}

function filterSubtitles(subs, lang = 'en') {
  if (!Array.isArray(subs)) return subs;
  if (String(lang).toLowerCase() === 'all') return subs;
  const languages = [...new Set(subs.map((s) => s?.label).filter(Boolean))];
  const data = subs.filter((s) => subMatchesLang(s?.label, lang));
  return { data, languages, lang: String(lang).toLowerCase() };
}

// ── HLS playlist rewriting (stream proxy) ──────────────────────────────
// Rewrites segment/key/init URIs in an .m3u8 to same-origin proxy URLs so
// browsers avoid CDN CORS/hotlink blocks. Nested .m3u8 URIs point back at
// the playlist proxy; everything else points at the byte proxy.
function checkMediaSrc(src, allowedExts) {
  if (!src) return 'Missing required query param: src';
  let u;
  try {
    u = new URL(src);
  } catch {
    return 'Invalid src URL';
  }
  if (!['http:', 'https:'].includes(u.protocol)) return 'src must be http(s)';
  if (!isSafeUrl(src)) return 'src host not allowed';
  const path = u.pathname.toLowerCase();
  if (!allowedExts.some((ext) => path.endsWith(ext))) return `src must end with ${allowedExts.join('/')}`;
  return null;
}

function rewritePlaylist(text, m3u8Url, toProxy) {
  return String(text)
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (m, uri) => `URI="${toProxy(uri)}"`);
      // bare URI line (relative or absolute)
      return toProxy(t);
    })
    .join('\n');
}

function proxyPlaylistUrls(text, m3u8Url, proxyBase) {
  return rewritePlaylist(text, m3u8Url, (uri) => {
    let abs;
    try {
      abs = new URL(uri, m3u8Url).toString();
    } catch {
      return uri;
    }
    const isList = abs.toLowerCase().split('?')[0].endsWith('.m3u8');
    return `${proxyBase}/api/${isList ? 'stream' : 'segment'}?src=${encodeURIComponent(abs)}`;
  });
}

async function mintKkeys({ pageUrl, timeoutMs = 30000 }) {
  if (!isSafeUrl(pageUrl)) {
    const err = new Error(`Blocked unsafe URL: ${pageUrl}`);
    err.status = 400;
    throw err;
  }
  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    const err = new Error('Playwright not installed. Run: npm i playwright && npx playwright install chromium');
    err.status = 503;
    throw err;
  }
  const { context } = await getSharedContext(playwright);
  const found = {};
  const page = await context.newPage().catch((e) => {
    if (isBrowserDeadError(e)) resetBrowserState();
    throw e;
  });
  try {
    page.on('request', (req) => {
      let u;
      try {
        u = new URL(req.url());
      } catch {
        return;
      }
      const kkey = u.searchParams.get('kkey');
      if (!kkey) return;
      if (u.pathname.includes('/api/DramaList/Episode/') && !found.streamKey) found.streamKey = kkey;
      if (u.pathname.includes('/api/Sub/') && !found.subKey) found.subKey = kkey;
    });
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
    // Return fast: once the stream key lands, give the sub key only a short
    // grace period (KKEY_SUB_GRACE_MS, default 4s) instead of the full timeout.
    // Frontend can start playback on streamKey immediately and retry for subs.
    const graceMs = Number(process.env.KKEY_SUB_GRACE_MS) || 4000;
    const t0 = Date.now();
    let streamAt = 0;
    for (;;) {
      if (found.streamKey && !streamAt) streamAt = Date.now();
      if (found.streamKey && found.subKey) break;
      if (streamAt && Date.now() - streamAt > graceMs) break;
      if (Date.now() - t0 > timeoutMs) break;
      await page.waitForTimeout(250).catch(() => new Promise((r) => setTimeout(r, 250)));
    }
    return { streamKey: found.streamKey || null, subKey: found.subKey || null, pageUrl };
  } catch (e) {
    if (isBrowserDeadError(e)) resetBrowserState();
    throw e;
  } finally {
    // page only – the shared context stays warm for the next mint
    await page.close().catch(() => {});
  }
}

function extractField($, $root, def) {
  if (typeof def === 'function') return def($root, $);
  if (def && typeof def === 'object' && !Array.isArray(def)) {
    const sel = def.selector || def.sel || '';
    const $t = sel ? $root.find(sel).first() : $root;
    if ($t.length === 0) return def.default ?? null;
    if (def.attr || def.attribute) {
      const v = $t.attr(def.attr || def.attribute);
      return typeof v === 'string' ? v.trim() || (def.default ?? null) : (def.default ?? null);
    }
    if (def.html) return $t.html()?.trim() ?? def.default ?? null;
    const txt = $t.text();
    return def.trim === false ? txt : txt.trim() || (def.default ?? null);
  }
  const str = String(def).trim();
  if (str === '@text') return $root.text().trim() || null;
  if (str === '@html') return $root.html()?.trim() || null;
  const parts = str.split('|').map((s) => s.trim());
  for (const part of parts) {
    if (!part || part === '@text' || part === '@html') continue;
    if (part.includes('@')) {
      const [sel, attr] = part.split('@').map((s) => s.trim());
      if (!attr) continue;
      const $t = sel ? $root.find(sel).first() : $root;
      if ($t.length === 0) continue;
      const v = $t.attr(attr);
      if (v) return v.trim();
    } else if (part) {
      const $t = $root.find(part).first();
      if ($t.length === 0) continue;
      const txt = $t.text().trim();
      if (txt) return txt;
    }
  }
  return null;
}

async function scrape(opts) {
  if (!opts?.url) throw new Error('scrape: opts.url required');
  if (!opts?.selector) throw new Error('scrape: opts.selector required');
  if (!isSafeUrl(opts.url)) {
    const err = new Error(`Blocked unsafe URL: ${opts.url}`);
    err.status = 400;
    throw err;
  }
  const html = await fetchHtml(opts.url, { renderJs: !!opts.renderJs, ...(opts.fetchOpts || {}) });
  const $ = cheerio.load(html);
  if (opts.single) {
    const $root = $(opts.selector).first();
    if ($root.length === 0) return null;
    const out = {};
    for (const [k, def] of Object.entries(opts.fields || {})) out[k] = extractField($, $root, def);
    return out;
  }
  const results = [];
  const limit = opts.limit != null ? Math.max(1, Math.min(Number(opts.limit) || 50, 200)) : 50;
  $(opts.selector).each((_, el) => {
    if (results.length >= limit) return false;
    const $el = $(el);
    const obj = {};
    const fields = opts.fields || {};
    if (Object.keys(fields).length === 0) {
      obj.text = $el.text().trim();
    } else {
      for (const [k, def] of Object.entries(fields)) obj[k] = extractField($, $el, def);
    }
    results.push(obj);
  });
  return results;
}

module.exports = { http, fetchStatic, fetchRendered, fetchHtml, scrape, extractField, isSafeUrl, closeBrowser, mintKkeys, slugify, episodePageUrl, checkMediaSrc, rewritePlaylist, proxyPlaylistUrls, filterSubtitles, subMatchesLang, warmBrowser, getSharedContext, getBrowser };
