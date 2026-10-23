// 공공 API 호출과 공통 형식 변환.
// collector(Node 18 이상)와 worker(Cloudflare Workers)가 같은 코드를 씁니다.
//
// 공통 형식 (화면이 기대하는 필드)
//   id, source, title, org, category, target, region,
//   start, end ('YYYY-MM-DD' 또는 null), endTime ('HH:MM'), periodText, always,
//   url, summary, amount (원), tags[], postedAt ('YYYY-MM-DD')
//   자격 정보 (출처가 구조화된 값을 줄 때만): ageMin, ageMax, bizYearsMin, bizYearsMax,
//   prestartup ('only' 예비창업자만 | 'yes' 예비창업자 포함 | 'no' 기창업자만)

const UA = 'opportunity-radar/0.1 (+https://github.com/woo2me01-ai/opportunity-radar)';

/* ───────── 작은 도구 ───────── */

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function todayKST(now = Date.now()) {
  return new Date(now + 9 * 3600e3).toISOString().slice(0, 10);
}

/** 'YYYYMMDDHHMM' (KST) */
export function stampKST(offsetDays = 0, endOfDay = false, now = Date.now()) {
  const d = new Date(now + 9 * 3600e3 + offsetDays * 86400e3);
  const p = n => String(n).padStart(2, '0');
  const hm = endOfDay ? '2359' : `${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${hm}`;
}

const ENTITIES = { nbsp: ' ', lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", middot: '·', '#39': "'" };

export function stripTags(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#?\w+);/g, (m, e) => {
      if (ENTITIES[e.toLowerCase()]) return ENTITIES[e.toLowerCase()];
      const code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : e[0] === '#' ? Number(e.slice(1)) : NaN;
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    })
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

export const clean = s => stripTags(s).replace(/\s+/g, ' ').trim();

export function truncate(s, n) {
  const t = clean(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function absUrl(u, base = '') {
  const s = String(u ?? '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return `https:${s}`;
  if (/^www\./i.test(s)) return `https://${s}`;
  if (s.startsWith('/') && base) return base + s;
  return '';
}

/** 배열, 단일 객체, {item: ...}, 빈 값 모두 배열로 */
export function pickList(x) {
  if (x == null || x === '') return [];
  if (Array.isArray(x)) return x;
  if (typeof x === 'object' && 'item' in x) return pickList(x.item);
  return typeof x === 'object' ? [x] : [];
}

const DATE_RE = /(\d{4})\s*[-./년]?\s*(\d{1,2})\s*[-./월]?\s*(\d{1,2})/g;

/** 문자열에서 날짜를 모두 찾아 'YYYY-MM-DD' 배열로 */
export function findDates(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(DATE_RE)) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    out.push(`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  return out;
}

export const toDate = s => findDates(s)[0] ?? null;

const ALWAYS_RE = /상시|수시|소진|연중|선착순/;

/**
 * 신청기간 원문 → {start, end, text, always}
 * 여러 기간이 섞여 있으면(온통청년의 '\N' 구분 등) 아직 끝나지 않은 첫 기간을 고릅니다.
 */
export function parsePeriod(text, today = todayKST()) {
  const raw = stripTags(String(text ?? '').replace(/\\N/g, '\n'));
  const ranges = raw.split(/\n|;/)
    .map(part => findDates(part))
    .filter(d => d.length)
    .map(d => ({ start: d.length > 1 ? d[0] : null, end: d[d.length - 1] }));
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (!ranges.length) return { start: null, end: null, text: flat, always: ALWAYS_RE.test(flat) };
  const pick = ranges.find(r => r.end >= today) ?? ranges[ranges.length - 1];
  return { ...pick, text: flat, always: false };
}

/** data.go.kr 키는 Encoding/Decoding 두 형태가 있어 한 번 풀어 둡니다 */
export function decodeKey(key) {
  const k = String(key ?? '').trim();
  try { return /%[0-9A-F]{2}/i.test(k) ? decodeURIComponent(k) : k; } catch { return k; }
}

const STATUS_HINT = {
  401: '인증키가 틀렸거나 아직 등록되지 않음',
  403: '이 API를 쓸 권한이 없음, 활용신청 승인 여부 확인',
  429: '호출 한도 초과',
};

/** 오류 응답 본문을 로그에 남길 만큼 줄이고, 인증키처럼 보이는 긴 문자열(숫자·소문자 섞인 32자 이상)은 가립니다 */
export function errorDetail(text) {
  return stripTags(text)
    .replace(/\s+/g, ' ')
    .replace(/[A-Za-z0-9+/=%_-]{32,}/g, t => (/\d/.test(t) && /[a-z]/.test(t) ? '***' : t))
    .trim()
    .slice(0, 160);
}

export async function getJSON(url, { timeoutMs = 25000, retries = 1, fetchImpl = globalThis.fetch } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(String(url), { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': UA } });
      const text = await res.text();
      if (!res.ok) {
        const hint = STATUS_HINT[res.status];
        const detail = errorDetail(text);
        const err = new Error(`HTTP ${res.status}${hint ? ` (${hint})` : ''}${detail ? `: ${detail}` : ''}`);
        err.final = res.status === 401 || res.status === 403; // 다시 불러도 같은 결과
        throw err;
      }
      try { return JSON.parse(text); }
      catch {
        const err = new Error(text.trim().startsWith('<')
          ? `JSON 대신 XML/HTML 응답 (인증키나 파라미터를 확인하세요): ${errorDetail(text)}`
          : 'JSON을 읽지 못했습니다');
        err.final = true;
        throw err;
      }
    } catch (e) {
      const err = e.name === 'AbortError' ? new Error('응답 시간 초과') : e;
      if (attempt >= retries || err.final) throw err;
      await sleep(1000 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
}

const withParams = (base, params) => {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, String(v));
  return u;
};

/* ───────── 지역 ───────── */

const REGION_TAG = /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주|전남광주)/;

function regionFromTags(tags) {
  const hits = tags.filter(t => REGION_TAG.test(t));
  if (!hits.length || hits.length >= 12) return '전국';
  return hits.join(',');
}

/* ───────── 1. 기업마당 지원사업정보 ───────── */

export function normalizeBizinfo(x, today) {
  const p = parsePeriod(x.reqstBeginEndDe, today);
  const tags = String(x.hashtags ?? x.hashTags ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const org = clean(x.jrsdInsttNm);
  const exec = clean(x.excInsttNm);
  return {
    id: `bizinfo:${x.pblancId}`,
    source: 'bizinfo',
    title: clean(x.pblancNm),
    org: exec && exec !== org ? `${org} · ${exec}` : org,
    category: clean(x.pldirSportRealmLclasCodeNm),
    target: clean(x.trgetNm),
    region: regionFromTags(tags),
    start: p.start, end: p.end, periodText: p.text, always: p.always,
    url: absUrl(x.pblancUrl, 'https://www.bizinfo.go.kr') ||
      `https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=${encodeURIComponent(x.pblancId ?? '')}`,
    summary: truncate(x.bsnsSumryCn, 400),
    amount: null,
    tags: tags.filter(t => !REGION_TAG.test(t) && !/^\d{4}$/.test(t)).slice(0, 8),
    postedAt: toDate(x.creatPnttm),
  };
}

async function fetchBizinfo(env, opts) {
  const url = withParams('https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do', {
    crtfcKey: env.BIZINFO_API_KEY, dataType: 'json', searchCnt: 0, pageUnit: opts.bizinfoLimit ?? 1500, pageIndex: 1,
  });
  const j = await getJSON(url, opts);
  if (j?.reqErr) throw new Error(j.reqErr);
  const list = Array.isArray(j?.jsonArray) ? j.jsonArray : pickList(j?.jsonArray ?? j?.item);
  // 기업마당은 검색어 파라미터가 없어 받은 뒤 거릅니다
  const q = opts.q?.toLowerCase();
  return list.map(x => normalizeBizinfo(x, opts.today))
    .filter(it => !q || `${it.title} ${it.summary} ${it.tags.join(' ')}`.toLowerCase().includes(q));
}

/* ───────── 2. K-Startup 사업공고 ───────── */

/**
 * 창업업력 구간 '예비창업자,1년미만,2년미만,3년미만,5년미만,7년미만,10년미만' →
 * { prestartup: 'only'|'yes'|'no'|null, bizYearsMin, bizYearsMax } (업력은 만 햇수, 양 끝 포함)
 */
export function parseEnyy(s) {
  const parts = String(s ?? '').split(',').map(t => t.replace(/\s/g, '')).filter(Boolean);
  if (!parts.length) return {};
  const TH = [1, 2, 3, 5, 7, 10];
  let min = null, max = null, open = false;
  for (const t of parts) {
    let m;
    if ((m = /^(\d+)년미만$/.exec(t))) {
      const n = +m[1];
      const lo = Math.max(0, ...TH.filter(x => x < n));
      min = min == null ? lo : Math.min(min, lo);
      max = max == null ? n - 1 : Math.max(max, n - 1);
    } else if ((m = /^(\d+)년이상$/.exec(t))) {
      const n = +m[1];
      min = min == null ? n : Math.min(min, n);
      open = true;
    }
  }
  if (open) max = null;
  const pre = parts.includes('예비창업자');
  return {
    prestartup: pre ? (min == null ? 'only' : 'yes') : min != null ? 'no' : null,
    bizYearsMin: min ? min : null,
    bizYearsMax: max,
  };
}

/** 연령 구간 '만 20세 미만,만 20세 이상 ~ 만 39세 이하,만 40세 이상' → 합집합 { ageMin, ageMax } */
export function parseAgeBuckets(s) {
  const parts = String(s ?? '').split(',').map(t => t.trim()).filter(Boolean);
  if (!parts.length) return {};
  let min = Infinity, max = -Infinity;
  for (const t of parts) {
    let lo = 0, hi = 200;
    for (const [, n, op] of t.matchAll(/(\d{1,3})\s?세\s?(이상|이하|미만|초과)?/g)) {
      const v = +n;
      if (op === '이상') lo = v; else if (op === '초과') lo = v + 1;
      else if (op === '이하') hi = v; else if (op === '미만') hi = v - 1;
    }
    min = Math.min(min, lo);
    max = Math.max(max, hi);
  }
  return { ageMin: min > 0 ? min : null, ageMax: max < 200 ? max : null };
}

export function normalizeKstartup(x) {
  const start = toDate(x.pbanc_rcpt_bgng_dt);
  const end = toDate(x.pbanc_rcpt_end_dt);
  const sn = x.pbanc_sn ?? '';
  return {
    id: `kstartup:${sn}`,
    source: 'kstartup',
    title: clean(x.biz_pbanc_nm || x.intg_pbanc_biz_nm),
    org: clean(x.pbanc_ntrp_nm || x.sprv_inst || x.biz_prch_dprt_nm),
    category: clean(x.supt_biz_clsfc),
    target: truncate([x.aply_trgt, x.biz_enyy, x.biz_trgt_age].filter(Boolean).join(' / ') || x.aply_trgt_ctnt, 200),
    region: clean(x.supt_regin) || '전국',
    start, end,
    periodText: start || end ? `${start ?? ''} ~ ${end ?? ''}` : '',
    always: false,
    url: absUrl(x.detl_pg_url, 'https://www.k-startup.go.kr') ||
      `https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=${encodeURIComponent(sn)}`,
    summary: truncate(x.pbanc_ctnt || x.aply_trgt_ctnt, 400),
    amount: null,
    tags: [x.supt_biz_clsfc, x.biz_enyy].filter(Boolean).flatMap(s => String(s).split(',')).map(s => s.trim()).filter(Boolean).slice(0, 8),
    postedAt: null,
    ...parseEnyy(x.biz_enyy),
    ...parseAgeBuckets(x.biz_trgt_age),
  };
}

async function fetchKstartup(env, opts) {
  const out = [];
  const perPage = 500;
  for (let page = 1; page <= (opts.maxPages ?? 4); page++) {
    const url = withParams('https://apis.data.go.kr/B552735/kisedKstartupService01/getAnnouncementInformation01', {
      serviceKey: decodeKey(env.DATA_GO_KR_API_KEY), page, perPage, returnType: 'json',
      'cond[rcrt_prgs_yn::EQ]': 'Y',
      'cond[biz_pbanc_nm::LIKE]': opts.q,
    });
    const j = await getJSON(url, opts);
    if (!Array.isArray(j?.data)) throw new Error(j?.msg || j?.errMsg || dataGoKrError(j) || '응답 형식이 예상과 다릅니다');
    out.push(...j.data.map(normalizeKstartup));
    const total = Number(j.matchCount ?? j.totalCount ?? 0);
    if (j.data.length < perPage || out.length >= total) break;
  }
  return out;
}

/* ───────── 3. 온통청년 청년정책 ───────── */

const YOUTH_DETAIL = 'https://www.youthcenter.go.kr/youthPolicy/ythPlcyTotalSearch/ythPlcyDetail/';

export function normalizeYouth(x, today) {
  const p = parsePeriod(x.aplyYmd, today);
  const code = String(x.aplyPrdSeCd ?? '');
  const always = p.always || (!p.end && code === '0057002');
  const min = Number(x.sprtTrgtMinAge) || 0;
  const max = Number(x.sprtTrgtMaxAge) || 0;
  const age = min || max ? `만 ${min || ''}~${max || ''}세` : '';
  const cats = [...new Set([x.lclsfNm, x.mclsfNm].flatMap(s => String(s ?? '').split(',')).map(s => s.trim()).filter(Boolean))];
  return {
    id: `youth:${x.plcyNo}`,
    source: 'youth',
    title: clean(x.plcyNm),
    org: clean(x.sprvsnInstCdNm || x.operInstCdNm),
    category: cats.join(' > '),
    target: truncate(['청년', age, x.addAplyQlfcCndCn].filter(Boolean).join(' · '), 200),
    region: clean(x.rgtrHghrkInstCdNm),
    start: p.start, end: p.end,
    periodText: p.text || (always ? '상시' : code === '0057003' ? '마감 또는 기타 (원문 확인)' : ''),
    always,
    url: x.plcyNo ? YOUTH_DETAIL + encodeURIComponent(x.plcyNo) : absUrl(x.aplyUrlAddr || x.refUrlAddr1),
    summary: truncate(x.plcyExplnCn || x.plcySprtCn, 400),
    amount: null,
    tags: String(x.plcyKywdNm ?? '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 8),
    postedAt: toDate(x.frstRegDt),
    ageMin: min || null,
    ageMax: max || null,
  };
}

async function fetchYouth(env, opts) {
  const out = [];
  const pageSize = 500;
  for (let pageNum = 1; pageNum <= (opts.maxPages ?? 6); pageNum++) {
    if (pageNum > 1) await sleep(1100); // 연속 호출하면 403이 나는 경우가 있어 간격을 둡니다
    const url = withParams('https://www.youthcenter.go.kr/go/ythip/getPlcy', {
      apiKeyNm: env.YOUTH_API_KEY, pageNum, pageSize, rtnType: 'json', pageType: 1, plcyNm: opts.q,
    });
    const j = await getJSON(url, opts);
    if (Number(j?.resultCode) !== 200) throw new Error(j?.resultMessage || '응답 형식이 예상과 다릅니다');
    const list = pickList(j?.result?.youthPolicyList);
    out.push(...list.map(x => normalizeYouth(x, opts.today)));
    const total = Number(j?.result?.pagging?.totCount ?? 0);
    if (list.length < pageSize || out.length >= total) break;
  }
  // 이미 끝난 정책은 뺍니다
  return out.filter(it => !it.end || it.end >= opts.today);
}

/* ───────── 4. 보조금24 (대한민국 공공서비스 정보) ───────── */

export function normalizeGov24(x, today) {
  const p = parsePeriod(x['신청기한'], today);
  const id = x['서비스ID'] ?? '';
  return {
    id: `gov24:${id}`,
    source: 'gov24',
    title: clean(x['서비스명']),
    org: clean(x['소관기관명']),
    category: clean(x['서비스분야']),
    target: truncate(x['지원대상'], 200),
    region: clean(x['소관기관명']),
    start: p.start, end: p.end, periodText: p.text, always: p.always,
    url: absUrl(x['상세조회URL']) || `https://www.gov.kr/portal/rcvfvrSvc/dtlEx/${encodeURIComponent(id)}`,
    summary: truncate(x['서비스목적요약'] || x['지원내용'], 400),
    amount: null,
    tags: [...String(x['사용자구분'] ?? '').split('||'), x['지원유형']].map(s => clean(s)).filter(Boolean).slice(0, 6),
    postedAt: toDate(x['등록일시']),
  };
}

async function fetchGov24(env, opts) {
  const out = [];
  const perPage = 500;
  for (let page = 1; page <= (opts.maxPages ?? 30); page++) {
    const url = withParams('https://api.odcloud.kr/api/gov24/v3/serviceList', {
      serviceKey: decodeKey(env.DATA_GO_KR_API_KEY), page, perPage, returnType: 'JSON',
      'cond[서비스명::LIKE]': opts.q,
    });
    const j = await getJSON(url, opts);
    if (!Array.isArray(j?.data)) throw new Error(j?.msg || '응답 형식이 예상과 다릅니다');
    out.push(...j.data.map(x => normalizeGov24(x, opts.today)));
    const total = Number(j.matchCount ?? j.totalCount ?? 0);
    if (j.data.length < perPage || out.length >= total) break;
  }
  // 1만 건이 넘고 대부분 '상시신청'이라, 검색어가 없으면 기한이 있는 서비스만 남깁니다.
  // 상시 서비스까지 모두 받으려면 GOV24_INCLUDE_ALWAYS=true
  if (opts.q || String(env.GOV24_INCLUDE_ALWAYS) === 'true') return out;
  return out.filter(it => it.end && it.end >= opts.today);
}

/* ───────── 5. 나라장터 입찰공고 (용역) ───────── */

const G2B_BASE = 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService';

export function normalizeG2b(x) {
  const amount = Number(x.asignBdgtAmt || x.presmptPrce) || null;
  const region = clean(x.prtcptLmtRgnNm);
  return {
    id: `g2b:${x.bidNtceNo}-${x.bidNtceOrd || '000'}`,
    source: 'g2b',
    title: clean(x.bidNtceNm),
    org: clean(x.dminsttNm || x.ntceInsttNm),
    category: ['용역', clean(x.srvceDivNm)].filter(Boolean).join(' · '),
    target: [clean(x.cntrctCnclsMthdNm), region ? `${region} 소재 업체` : '입찰참가자격 등록 업체'].filter(Boolean).join(' · '),
    region: region || '전국',
    start: toDate(x.bidBeginDt || x.bidNtceDt),
    end: toDate(x.bidClseDt),
    endTime: (String(x.bidClseDt ?? '').match(/\b(\d{2}:\d{2})/) || [])[1] ?? null,
    periodText: [x.bidNtceDt, x.bidClseDt].filter(Boolean).join(' ~ '),
    always: false,
    url: absUrl(x.bidNtceDtlUrl || x.bidNtceUrl) || 'https://www.g2b.go.kr',
    summary: [clean(x.ntceKindNm), clean(x.cntrctCnclsMthdNm), x.opengDt ? `개찰 ${x.opengDt}` : ''].filter(Boolean).join(' · '),
    amount,
    tags: [x.pubPrcrmntLrgClsfcNm, x.pubPrcrmntMidClsfcNm].map(s => clean(s)).filter(Boolean),
    postedAt: toDate(x.bidNtceDt || x.rgstDt),
  };
}

function dataGoKrError(j) {
  const h = j?.OpenAPI_ServiceResponse?.cmmMsgHeader;
  return h ? (h.returnAuthMsg || h.errMsg || '인증 오류') : '';
}

async function g2bQuery(env, opts, op, extra) {
  const out = [];
  for (let pageNo = 1; pageNo <= (opts.maxPages ?? 3); pageNo++) {
    const url = withParams(G2B_BASE + op, {
      serviceKey: decodeKey(env.DATA_GO_KR_API_KEY), pageNo, numOfRows: 999, type: 'json', ...extra,
    });
    const j = await getJSON(url, opts);
    const err = dataGoKrError(j);
    if (err) throw new Error(err);
    const head = j?.response?.header;
    if (head && head.resultCode !== '00') throw new Error(head.resultMsg || `오류 코드 ${head.resultCode}`);
    const body = j?.response?.body ?? {};
    const list = pickList(body.items);
    out.push(...list.map(normalizeG2b));
    if (list.length < 999 || out.length >= Number(body.totalCount ?? 0)) break;
  }
  return out;
}

async function fetchG2b(env, opts) {
  const days = Number(env.G2B_DAYS) || 3;
  const range = { inqryDiv: 1, inqryBgnDt: stampKST(-days), inqryEndDt: stampKST(0, true) };
  const keywords = opts.q ? [opts.q]
    : String(env.G2B_KEYWORDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  let items;
  if (keywords.length) {
    // 키워드 검색은 PPSSrch 오퍼레이션에서만 됩니다 (최대 조회 기간은 약 1개월)
    const kwRange = { ...range, inqryBgnDt: stampKST(-Math.max(days, 14)) };
    items = [];
    // 키워드마다 호출이 늘어나므로 키워드당 2쪽(최대 1,998건)까지만 봅니다
    const kwOpts = { ...opts, maxPages: Math.min(opts.maxPages ?? 2, 2) };
    for (const kw of keywords.slice(0, 10)) {
      items.push(...await g2bQuery(env, kwOpts, '/getBidPblancListInfoServcPPSSrch', { ...kwRange, bidNtceNm: kw, bidClseExcpYn: 'Y' }));
    }
  } else {
    items = await g2bQuery(env, opts, '/getBidPblancListInfoServc', range);
  }
  return items.filter(it => !it.end || it.end >= opts.today);
}

/* ───────── 출처 목록 ───────── */

export const SOURCES = [
  { id: 'bizinfo',  label: '기업마당',  keys: ['BIZINFO_API_KEY'],    run: fetchBizinfo },
  { id: 'kstartup', label: 'K-Startup', keys: ['DATA_GO_KR_API_KEY'], run: fetchKstartup },
  { id: 'youth',    label: '온통청년',  keys: ['YOUTH_API_KEY'],      run: fetchYouth },
  { id: 'gov24',    label: '보조금24',  keys: ['DATA_GO_KR_API_KEY'], run: fetchGov24 },
  { id: 'g2b',      label: '나라장터',  keys: ['DATA_GO_KR_API_KEY'], run: fetchG2b },
];

export const hasKeys = (src, env) => src.keys.every(k => String(env?.[k] ?? '').trim());

/* ───────── 중복 제거와 합치기 ───────── */

const titleKey = s => String(s).replace(/\[[^\]]*\]|\([^)]*\)|[\s·,.\-_'"「」『』<>]/g, '').toLowerCase();
const PRIORITY = ['kstartup', 'bizinfo', 'youth', 'gov24', 'g2b', 'contest'];

/** 같은 공고가 기업마당과 K-Startup 양쪽에 오는 경우가 많아 제목+마감일로 합칩니다 */
export function dedupe(items) {
  const byKey = new Map();
  const sorted = [...items].sort((a, b) => PRIORITY.indexOf(a.source) - PRIORITY.indexOf(b.source));
  for (const it of sorted) {
    const key = `${titleKey(it.title)}|${it.end ?? ''}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, { ...it, alsoIn: [] }); continue; }
    // 같은 출처 안에서 제목·마감일이 같은 공고는 기관만 다른 별개 공고일 수 있어 합치지 않습니다
    if (prev.source === it.source) { byKey.set(`${key}|${it.id}`, { ...it, alsoIn: [] }); continue; }
    if (!prev.alsoIn.includes(it.source)) prev.alsoIn.push(it.source);
  }
  return [...byKey.values()];
}

/**
 * 모든 출처를 병렬로 부르고 하나의 결과로 합칩니다.
 * opts: { q, only: ['bizinfo', ...], maxPages, contests: [...], fetchImpl, now }
 */
export async function collectAll(env, opts = {}) {
  const today = todayKST(opts.now);
  const wanted = SOURCES.filter(s => !opts.only?.length || opts.only.includes(s.id));
  const sources = {};
  const results = await Promise.all(wanted.map(async src => {
    if (!hasKeys(src, env)) {
      sources[src.id] = { ok: false, skipped: true, error: '인증키 없음', count: 0 };
      return [];
    }
    const t0 = Date.now();
    try {
      const items = (await src.run(env, { ...opts, today })).filter(it => it.title);
      sources[src.id] = { ok: true, count: items.length, ms: Date.now() - t0 };
      return items;
    } catch (e) {
      sources[src.id] = { ok: false, error: String(e.message || e).slice(0, 240), count: 0, ms: Date.now() - t0 };
      return [];
    }
  }));

  const contests = (opts.contests ?? [])
    .filter(c => c && c.title)
    .map((c, i) => ({ source: 'contest', id: `contest:${c.id ?? i}`, tags: [], always: false, ...c }))
    .filter(c => !c.end || c.end >= today)
    .filter(c => !opts.q || `${c.title} ${c.summary ?? ''}`.toLowerCase().includes(opts.q.toLowerCase()));
  if (contests.length) sources.contest = { ok: true, count: contests.length };

  const items = dedupe([...results.flat(), ...contests]);
  return { generatedAt: new Date(opts.now ?? Date.now()).toISOString(), today, query: opts.q || null, sources, count: items.length, items };
}
