/**
 * kdramascraperapi – Cloudflare Worker (free tier)
 * Pure JSON proxy for https://kisskh.do/api/* – no Express, no Playwright.
 * The Express app (server.js) is untouched and still runs locally / on a VPS.
 *
 * Routes:
 *   GET /api/search?q=&type=0        → /api/DramaList/Search
 *   GET /api/list?page=&type=&sub=&country=&status=&order= → /api/DramaList/List
 *   GET /api/most-search?ispc=true   → /api/DramaList/MostSearch
 *   GET /api/drama?id=&isq=false     → /api/DramaList/Drama/:id
 *   GET /api/episode?epsId=&kkey=    → /api/DramaList/Episode/:epsId.png (→ {Video, ThirdParty} m3u8)
 *   GET /api/sub?epsId=&kkey=        → /api/Sub/:epsId (→ [{src,label}])
 *   GET /health, GET /
 */

const DEFAULT_BASE = 'https://kisskh.do';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const TTL = {
  search: 120,
  list: 300,
  'most-search': 600,
  drama: 600,
  episode: 60,
  sub: 60,
};

function getBase(env) {
  return (env.SOURCE_URL || DEFAULT_BASE).replace(/\/$/, '');
}

function isAllowed(target, env) {
  try {
    return new URL(target).origin === new URL(getBase(env)).origin;
  } catch {
    return false;
  }
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, init = {}, env) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      ...corsHeaders(env),
      ...(init.headers || {}),
    },
  });
}

function err(message, status, env, extra = {}) {
  return json({ success: false, error: message, ...extra }, { status }, env);
}

async function upstream(target, env) {
  const res = await fetch(target, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      Referer: `${getBase(env)}/`,
      Origin: getBase(env),
    },
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    const e = new Error(`HTTP ${res.status} for ${target}${body ? ` – ${body}` : ''}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

// Cloudflare edge cache (caches.default), keyed on full request URL
async function cached(request, ctx, ttl, build) {
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) {
    const body = await hit.json();
    return { res: body, hit: true };
  }
  const data = await build();
  const payload = JSON.stringify(data);
  const toCache = new Response(payload, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` },
  });
  ctx.waitUntil(cache.put(request, toCache));
  return { res: data, hit: false };
}

function countOf(data) {
  return Array.isArray(data) ? data.length : data ? 1 : 0;
}

const ROUTES = [
  {
    path: '/api/search',
    ttl: TTL.search,
    desc: 'Search dramas – GET /api/search?q=marry%20my%20husband&type=0',
    build: (base, u, env) => {
      const q = u.searchParams.get('q') || u.searchParams.get('query') || '';
      if (!q) throw Object.assign(new Error('Missing required query param: q'), { status: 400 });
      const type = u.searchParams.get('type') ?? '0';
      return `${base}/api/DramaList/Search?q=${encodeURIComponent(q)}&type=${encodeURIComponent(type)}`;
    },
  },
  {
    path: '/api/list',
    ttl: TTL.list,
    desc: 'Paginated list – GET /api/list?page=1&type=1&order=2',
    build: (base, u) => {
      const p = new URLSearchParams({ page: u.searchParams.get('page') ?? '1' });
      for (const k of ['type', 'sub', 'country', 'status', 'order']) {
        const v = u.searchParams.get(k);
        if (v != null) p.set(k, v);
      }
      return `${base}/api/DramaList/List?${p.toString()}`;
    },
  },
  {
    path: '/api/most-search',
    ttl: TTL['most-search'],
    desc: 'Most-searched – GET /api/most-search?ispc=true',
    build: (base, u) => {
      const ispc = u.searchParams.get('ispc') ?? 'true';
      return `${base}/api/DramaList/MostSearch?ispc=${encodeURIComponent(ispc)}`;
    },
  },
  {
    path: '/api/drama',
    ttl: TTL.drama,
    desc: 'Drama detail + episodes – GET /api/drama?id=8409&isq=false',
    build: (base, u) => {
      const id = u.searchParams.get('id') || '';
      if (!id) throw Object.assign(new Error('Missing required query param: id'), { status: 400 });
      const isq = u.searchParams.get('isq') ?? 'false';
      return `${base}/api/DramaList/Drama/${encodeURIComponent(id)}?isq=${encodeURIComponent(isq)}`;
    },
  },
  {
    path: '/api/episode',
    ttl: TTL.episode,
    desc: 'Stream URLs {Video, ThirdParty} – GET /api/episode?epsId=144044&kkey=...',
    build: (base, u, env) => {
      const epsId = u.searchParams.get('epsId') || u.searchParams.get('ep') || '';
      if (!epsId) throw Object.assign(new Error('Missing required query param: epsId'), { status: 400 });
      const kkey = u.searchParams.get('kkey') || env.KISSKH_STREAM_KEY || '';
      const p = new URLSearchParams({ err: 'false', ts: '', time: '' });
      if (kkey) p.set('kkey', kkey);
      return `${base}/api/DramaList/Episode/${encodeURIComponent(epsId)}.png?${p.toString()}`;
    },
  },
  {
    path: '/api/sub',
    ttl: TTL.sub,
    desc: 'Subtitles [{src,label}] – GET /api/sub?epsId=144044&kkey=...',
    build: (base, u, env) => {
      const epsId = u.searchParams.get('epsId') || u.searchParams.get('ep') || '';
      if (!epsId) throw Object.assign(new Error('Missing required query param: epsId'), { status: 400 });
      const kkey = u.searchParams.get('kkey') || env.KISSKH_SUB_KEY || '';
      const qs = kkey ? `?kkey=${encodeURIComponent(kkey)}` : '';
      return `${base}/api/Sub/${encodeURIComponent(epsId)}${qs}`;
    },
  },
];

export default {
  async fetch(request, env, ctx) {
    const u = new URL(request.url);
    env = env || {};

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (request.method !== 'GET') {
      return err('Only GET is supported', 405, env);
    }

    if (u.pathname === '/health') {
      return json({ status: 'ok' }, {}, env);
    }
    if (u.pathname === '/' ) {
      return json(
        {
          name: 'kdramascraperapi',
          sourceUrl: getBase(env),
          runtime: 'cloudflare-worker',
          endpoints: ROUTES.map((r) => ({ method: 'GET', path: r.path, kind: 'api', description: r.desc })),
        },
        {},
        env
      );
    }

    const route = ROUTES.find((r) => r.path === u.pathname);
    if (!route) {
      return json(
        {
          success: false,
          error: 'Not found',
          available: ROUTES.map((r) => `GET ${r.path}`).concat(['GET /', 'GET /health']),
        },
        { status: 404 },
        env
      );
    }

    const start = Date.now();
    let target;
    try {
      target = route.build(getBase(env), u, env);
      if (!isAllowed(target, env)) throw new Error('Resolved URL is not allowed');
    } catch (e) {
      return err(e.message, e.status || 400, env);
    }

    try {
      const { res: data, hit } = await cached(request, ctx, route.ttl, () => upstream(target, env));
      return json(
        {
          success: true,
          cached: hit,
          source: target,
          count: countOf(data),
          data,
          tookMs: Date.now() - start,
        },
        { headers: { 'X-Cache': hit ? 'HIT' : 'MISS' } },
        env
      );
    } catch (e) {
      const status = e.status && e.status < 500 ? e.status : 502;
      return json(
        { success: false, error: 'Upstream failed', details: e.message, source: target },
        { status },
        env
      );
    }
  },
};
