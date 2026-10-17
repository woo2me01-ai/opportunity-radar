// 알림: 새 공고·마감 임박 고르기, 채널별 글 만들기, 발송 호출
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { selectForAlert, formatTelegram, formatEmail, formatWebhook, deliver } from './notify.mjs';

const R = createRequire(import.meta.url)('../rules.js');
const TODAY = '2026-10-17';
const raw = [
  { id: 'kstartup:1', source: 'kstartup', title: '부산 창업 해커톤 <2026>', org: '○○센터', target: '만 39세 이하 청년 및 예비창업자', region: '부산', start: '2026-10-10', end: '2026-10-20', url: 'https://www.k-startup.go.kr/a?x=1&y=2' },
  { id: 'kstartup:2', source: 'kstartup', title: '창업도약 패키지', org: '○○기관', target: '업력 3년 이상 7년 이내 창업기업', region: '전국', start: '2026-10-01', end: '2026-10-18', url: 'https://www.k-startup.go.kr/b' },
  { id: 'bizinfo:3', source: 'bizinfo', title: '예비창업자 사업화 지원', org: '○○도', target: '사업자 등록이 없는 예비창업자', region: '전국', start: '2026-10-01', end: '2026-10-20', url: 'https://www.bizinfo.go.kr/c' },
  { id: 'youth:4', source: 'youth', title: '경남 청년 마음건강 바우처', org: '경남', target: '청년 · 만 19~34세', region: '경남', start: '2026-10-01', end: '2026-10-20' },
  { id: 'g2b:5', source: 'g2b', title: '홍보영상 제작 용역', org: '○○군', target: '업체', region: '전국', start: '2026-10-01', end: '2026-10-20' },
  { id: 'bizinfo:6', source: 'bizinfo', title: '지난 공고', org: '○○', target: '예비창업자', region: '전국', start: '2026-09-01', end: '2026-10-01' },
];
const items = raw.map(it => R.enrich(it, TODAY));
const alert = {
  name: '부산 예비창업',
  profile: { kinds: ['예비창업자'], age: 29, region: '부산' },
  filter: { minMatch: 'mid' },
  deadlineDays: [3, 1],
  channels: { telegram: '42', email: 'me@example.com', webhook: 'https://hooks.slack.com/services/T/B/X' },
};

test('직전 결과에 없던 공고만 새 공고로, 마감 3일·1일 전 공고는 마감 임박으로 고른다', () => {
  const prev = { ids: new Set(['kstartup:2', 'bizinfo:3', 'youth:4', 'g2b:5']), okSources: new Set(['kstartup', 'bizinfo', 'youth', 'g2b']) };
  const sel = selectForAlert(items, alert, prev);
  assert.deepEqual(sel.fresh.map(it => it.id), ['kstartup:1']);
  // kstartup:2는 D-1이지만 예비창업자에게 해당 어려움(업력 3년 이상)이라 빠진다
  assert.deepEqual(sel.due.map(it => it.id), ['bizinfo:3']);
});

test('직전 결과가 없으면 새 공고 알림을 보내지 않는다', () => {
  assert.equal(selectForAlert(items, alert, null).fresh.length, 0);
});

test('어제 실패한 출처의 공고는 새 공고로 치지 않는다', () => {
  const prev = { ids: new Set(), okSources: new Set(['bizinfo']) };
  const sel = selectForAlert(items, { ...alert, filter: { minMatch: 'any' } }, prev);
  assert.ok(sel.fresh.every(it => it.source === 'bizinfo'));
});

test('키워드·유형 필터와 minMatch를 적용한다', () => {
  const prev = { ids: new Set(), okSources: null };
  const kw = selectForAlert(items, { profile: {}, filter: { keywords: ['용역'] } }, prev);
  assert.deepEqual(kw.fresh.map(it => it.id), ['g2b:5']);
  const type = selectForAlert(items, { profile: {}, filter: { types: ['청년정책'] } }, prev);
  assert.deepEqual(type.fresh.map(it => it.id), ['youth:4']);
  const high = selectForAlert(items, { ...alert, filter: { minMatch: 'high' } }, prev);
  assert.ok(high.fresh.every(it => it.match.level === 'high'));
  assert.ok(!high.fresh.some(it => it.id === 'bizinfo:6'), '마감된 공고는 보내지 않는다');
});

test('텔레그램 글: HTML을 이스케이프하고 링크를 단다', () => {
  const sel = selectForAlert(items, alert, { ids: new Set(), okSources: null });
  const [msg] = formatTelegram(alert, sel, { today: TODAY, siteUrl: 'https://example.github.io/radar' });
  assert.match(msg, /<b>기회레이더 · 부산 예비창업<\/b>/);
  assert.match(msg, /10월 17일 \(토\) 기준/);
  assert.match(msg, /부산 창업 해커톤 &lt;2026&gt;/);
  assert.match(msg, /href="https:\/\/www\.k-startup\.go\.kr\/a\?x=1&amp;y=2"/);
  assert.match(msg, /조건 맞음/);
  assert.match(msg, /전체 보기: https:\/\/example\.github\.io\/radar/);
});

test('텔레그램 글: 길면 여러 메시지로 나눈다', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ ...items[0], id: `k${i}`, title: `아주 긴 공고 제목 ${'가'.repeat(150)} ${i}` }));
  const chunks = formatTelegram({ name: 'x' }, { fresh: many, due: [] }, { today: TODAY });
  assert.ok(chunks.every(c => c.length <= 4096));
  assert.match(chunks.at(-1), /외 25건/);
});

test('이메일과 웹훅 글', () => {
  const sel = { fresh: [items[0]], due: [items[2]] };
  const mail = formatEmail(alert, sel, { today: TODAY });
  assert.equal(mail.subject, '[기회레이더] 부산 예비창업: 새 공고 1건 · 마감 임박 1건');
  assert.match(mail.html, /&lt;2026&gt;/);
  const slack = formatWebhook('https://hooks.slack.com/services/x', alert, sel, { today: TODAY });
  assert.match(slack.text, /<https:\/\/www\.k-startup\.go\.kr\/a\?x=1&y=2\|부산 창업 해커톤 2026>/);
  const discord = formatWebhook('https://discord.com/api/webhooks/1/abc', alert, sel, { today: TODAY });
  assert.ok(discord.content.length <= 2000);
  assert.match(discord.content, /\*\*새 공고 1건\*\*/);
});

test('deliver: 채널별로 올바른 주소에 보내고, 실패는 채널 단위로 기록한다', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith('https://hooks.slack.com')) return new Response('invalid_token', { status: 403 });
    return new Response('{}', { status: 200 });
  };
  const sel = { fresh: [items[0]], due: [] };
  const env = { TELEGRAM_BOT_TOKEN: 'T0K', RESEND_API_KEY: 're_x', ALERT_EMAIL_FROM: '기회레이더 <radar@example.com>' };
  const results = await deliver(alert, sel, env, { today: TODAY, fetchImpl });
  assert.deepEqual(results.map(r => [r.channel, r.ok]), [['telegram', true], ['email', true], ['webhook', false]]);
  assert.equal(calls[0].url, 'https://api.telegram.org/botT0K/sendMessage');
  assert.equal(JSON.parse(calls[0].init.body).chat_id, '42');
  assert.equal(calls[1].url, 'https://api.resend.com/emails');
  assert.equal(calls[1].init.headers.authorization, 'Bearer re_x');
  assert.deepEqual(JSON.parse(calls[1].init.body).to, ['me@example.com']);
  assert.match(results[2].error, /403/);
});

test('deliver: 비밀값이 없으면 그 채널만 실패, dry-run은 아무것도 보내지 않는다', async () => {
  const sel = { fresh: [items[0]], due: [] };
  const missing = await deliver({ ...alert, channels: { telegram: '1' } }, sel, {}, { today: TODAY, fetchImpl: () => { throw new Error('호출되면 안 됨'); } });
  assert.match(missing[0].error, /TELEGRAM_BOT_TOKEN/);
  const out = [];
  const dry = await deliver(alert, sel, {}, { today: TODAY, dryRun: true, log: s => out.push(s), fetchImpl: () => { throw new Error('호출되면 안 됨'); } });
  assert.ok(dry.every(r => r.ok));
  assert.equal(out.length, 3);
});
