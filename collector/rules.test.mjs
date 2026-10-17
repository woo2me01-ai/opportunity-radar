// 공용 규칙(rules.js): 대상·자격 정보 읽기와 내 조건 맞춤도 판정
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const R = createRequire(import.meta.url)('../rules.js');
const TODAY = '2026-10-17';
const item = (over = {}) => R.enrich({ id: 'x', source: 'bizinfo', title: '테스트 공고', region: '전국', start: '2026-10-01', end: '2026-10-30', ...over }, TODAY);

test('대상 원문에서 나이와 업력을 읽는다', () => {
  const a = item({ target: '만 19~34세 무주택 청년' });
  assert.deepEqual([a.ageMin, a.ageMax], [19, 34]);
  const b = item({ target: '만 39세 이하 청년 및 예비창업자 누구나' });
  assert.deepEqual([b.ageMin, b.ageMax], [null, 39]);
  const c = item({ target: '업력 3년 이상 7년 이내 창업기업' });
  assert.deepEqual([c.bizYearsMin, c.bizYearsMax], [3, 7]);
  const d = item({ target: '공공기술을 이전받은 창업 7년 이내 기업' });
  assert.deepEqual([d.bizYearsMin, d.bizYearsMax], [null, 7]);
  const e = item({ target: '공고일 기준 사업자 등록이 없는 예비창업자' });
  assert.equal(e.prestartup, 'only');
  assert.deepEqual(e.targets, ['예비창업자']);
  const f = item({ title: '2026년 예비창업자 지원', target: '예비창업자 및 창업 3년 이내 기업' });
  assert.equal(f.prestartup, 'yes');
  assert.equal(f.bizYearsMax, 3);
});

test('출처가 준 구조화 값이 원문 추정보다 우선한다', () => {
  const it = item({ target: '만 19~34세', ageMin: 20, ageMax: 39 });
  assert.deepEqual([it.ageMin, it.ageMax], [20, 39]);
});

test('고용주가 신청하는 공고는 청년 개인 대상으로 보지 않는다', () => {
  const it = item({ title: '청년 일자리 도약 장려금 참여기업 모집', target: '청년을 정규직으로 채용한 5인 이상 중소기업' });
  assert.ok(!it.targets.includes('청년'));
  assert.ok(it.targets.includes('중소기업'));
});

test('창업기업과 기업가는 중소기업 규칙에 걸리지 않는다', () => {
  assert.deepEqual(item({ target: '창업기업' }).targets, ['창업기업']);
  assert.ok(!item({ target: '청년 기업가' }).targets.includes('중소기업'));
});

test('맞춤도: 조건이 모두 맞으면 high', () => {
  const it = item({ source: 'kstartup', title: '창업 해커톤', target: '만 39세 이하 청년 및 예비창업자 누구나', region: '부산' });
  const m = R.matchProfile(it, { kinds: ['예비창업자'], age: 29, region: '부산' });
  assert.equal(m.level, 'high');
  assert.deepEqual(m.checks.map(c => [c.key, c.state]), [['대상', 'ok'], ['나이', 'ok'], ['지역', 'ok']]);
});

test('맞춤도: 나이·지역·업력 중 하나라도 어긋나면 low', () => {
  const youth = item({ source: 'youth', target: '청년 · 만 19~34세', region: '경남' });
  assert.equal(R.matchProfile(youth, { kinds: ['개인'], age: 40 }).level, 'low');
  assert.equal(R.matchProfile(youth, { kinds: ['개인'], age: 30, region: '부산' }).level, 'low');
  assert.equal(R.matchProfile(youth, { kinds: ['개인'], age: 30, region: '경남' }).level, 'high');

  const scale = item({ target: '업력 3년 이상 7년 이내 창업기업' });
  assert.equal(R.matchProfile(scale, { kinds: ['창업기업'], bizYears: 5 }).level, 'high');
  assert.equal(R.matchProfile(scale, { kinds: ['창업기업'], bizYears: 1 }).level, 'low');
  assert.equal(R.matchProfile(scale, { kinds: ['예비창업자'] }).level, 'low');
  assert.equal(R.matchProfile(scale, { kinds: ['창업기업'] }).level, 'mid', '업력을 모르면 확인 필요');
});

test('맞춤도: 예비창업자 전용 공고는 이미 창업한 기업에게 low', () => {
  const pre = item({ target: '공고일 기준 사업자 등록이 없는 예비창업자' });
  assert.equal(R.matchProfile(pre, { kinds: ['예비창업자'] }).level, 'high');
  assert.equal(R.matchProfile(pre, { kinds: ['중소기업'], bizYears: 4 }).level, 'low');
});

test('맞춤도: 대상 정보가 없으면 확인 필요, 관심 분야는 가산점', () => {
  const vague = item({ title: '지원사업 안내', target: '' });
  const m = R.matchProfile(vague, { kinds: ['중소기업'] });
  assert.equal(m.level, 'mid');
  const fit = item({ title: '수출바우처', target: '중소기업' });
  const a = R.matchProfile(fit, { kinds: ['중소기업'], interests: ['수출·판로'] });
  const b = R.matchProfile(fit, { kinds: ['중소기업'] });
  assert.ok(a.score > b.score);
  assert.equal(R.matchProfile(fit, {}), null, '조건이 비어 있으면 판정하지 않음');
});

test('상태: 오늘 기준 D-day와 상시·확인 필요를 구분한다', () => {
  assert.equal(item({ end: '2026-10-17' }).status, 'soon');
  assert.equal(item({ end: '2026-10-17' }).dleft, 0);
  assert.equal(item({ start: '2026-10-20', end: '2026-11-20' }).status, 'upcoming');
  assert.equal(item({ end: '2026-10-16' }).status, 'closed');
  assert.equal(item({ start: null, end: null, periodText: '예산 소진 시까지' }).status, 'always');
  assert.equal(item({ start: null, end: null, periodText: '사유 발생 후 60일 이내' }).status, 'unknown');
});
