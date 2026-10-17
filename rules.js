// 기회레이더 공용 규칙: 유형·대상·분야·지역·상태 분류와 '내 조건' 맞춤도 판정.
// 브라우저에서는 <script src="rules.js">로 읽어 window.RadarRules로, Node에서는 require로 씁니다.
// 화면(index.html)과 알림(collector/notify.mjs)이 같은 판정을 내리도록 한곳에 둡니다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RadarRules = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SOURCES = {
    bizinfo:  { label: '기업마당',  owner: '중소벤처기업부',               home: 'https://www.bizinfo.go.kr',                 keyUrl: 'https://www.bizinfo.go.kr/apiList.do' },
    kstartup: { label: 'K-Startup', owner: '창업진흥원',                   home: 'https://www.k-startup.go.kr',              keyUrl: 'https://www.data.go.kr/data/15125364/openapi.do' },
    youth:    { label: '온통청년',  owner: '한국고용정보원',               home: 'https://www.youthcenter.go.kr',            keyUrl: 'https://www.youthcenter.go.kr/' },
    gov24:    { label: '보조금24',  owner: '행정안전부',                   home: 'https://www.gov.kr/portal/rcvfvrSvc/main', keyUrl: 'https://www.data.go.kr/data/15113968/openapi.do' },
    g2b:      { label: '나라장터',  owner: '조달청',                       home: 'https://www.g2b.go.kr',                    keyUrl: 'https://www.data.go.kr/data/15129394/openapi.do' },
    contest:  { label: '직접 등록', owner: '운영자가 관리하는 공모전 목록', home: '',                                         keyUrl: '' },
  };
  const BASE_TYPE = { bizinfo: '지원사업', kstartup: '창업', youth: '청년정책', gov24: '공공서비스', g2b: '공공입찰', contest: '공모전' };
  const TYPES = ['지원사업', '창업', '청년정책', '공공서비스', '공공입찰', '공모전'];
  const CONTEST_RE = /공모전|경진대회|해커톤|챌린지|콘테스트|아이디어\s?공모|어워드|경연/;

  const FIELD_RULES = [
    ['자금·금융',   /금융|융자|보증|자금|대출|투자|지원금|장려금|보조금/],
    ['기술·R&D',    /기술|R&D|연구|개발|특허|디지털|스마트|AI|인공지능|데이터|SW|소프트웨어/i],
    ['인력·일자리', /인력|일자리|고용|채용|취업|인턴|일경험|구직|면접/],
    ['수출·판로',   /수출|해외|글로벌|판로|마케팅|내수|유통|전시회|박람회|커머스/],
    ['창업',        /창업|스타트업|사업화|액셀러|엑셀러/],
    ['경영·컨설팅', /경영|컨설팅|진단|멘토링|ESG/],
    ['주거·생활',   /주거|주택|월세|전세|임대|생활안정|에너지/],
    ['복지·건강',   /복지|건강|의료|돌봄|출산|육아|보육|심리|마음/],
    ['문화·홍보',   /문화|예술|콘텐츠|관광|체육|디자인|영상|홍보|슬로건|브랜드/],
    ['환경',        /환경|탄소|기후|에너지 ?전환|ESG/],
  ];
  const FIELDS = [...FIELD_RULES.map(([f]) => f), '용역·입찰', '기타'];

  const TARGET_RULES = [
    ['누구나',     /국민|누구나|일반인|시민|도민|구민|제한 ?없음|개인/],
    ['청년',       /청년|만 ?(1[5-9]|3[0-9])\s?~|만 ?(34|39)세/],
    ['학생',       /대학|학생|재학|청소년/],
    ['예비창업자', /예비 ?창업/],
    ['창업기업',   /창업 ?기업|초기 ?창업|창업 ?\d+ ?년|업력|스타트업|벤처|\d+ ?년 ?(미만|이내)/],
    ['중소기업',   /중소|중견|소기업|제조|일반기업|(?<!창업\s?)기업(?!가)|업체/],
    ['소상공인',   /소상공인|자영업|전통시장|상인/],
    ['기관·단체',  /기관|단체|협회|조합|비영리|지자체/],
  ];
  const TARGETS = TARGET_RULES.map(([t]) => t);
  // '청년을 채용한 기업'처럼 사람이 아니라 고용주가 신청하는 공고
  const EMPLOYER_RE = /(채용|고용)(한|하는|하려는|할)|참여\s?기업|사업주/;

  const REGION_RULES = [
    ['서울', /서울/], ['부산', /부산/], ['대구', /대구/], ['인천', /인천/], ['광주', /광주/], ['대전', /대전/],
    ['울산', /울산/], ['세종', /세종/], ['경기', /경기/], ['강원', /강원/], ['충북', /충북|충청북/], ['충남', /충남|충청남/],
    ['전북', /전북|전라북/], ['전남', /전남|전라남/], ['경북', /경북|경상북/], ['경남', /경남|경상남/], ['제주', /제주/],
  ];
  const REGIONS = REGION_RULES.map(([r]) => r);

  /* ───────── 날짜 ('YYYY-MM-DD' 문자열끼리 계산해 시간대 영향을 없앱니다) ───────── */
  const DAY = 86400000;
  const pad = n => String(n).padStart(2, '0');
  const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const utc = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; };
  function diffDays(s, today) {
    const a = utc(s), b = utc(today);
    return a == null || b == null ? null : Math.round((a - b) / DAY);
  }
  /** 한국 시간 기준 오늘 (서버·CI에서 사용) */
  const todayKST = (now = Date.now()) => new Date(now + 9 * 3600e3).toISOString().slice(0, 10);

  /* ───────── 자격 정보: 나이 · 업력 · 예비창업자 여부 ───────── */
  function ageText(it) {
    if (it.ageMin != null && it.ageMax != null) return `만 ${it.ageMin}~${it.ageMax}세`;
    if (it.ageMax != null) return `만 ${it.ageMax}세 이하`;
    if (it.ageMin != null) return `만 ${it.ageMin}세 이상`;
    return '';
  }
  function yearsText(it) {
    if (it.bizYearsMin != null && it.bizYearsMax != null) return `업력 ${it.bizYearsMin}~${it.bizYearsMax}년`;
    if (it.bizYearsMax != null) return `업력 ${it.bizYearsMax}년 이내`;
    if (it.bizYearsMin != null) return `업력 ${it.bizYearsMin}년 이상`;
    return '';
  }

  /** 출처가 구조화된 값을 주면 그대로 쓰고, 없으면 대상 원문과 제목에서 읽습니다 */
  function eligibility(it) {
    const text = `${it.target || ''} ${it.title || ''}`;
    let ageMin = it.ageMin ?? null, ageMax = it.ageMax ?? null;
    let bizYearsMin = it.bizYearsMin ?? null, bizYearsMax = it.bizYearsMax ?? null;
    let prestartup = it.prestartup ?? null;
    let m;
    if (ageMin == null && ageMax == null) {
      if ((m = /만\s?(\d{1,2})\s?세?\s?(?:이상)?\s?[~∼～-]\s?(?:만\s?)?(\d{1,2})\s?세/.exec(text))) {
        ageMin = +m[1]; ageMax = +m[2];
      } else {
        if ((m = /만\s?(\d{1,2})\s?세\s?(이하|미만)/.exec(text))) ageMax = m[2] === '미만' ? +m[1] - 1 : +m[1];
        if ((m = /만\s?(\d{1,2})\s?세\s?(이상|초과)/.exec(text))) ageMin = m[2] === '초과' ? +m[1] + 1 : +m[1];
      }
    }
    if (bizYearsMin == null && bizYearsMax == null) {
      if ((m = /(\d{1,2})\s?년\s?(이상|초과)\s?(?:~|부터|에서)?\s?(\d{1,2})\s?년\s?(이내|이하|미만)/.exec(text))) {
        bizYearsMin = m[2] === '초과' ? +m[1] + 1 : +m[1];
        bizYearsMax = m[4] === '미만' ? +m[3] - 1 : +m[3];
      } else {
        if ((m = /(?:창업|업력|설립|개업)[^\d\n]{0,8}(\d{1,2})\s?년\s?(이내|이하|미만)/.exec(text))) bizYearsMax = m[2] === '미만' ? +m[1] - 1 : +m[1];
        if ((m = /(?:창업|업력|설립|개업)[^\d\n]{0,8}(\d{1,2})\s?년\s?(이상|초과)/.exec(text))) bizYearsMin = m[2] === '초과' ? +m[1] + 1 : +m[1];
      }
    }
    if (prestartup == null) {
      const others = ['창업기업', '중소기업', '소상공인', '기관·단체', '누구나'];
      if (/사업자\s?등록(이)?\s?없는|사업자\s?미등록/.test(text) ||
          (it.targets.includes('예비창업자') && !it.targets.some(t => others.includes(t)))) prestartup = 'only';
      else if (it.targets.includes('예비창업자')) prestartup = 'yes';
    }
    return { ageMin, ageMax, bizYearsMin, bizYearsMax, prestartup };
  }

  /* ───────── 공통 형식 → 화면·알림용 파생 정보 ───────── */
  function enrich(raw, today) {
    const it = { ...raw };
    it.tags = Array.isArray(it.tags) ? it.tags : String(it.tags || '').split(/[,#\s]+/).filter(Boolean);
    const tagText = it.tags.join(' ');
    const hay = `${it.title} ${it.category || ''} ${tagText}`;

    it.types = [BASE_TYPE[it.source] || '지원사업'];
    if (it.source === 'bizinfo' && /창업/.test(it.category || '')) it.types.push('창업');
    if (CONTEST_RE.test(it.title) && !it.types.includes('공모전')) it.types.push('공모전');

    it.fields = FIELD_RULES.filter(([, re]) => re.test(hay)).map(([n]) => n).slice(0, 3);
    if (it.source === 'g2b') it.fields = ['용역·입찰', ...it.fields].slice(0, 3);
    if (!it.fields.length) it.fields = ['기타'];

    const targetHay = `${it.target || ''} ${it.title}`;
    let targets = TARGET_RULES.filter(([, re]) => re.test(targetHay)).map(([n]) => n);
    if (EMPLOYER_RE.test(targetHay)) targets = targets.filter(t => !['청년', '학생', '누구나'].includes(t));
    it.targets = targets;

    const regionHay = `${it.region || ''} ${it.title} ${it.org || ''} ${tagText}`;
    it.regions = REGION_RULES.filter(([, re]) => re.test(regionHay)).map(([n]) => n);
    if (!it.regions.length || /전국/.test(it.region || '')) it.regions.unshift('전국');

    Object.assign(it, eligibility(it));

    const sd = diffDays(it.start, today), ed = diffDays(it.end, today);
    const always = it.always ?? /상시|수시|소진|연중|선착순/.test(it.periodText || '');
    it.dleft = ed;
    if (ed == null) it.status = sd != null && sd > 0 ? 'upcoming' : always ? 'always' : 'unknown';
    else if (ed < 0) it.status = 'closed';
    else if (sd != null && sd > 0) it.status = 'upcoming';
    else if (ed <= 7) it.status = 'soon';
    else it.status = 'open';
    it.visual = it.status === 'soon' && ed <= 2 ? 'urgent' : it.status;

    it.search = [it.title, it.org, it.category, it.target, it.region, it.summary, tagText, SOURCES[it.source]?.label, it.types.join(' ')]
      .join(' ').toLowerCase();
    return it;
  }

  /* ───────── 내 조건 맞춤도 ─────────
     profile = { kinds: ['예비창업자'], age: 29, bizYears: 2, region: '부산', interests: ['창업'] }
     결과    = { level: 'high' | 'mid' | 'low', score, checks: [{ key, state: 'ok'|'check'|'no', text }] } */
  const KINDS = ['개인', '학생', '예비창업자', '창업기업', '중소기업', '소상공인', '기관·단체'];
  const KIND_ACCEPT = {
    '개인':       ['누구나', '청년'],
    '학생':       ['학생', '청년', '누구나'],
    '예비창업자': ['예비창업자', '누구나', '청년'],
    '창업기업':   ['창업기업', '중소기업', '누구나'],
    '중소기업':   ['중소기업', '누구나'],
    '소상공인':   ['소상공인', '중소기업', '누구나'],
    '기관·단체':  ['기관·단체', '누구나'],
  };
  const BUSINESS_KINDS = ['창업기업', '중소기업', '소상공인'];
  const MATCH_LABEL = { high: '조건 맞음', mid: '확인 필요', low: '해당 어려움' };
  const blank = v => v == null || v === '';

  function hasProfile(p) {
    return !!p && !!((p.kinds && p.kinds.length) || !blank(p.age) || p.region || !blank(p.bizYears) || (p.interests && p.interests.length));
  }

  function matchProfile(it, p) {
    if (!hasProfile(p)) return null;
    const checks = [];
    const kinds = p.kinds || [];
    const isPre = kinds.includes('예비창업자');
    const isBiz = kinds.some(k => BUSINESS_KINDS.includes(k));

    if (kinds.length) {
      if (!it.targets.length) checks.push({ key: '대상', state: 'check', text: '지원 대상을 원문에서 확인하세요' });
      else {
        const ok = kinds.some(k => (KIND_ACCEPT[k] || [k]).some(t => it.targets.includes(t)));
        checks.push({ key: '대상', state: ok ? 'ok' : 'no', text: `${it.targets.join(', ')} 대상` });
      }
    }

    if (!blank(p.age)) {
      const age = Number(p.age);
      if (it.ageMin != null || it.ageMax != null) {
        const ok = (it.ageMin == null || age >= it.ageMin) && (it.ageMax == null || age <= it.ageMax);
        checks.push({ key: '나이', state: ok ? 'ok' : 'no', text: ageText(it) });
      } else if (it.source === 'youth' || (it.targets.includes('청년') && it.targets.every(t => ['청년', '학생', '누구나'].includes(t)))) {
        // 연령이 적혀 있지 않은 청년 정책: 보통 만 19~34세, 지자체는 39세나 45세까지 넓히기도 합니다
        const state = age >= 19 && age <= 34 ? 'ok' : age >= 15 && age <= 45 ? 'check' : 'no';
        checks.push({ key: '나이', state, text: '청년 대상 (연령 기준은 원문 확인)' });
      }
    }

    if (p.region) {
      const local = it.regions.includes(p.region);
      const ok = local || it.regions.includes('전국');
      checks.push({ key: '지역', state: ok ? 'ok' : 'no', text: ok ? (local ? `${p.region} 대상` : '전국 대상') : `${it.regions.join(', ')} 대상` });
    }

    if (it.prestartup === 'only' && (isPre || isBiz)) {
      checks.push({ key: '업력', state: isPre ? 'ok' : 'no', text: '예비창업자 (사업자 등록 전) 대상' });
    } else if (it.bizYearsMin != null || it.bizYearsMax != null || it.prestartup === 'no') {
      const label = yearsText(it) || '이미 창업한 기업 대상';
      if (isBiz && !blank(p.bizYears)) {
        const y = Number(p.bizYears);
        const ok = (it.bizYearsMin == null || y >= it.bizYearsMin) && (it.bizYearsMax == null || y <= it.bizYearsMax);
        checks.push({ key: '업력', state: ok ? 'ok' : 'no', text: label });
      } else if (isPre && !isBiz) {
        const state = it.bizYearsMin > 0 || it.prestartup === 'no' ? 'no' : it.prestartup === 'yes' ? 'ok' : 'check';
        checks.push({ key: '업력', state, text: it.prestartup === 'yes' ? `예비창업자 포함 · ${label}` : label });
      } else if (isBiz) {
        checks.push({ key: '업력', state: 'check', text: `${label} · 내 조건에 업력을 넣으면 판정합니다` });
      }
    }

    if (p.interests && p.interests.length) {
      const hit = it.fields.filter(f => p.interests.includes(f));
      if (hit.length) checks.push({ key: '관심 분야', state: 'ok', text: hit.join(', '), bonus: true });
    }

    const core = checks.filter(c => !c.bonus);
    const level = core.some(c => c.state === 'no') ? 'low' : core.length && core.every(c => c.state === 'ok') ? 'high' : 'mid';
    const score = { high: 3, mid: 2, low: 0 }[level] + (checks.some(c => c.bonus) ? 0.5 : 0);
    return { level, score, checks };
  }

  function profileSummary(p) {
    if (!hasProfile(p)) return '';
    const parts = [];
    if (p.kinds && p.kinds.length) parts.push(p.kinds.join('·'));
    if (!blank(p.age)) parts.push(`만 ${p.age}세`);
    if (!blank(p.bizYears)) parts.push(Number(p.bizYears) >= 10 ? '업력 10년 이상' : Number(p.bizYears) === 0 ? '업력 1년 미만' : `업력 ${p.bizYears}년`);
    if (p.region) parts.push(p.region);
    if (p.interests && p.interests.length) parts.push(`관심: ${p.interests.join(', ')}`);
    return parts.join(' · ');
  }

  return {
    SOURCES, BASE_TYPE, TYPES, CONTEST_RE, FIELD_RULES, FIELDS, TARGET_RULES, TARGETS, REGION_RULES, REGIONS,
    KINDS, MATCH_LABEL, DAY, isoOf, diffDays, todayKST, ageText, yearsText,
    eligibility, enrich, hasProfile, matchProfile, profileSummary,
  };
});
