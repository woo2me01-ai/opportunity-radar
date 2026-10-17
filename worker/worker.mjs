// 기회레이더 API 프록시 (Cloudflare Workers)
//
// 하는 일
//   1. 인증키를 서버에만 두고 공공 API를 대신 호출합니다 (브라우저에 키 노출 없음)
//   2. 출처별 응답을 공통 형식으로 바꿔 한 번에 돌려줍니다
//   3. 결과를 Cache API에 CACHE_SECONDS(기본 30분) 동안 보관해 호출 한도를 아낍니다
//   4. CORS 헤더를 붙여 정적 페이지(GitHub Pages 등)에서 바로 부를 수 있게 합니다
//
// 경로
//   GET /api/health                       어떤 출처의 인증키가 들어 있는지
//   GET /api/opportunities?q=&sources=    공고 목록 (q가 있으면 출처별 키워드 검색)

import { SOURCES, collectAll, hasKeys } from '../collector/sources.mjs';

function corsHeaders(request, env) {
  const allowed = String(env.ALLOW_ORIGIN ?? '*').split(',').map(s => s.trim()).filter(Boolean);
  const origin = request.headers.get('origin') ?? '';
  const allow = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0] ?? '';
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function json(body, headers, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers, ...extra },
  });
}

async function loadContests(env) {
  if (!env.CONTESTS_URL) return [];
  try {
    const r = await fetch(env.CONTESTS_URL, { cf: { cacheTtl: 3600 } });
    const list = await r.json();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ error: 'GET만 지원합니다' }, cors, 405);

    if (url.pathname === '/api/health') {
      return json({ ok: true, sources: Object.fromEntries(SOURCES.map(s => [s.id, hasKeys(s, env)])) }, cors);
    }

    if (url.pathname === '/api/opportunities') {
      const q = (url.searchParams.get('q') ?? '').trim().slice(0, 40);
      const only = (url.searchParams.get('sources') ?? '').split(',').map(s => s.trim()).filter(Boolean).sort();
      const ttl = Number(env.CACHE_SECONDS) || 1800;
      const cacheKey = new Request(`https://cache.opportunity-radar/v1?q=${encodeURIComponent(q)}&sources=${only.join(',')}`);
      const cache = caches.default;

      const hit = await cache.match(cacheKey);
      if (hit) return json(await hit.json(), cors, 200, { 'x-cache': 'HIT' });

      // 워커는 요청당 시간과 하위 요청 수가 제한돼 있어 페이지 수를 줄여 부릅니다
      const payload = await collectAll(env, {
        q, only, maxPages: q ? 2 : Number(env.MAX_PAGES) || 4, contests: await loadContests(env),
      });
      const res = json(payload, {}, 200, { 'cache-control': `public, max-age=${ttl}` });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return json(payload, cors, 200, { 'x-cache': 'MISS', 'cache-control': `public, max-age=${Math.min(ttl, 300)}` });
    }

    return json({ error: '없는 경로입니다', paths: ['/api/health', '/api/opportunities'] }, cors, 404);
  },
};
