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

async function getBrowser(playwright) {
  if (!_browserPromise) {
    _browserPromise = playwright.chromium.launch({ headless: true }).catch((e) => {
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
    if (b) await b.close().catch(() => {});
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
      opts.userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
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

module.exports = { http, fetchStatic, fetchRendered, fetchHtml, scrape, extractField, isSafeUrl, closeBrowser };
