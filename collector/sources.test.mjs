// node --test collector/sources.test.mjs
// 실제 API를 부르지 않고, 공개된 응답 예시와 같은 모양의 고정 데이터로 변환 규칙을 확인합니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findDates, parsePeriod, stripTags, absUrl, pickList, decodeKey, dedupe, collectAll, parseEnyy, parseAgeBuckets,
  normalizeBizinfo, normalizeKstartup, normalizeYouth, normalizeGov24, normalizeG2b,
} from './sources.mjs';

const TODAY = '2026-10-17';
const NOW = Date.parse('2026-10-17T03:00:00Z'); // KST 12:00

test('날짜 형식을 가리지 않고 찾는다', () => {
  assert.deepEqual(findDates('2026-08-03 ~ 2026-08-18'), ['2026-08-03', '2026-08-18']);
  assert.deepEqual(findDates('20220727 ~ 20220930'), ['2022-07-27', '2022-09-30']);
  assert.deepEqual(findDates('2026. 6. 15.(월) ~ 2026. 7. 1.(수)'), ['2026-06-15', '2026-07-01']);
  assert.deepEqual(findDates('20201217142613'), ['2020-12-17']);
  assert.deepEqual(findDates('문의 02-1234-5678'), []);
});

test('신청기간 원문을 시작·마감으로 나눈다', () => {
  assert.deepEqual(parsePeriod('2026-10-01 ~ 2026-10-31', TODAY), { start: '2026-10-01', end: '2026-10-31', text: '2026-10-01 ~ 2026-10-31', always: false });
  const always = parsePeriod('예산 소진시까지', TODAY);
  assert.equal(always.end, null);
  assert.equal(always.always, true);
  // 온통청년: 여러 기간이 '\N'으로 이어진 경우 아직 안 끝난 기간을 고른다
  const multi = parsePeriod('20260101 ~ 20260131\\N20261001 ~ 20261031', TODAY);
  assert.equal(multi.start, '2026-10-01');
  assert.equal(multi.end, '2026-10-31');
  assert.equal(parsePeriod('사유 발생일로부터 60일 이내', TODAY).always, false);
});

test('작은 도구들', () => {
  assert.equal(stripTags('<p>스마트&nbsp;공장</p><br>지원 &#39;2차&#x27;'), "스마트 공장\n지원 '2차'");
  assert.equal(absUrl('www.k-startup.go.kr/a'), 'https://www.k-startup.go.kr/a');
  assert.equal(absUrl('/sii/x.do', 'https://www.bizinfo.go.kr'), 'https://www.bizinfo.go.kr/sii/x.do');
  assert.equal(absUrl('javascript:alert(1)'), '');
  assert.deepEqual(pickList({ item: { a: 1 } }), [{ a: 1 }]);
  assert.deepEqual(pickList(''), []);
  assert.equal(decodeKey('abc%2Bdef%3D%3D'), 'abc+def==');
  assert.equal(decodeKey('abc+def=='), 'abc+def==');
});

test('기업마당 항목 변환', () => {
  const all17 = '서울,부산,대구,인천,광주,대전,울산,세종,경기,강원,충북,충남,전북,전남,경북,경남,제주';
  const it = normalizeBizinfo({
    pblancId: 'PBLN_000000000125088', pblancNm: '2026년 수출바우처 2차 모집',
    pblancUrl: 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000125088',
    jrsdInsttNm: '중소벤처기업부', excInsttNm: '중소벤처기업진흥공단', reqstBeginEndDe: '2026-10-01 ~ 2026-10-24',
    pldirSportRealmLclasCodeNm: '수출', trgetNm: '중소기업', bsnsSumryCn: '<p>해외 마케팅 비용 지원</p>',
    hashtags: `2026,수출,바우처,${all17}`, creatPnttm: '2026-09-30 10:00:00',
  }, TODAY);
  assert.equal(it.id, 'bizinfo:PBLN_000000000125088');
  assert.equal(it.org, '중소벤처기업부 · 중소벤처기업진흥공단');
  assert.equal(it.region, '전국');
  assert.equal(it.end, '2026-10-24');
  assert.deepEqual(it.tags, ['수출', '바우처']);
  assert.equal(it.summary, '해외 마케팅 비용 지원');
  assert.equal(it.postedAt, '2026-09-30');
  const local = normalizeBizinfo({ pblancId: 'P2', pblancNm: 'x', hashTags: '부산,창업', reqstBeginEndDe: '선착순 접수' }, TODAY);
  assert.equal(local.region, '부산');
  assert.equal(local.always, true);
});

test('K-Startup 항목 변환', () => {
  const it = normalizeKstartup({
    pbanc_sn: 178662, biz_pbanc_nm: '2026년 예비창업패키지 추가모집', pbanc_ntrp_nm: '창업진흥원',
    supt_biz_clsfc: '사업화', aply_trgt: '일반인', biz_enyy: '예비창업자', supt_regin: '전국',
    pbanc_rcpt_bgng_dt: '20261001', pbanc_rcpt_end_dt: '20261020',
    detl_pg_url: 'www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=178662', pbanc_ctnt: '사업화 자금 지원',
  });
  assert.equal(it.id, 'kstartup:178662');
  assert.equal(it.start, '2026-10-01');
  assert.equal(it.end, '2026-10-20');
  assert.match(it.url, /^https:\/\/www\.k-startup\.go\.kr\//);
  assert.match(it.target, /예비창업자/);
});

test('K-Startup 업력·연령 구간을 범위로 바꾼다', () => {
  assert.deepEqual(parseEnyy('예비창업자'), { prestartup: 'only', bizYearsMin: null, bizYearsMax: null });
  assert.deepEqual(parseEnyy('예비창업자,1년미만,2년미만,3년미만'), { prestartup: 'yes', bizYearsMin: null, bizYearsMax: 2 });
  assert.deepEqual(parseEnyy('5년미만,7년미만'), { prestartup: 'no', bizYearsMin: 3, bizYearsMax: 6 });
  assert.deepEqual(parseEnyy('7년미만,10년미만,10년이상'), { prestartup: 'no', bizYearsMin: 5, bizYearsMax: null });
  assert.deepEqual(parseEnyy(''), {});
  assert.deepEqual(parseAgeBuckets('만 20세 이상 ~ 만 39세 이하'), { ageMin: 20, ageMax: 39 });
  assert.deepEqual(parseAgeBuckets('만 20세 미만,만 20세 이상 ~ 만 39세 이하,만 40세 이상'), { ageMin: null, ageMax: null });
  assert.deepEqual(parseAgeBuckets('만 20세 미만,만 20세 이상 ~ 만 39세 이하'), { ageMin: null, ageMax: 39 });
});

test('온통청년 항목 변환', () => {
  const it = normalizeYouth({
    plcyNo: '20260914005400213415', plcyNm: '청년 월세 지원', sprvsnInstCdNm: '국토교통부',
    lclsfNm: '주거', mclsfNm: '주거,주거비지원', aplyYmd: '20260101 ~ 20261231', aplyPrdSeCd: '0057001',
    sprtTrgtMinAge: '19', sprtTrgtMaxAge: '34', plcyExplnCn: '월 최대 20만 원', rgtrHghrkInstCdNm: '국토교통부',
    plcyKywdNm: '주거,바우처', frstRegDt: '2026-01-02 09:00:00',
  }, TODAY);
  assert.equal(it.url, 'https://www.youthcenter.go.kr/youthPolicy/ythPlcyTotalSearch/ythPlcyDetail/20260914005400213415');
  assert.equal(it.category, '주거 > 주거비지원');
  assert.equal(it.target, '청년 · 만 19~34세');
  assert.equal(it.end, '2026-12-31');
  assert.deepEqual([it.ageMin, it.ageMax], [19, 34]);
  const always = normalizeYouth({ plcyNo: '1', plcyNm: '면접정장 대여', aplyYmd: '', aplyPrdSeCd: '0057002' }, TODAY);
  assert.equal(always.always, true);
  assert.equal(always.periodText, '상시');
});

test('보조금24 항목 변환', () => {
  const it = normalizeGov24({
    서비스ID: '000000465790', 서비스명: '에너지바우처', 소관기관명: '산업통상자원부', 서비스분야: '생활안정',
    지원대상: '기초생활수급 가구', 신청기한: '2026.05.04~2026.12.31', 상세조회URL: 'https://www.gov.kr/portal/rcvfvrSvc/dtlEx/000000465790',
    서비스목적요약: '냉난방 비용 지원', 사용자구분: '개인||가구', 지원유형: '이용권', 등록일시: '20201217142613',
  }, TODAY);
  assert.equal(it.end, '2026-12-31');
  assert.deepEqual(it.tags, ['개인', '가구', '이용권']);
  assert.equal(it.postedAt, '2020-12-17');
});

test('나라장터 항목 변환', () => {
  const it = normalizeG2b({
    bidNtceNo: 'R26BK00934017', bidNtceOrd: '000', bidNtceNm: '홍보영상 제작 용역', ntceInsttNm: '○○군', dminsttNm: '○○군 문화관광과',
    srvceDivNm: '일반용역', cntrctCnclsMthdNm: '제한경쟁', bidNtceDt: '2026-10-15 10:00:00', bidBeginDt: '2026-10-16 09:00:00',
    bidClseDt: '2026-10-23 10:00:00', opengDt: '2026-10-23 11:00:00', asignBdgtAmt: '80000000',
    bidNtceDtlUrl: 'https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R26BK00934017&bidPbancOrd=000',
  });
  assert.equal(it.id, 'g2b:R26BK00934017-000');
  assert.equal(it.end, '2026-10-23');
  assert.equal(it.endTime, '10:00');
  assert.equal(it.amount, 80000000);
  assert.equal(it.region, '전국');
});

test('같은 공고는 하나로 합친다', () => {
  const out = dedupe([
    { source: 'bizinfo', title: '[중기부] 2026년 예비창업패키지 추가모집', end: '2026-10-20' },
    { source: 'kstartup', title: '2026년 예비창업패키지 추가 모집', end: '2026-10-20' },
    { source: 'kstartup', title: '2026년 예비창업패키지 추가 모집', end: '2026-11-20' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].source, 'kstartup');
  assert.deepEqual(out[0].alsoIn, ['bizinfo']);
});

/* 응답 껍데기와 오류 처리: fetch를 흉내 내어 collectAll 전체를 돌려 본다 */
function fakeFetch(routes) {
  return async url => {
    const u = new URL(url);
    const hit = routes.find(([prefix]) => (u.origin + u.pathname).startsWith(prefix));
    if (!hit) return new Response('not found', { status: 404 });
    const body = typeof hit[1] === 'function' ? hit[1](u) : hit[1];
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  };
}

test('collectAll: 출처별 응답 껍데기를 풀고 오류를 출처 단위로 기록한다', async () => {
  const seen = {};
  const fetchImpl = fakeFetch([
    ['https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do', { jsonArray: [{ pblancId: 'P1', pblancNm: '스마트공장 지원', reqstBeginEndDe: '2026-10-01 ~ 2026-10-30', hashtags: '서울' }] }],
    ['https://apis.data.go.kr/B552735/', u => { seen.kstartup = u; return { currentCount: 1, matchCount: 1, data: [{ pbanc_sn: 1, biz_pbanc_nm: '창업 해커톤', pbanc_rcpt_end_dt: '20261025' }] }; }],
    ['https://www.youthcenter.go.kr/go/ythip/getPlcy', { resultCode: 200, result: { pagging: { totCount: 2 }, youthPolicyList: [
      { plcyNo: 'Y1', plcyNm: '청년 일경험', aplyYmd: '20261001 ~ 20261031' },
      { plcyNo: 'Y2', plcyNm: '지난 정책', aplyYmd: '20250101 ~ 20250131' },
    ] } }],
    ['https://api.odcloud.kr/api/gov24/v3/serviceList', { currentCount: 2, matchCount: 2, data: [
      { 서비스ID: 'G1', 서비스명: '문화누리카드', 신청기한: '2026.02.01~2026.11.30' },
      { 서비스ID: 'G2', 서비스명: '상시 서비스', 신청기한: '상시신청' },
    ] }],
    ['https://apis.data.go.kr/1230000/ad/BidPublicInfoService', { OpenAPI_ServiceResponse: { cmmMsgHeader: { errMsg: 'SERVICE ERROR', returnAuthMsg: 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR' } } }],
  ]);
  const env = { BIZINFO_API_KEY: 'k1', DATA_GO_KR_API_KEY: 'k2%2B', YOUTH_API_KEY: 'k3' };
  const out = await collectAll(env, { fetchImpl, now: NOW, retries: 0, contests: [
    { id: 'c1', title: '공공데이터 아이디어 공모전', end: '2026-10-30' },
    { id: 'c2', title: '지난 공모전', end: '2026-01-01' },
  ] });

  assert.equal(out.today, TODAY);
  assert.deepEqual(Object.fromEntries(Object.entries(out.sources).map(([k, v]) => [k, v.ok])),
    { bizinfo: true, kstartup: true, youth: true, gov24: true, g2b: false, contest: true });
  assert.equal(out.sources.g2b.error, 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR');
  assert.equal(out.sources.youth.count, 1, '이미 끝난 청년정책은 뺀다');
  assert.equal(out.sources.gov24.count, 1, '검색어가 없으면 기한 있는 보조금24 서비스만 남긴다');
  assert.equal(out.sources.contest.count, 1);
  assert.equal(seen.kstartup.searchParams.get('serviceKey'), 'k2+', 'Encoding 키를 한 번 풀어서 보낸다');
  assert.equal(seen.kstartup.searchParams.get('cond[rcrt_prgs_yn::EQ]'), 'Y');
  assert.equal(out.items.length, 5);
});

test('collectAll: 인증키가 없으면 건너뛴다', async () => {
  const out = await collectAll({}, { now: NOW, fetchImpl: () => { throw new Error('호출되면 안 됨'); } });
  assert.ok(Object.values(out.sources).every(s => s.skipped));
  assert.equal(out.items.length, 0);
});

test('collectAll: 기업마당 오류 본문(reqErr)을 실패로 본다', async () => {
  const fetchImpl = fakeFetch([['https://www.bizinfo.go.kr/', { reqErr: '페이지 번호를 입력해주세요.' }]]);
  const out = await collectAll({ BIZINFO_API_KEY: 'k' }, { only: ['bizinfo'], fetchImpl, now: NOW, retries: 0 });
  assert.equal(out.sources.bizinfo.ok, false);
  assert.equal(out.sources.bizinfo.error, '페이지 번호를 입력해주세요.');
});
