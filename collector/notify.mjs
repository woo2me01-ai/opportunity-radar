#!/usr/bin/env node
// 수집 결과를 직전 결과와 비교해, 알림 설정마다 새 공고와 마감 임박 공고를 보냅니다.
//
//   node collector/notify.mjs --current data/opportunities.json --prev data/previous.json [--dry-run]
//
// 알림 설정: 환경 변수 ALERTS_JSON (화면의 '이 조건으로 알림 받기'가 만들어 줍니다) 또는 --config <파일>
//   [{ "name": "부산 예비창업",
//      "profile": { "kinds": ["예비창업자"], "age": 29, "region": "부산" },
//      "filter": { "minMatch": "mid", "keywords": ["해커톤"], "types": ["창업"] },
//      "deadlineDays": [3, 1],
//      "channels": { "telegram": "123456789", "email": "me@example.com", "webhook": "https://hooks.slack.com/..." } }]
//
// 채널 비밀값
//   TELEGRAM_BOT_TOKEN              텔레그램 봇 토큰 (@BotFather)
//   RESEND_API_KEY, ALERT_EMAIL_FROM 이메일 발송 (resend.com, 보내는 주소는 인증한 도메인)
//   SITE_URL                        메시지 끝에 붙일 사이트 주소 (선택)

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const R = require('../rules.js');

const LEVEL_RANK = { high: 2, mid: 1, low: 0 };
const MAX_PER_SECTION = 15;
const WD = '일월화수목금토';

/* ───────── 고르기 ───────── */

/**
 * items: R.enrich를 거친 공고 목록
 * prev: { ids: Set, okSources: Set } | null (직전 결과가 없으면 새 공고 알림을 건너뜀)
 */
export function selectForAlert(items, alert, prev) {
  const profile = alert.profile || {};
  const f = alert.filter || {};
  const min = f.minMatch || (R.hasProfile(profile) ? 'mid' : 'any');
  const keywords = (f.keywords || []).map(k => String(k).toLowerCase()).filter(Boolean);
  const days = alert.deadlineDays ?? [3, 1];

  const matched = items
    .map(it => ({ ...it, match: R.matchProfile(it, profile) }))
    .filter(it => {
      if (it.status === 'closed') return false;
      if (f.types?.length && !it.types.some(t => f.types.includes(t))) return false;
      if (f.sources?.length && !f.sources.includes(it.source)) return false;
      if (keywords.length && !keywords.some(k => it.search.includes(k))) return false;
      if (min !== 'any' && it.match && LEVEL_RANK[it.match.level] < LEVEL_RANK[min]) return false;
      return true;
    });

  // 어제 불러오지 못한 출처의 공고는 전부 새것처럼 보이므로 새 공고로 치지 않습니다
  const fresh = prev
    ? matched.filter(it => !prev.ids.has(it.id) && (!prev.okSources || prev.okSources.has(it.source)))
    : [];
  const freshIds = new Set(fresh.map(it => it.id));
  const due = matched.filter(it => (it.status === 'soon' || it.status === 'open') && days.includes(it.dleft) && !freshIds.has(it.id));

  const byScore = (a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0) || (a.dleft ?? 9999) - (b.dleft ?? 9999);
  return { fresh: fresh.sort(byScore), due: due.sort((a, b) => a.dleft - b.dleft || byScore(a, b)) };
}

/* ───────── 글 만들기 ───────── */

const md = s => (s ? `${Number(s.slice(5, 7))}.${s.slice(8, 10)}` : '');
function deadlineText(it) {
  switch (it.status) {
    case 'always':   return '상시 접수';
    case 'unknown':  return '기간은 원문 확인';
    case 'upcoming': return `${md(it.start)} 접수 시작`;
    default:         return it.dleft === 0 ? '오늘 마감' : `D-${it.dleft} (${md(it.end)} 마감)`;
  }
}
const sourceLabel = it => R.SOURCES[it.source]?.label || it.source;
const matchLabel = it => (it.match ? R.MATCH_LABEL[it.match.level] : '');
const metaLine = it => [it.org, deadlineText(it), matchLabel(it)].filter(Boolean).join(' · ');
const dateLabel = today => {
  const d = new Date(`${today}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 (${WD[d.getUTCDay()]})`;
};
const subjectOf = (alert, sel) =>
  `[기회레이더] ${alert.name || '알림'}: ${[sel.fresh.length && `새 공고 ${sel.fresh.length}건`, sel.due.length && `마감 임박 ${sel.due.length}건`].filter(Boolean).join(' · ')}`;

const escHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const safeUrl = u => (/^https?:\/\//i.test(u || '') ? u : '');

/** 텔레그램 HTML 메시지. 4,096자 제한이 있어 여러 개로 나눕니다 */
export function formatTelegram(alert, sel, { today, siteUrl } = {}) {
  const lines = [`<b>기회레이더 · ${escHtml(alert.name || '알림')}</b>`, `${dateLabel(today)} 기준`];
  const section = (title, list, prefix) => {
    if (!list.length) return;
    lines.push('', `<b>${title} ${list.length}건</b>`);
    for (const it of list.slice(0, MAX_PER_SECTION)) {
      const url = safeUrl(it.url);
      const name = url ? `<a href="${escHtml(url)}">${escHtml(it.title)}</a>` : escHtml(it.title);
      lines.push(`• ${prefix ? `${escHtml(prefix(it))} ` : ''}${name}`, `   ${escHtml(metaLine(it))} · ${escHtml(sourceLabel(it))}`);
    }
    if (list.length > MAX_PER_SECTION) lines.push(`   외 ${list.length - MAX_PER_SECTION}건`);
  };
  section('새 공고', sel.fresh);
  section('마감 임박', sel.due, it => (it.dleft === 0 ? '오늘' : `D-${it.dleft}`));
  if (siteUrl) lines.push('', `전체 보기: ${escHtml(siteUrl)}`);
  lines.push('', '자격 요건은 원문 공고에서 꼭 확인하세요.');

  const chunks = [];
  let cur = '';
  for (const line of lines) {
    if ((cur + line).length > 3800) { chunks.push(cur.trimEnd()); cur = ''; }
    cur += `${line}\n`;
  }
  if (cur.trim()) chunks.push(cur.trimEnd());
  return chunks;
}

export function formatEmail(alert, sel, { today, siteUrl } = {}) {
  const subject = subjectOf(alert, sel);
  const section = (title, list) => {
    if (!list.length) return { html: '', text: '' };
    const shown = list.slice(0, MAX_PER_SECTION * 2);
    const html = `<h2 style="font-size:16px;margin:24px 0 8px">${title} ${list.length}건</h2>` + shown.map(it => {
      const url = safeUrl(it.url);
      const name = url ? `<a href="${escHtml(url)}" style="color:#0f6b5c">${escHtml(it.title)}</a>` : escHtml(it.title);
      return `<p style="margin:0 0 12px;line-height:1.5"><strong>${name}</strong><br><span style="color:#4a5561;font-size:13px">${escHtml(metaLine(it))} · ${escHtml(sourceLabel(it))}</span></p>`;
    }).join('') + (list.length > shown.length ? `<p style="color:#737d87">외 ${list.length - shown.length}건</p>` : '');
    const text = `\n${title} ${list.length}건\n` + shown.map(it => `- ${it.title}\n  ${metaLine(it)} · ${sourceLabel(it)}\n  ${safeUrl(it.url)}`).join('\n');
    return { html, text };
  };
  const a = section('새 공고', sel.fresh);
  const b = section('마감 임박', sel.due);
  const html = `<div style="font-family:-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;color:#17202a;max-width:640px">
<p style="margin:0;color:#737d87;font-size:13px">${escHtml(dateLabel(today))} 기준</p>
<h1 style="font-size:20px;margin:4px 0 0">기회레이더 · ${escHtml(alert.name || '알림')}</h1>${a.html}${b.html}
${siteUrl ? `<p style="margin-top:24px"><a href="${escHtml(siteUrl)}" style="color:#0f6b5c">기회레이더에서 전체 보기</a></p>` : ''}
<p style="color:#737d87;font-size:12px;margin-top:24px">자동 판정이라 틀릴 수 있습니다. 자격 요건은 원문 공고에서 꼭 확인하세요.</p></div>`;
  const text = `기회레이더 · ${alert.name || '알림'} (${dateLabel(today)} 기준)\n${a.text}\n${b.text}\n${siteUrl ? `\n전체 보기: ${siteUrl}` : ''}`;
  return { subject, html, text };
}

/** 슬랙(text, mrkdwn 링크) 또는 디스코드(content, 2,000자 제한) 웹훅 본문 */
export function formatWebhook(url, alert, sel, { today, siteUrl } = {}) {
  const discord = /discord(app)?\.com/i.test(url);
  const link = it => {
    const u = safeUrl(it.url);
    if (!u) return it.title;
    return discord ? `[${it.title.replace(/[[\]]/g, '')}](<${u}>)` : `<${u}|${it.title.replace(/[<>|]/g, '')}>`;
  };
  const lines = [`*기회레이더 · ${alert.name || '알림'}* (${dateLabel(today)} 기준)`.replace(/^\*(.*)\*/, discord ? '**$1**' : '*$1*')];
  const section = (title, list, n) => {
    if (!list.length) return;
    lines.push('', `${discord ? '**' : '*'}${title} ${list.length}건${discord ? '**' : '*'}`);
    list.slice(0, n).forEach(it => lines.push(`• ${link(it)} — ${metaLine(it)}`));
    if (list.length > n) lines.push(`외 ${list.length - n}건`);
  };
  const n = discord ? 6 : MAX_PER_SECTION;
  section('새 공고', sel.fresh, n);
  section('마감 임박', sel.due, n);
  if (siteUrl) lines.push('', discord ? `전체 보기: <${siteUrl}>` : `<${siteUrl}|기회레이더에서 전체 보기>`);
  const text = lines.join('\n');
  return discord ? { content: text.slice(0, 1990) } : { text };
}

/* ───────── 보내기 ───────── */

async function post(fetchImpl, url, body, headers = {}) {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  return res;
}

export async function deliver(alert, sel, env, { today, siteUrl, dryRun = false, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const ch = alert.channels || {};
  const results = [];
  const run = async (name, fn) => {
    try { await fn(); results.push({ channel: name, ok: true }); }
    catch (e) { results.push({ channel: name, ok: false, error: e.message }); }
  };

  if (ch.telegram) {
    await run('telegram', async () => {
      const chunks = formatTelegram(alert, sel, { today, siteUrl });
      if (dryRun) return chunks.forEach(c => log(`[텔레그램 → ${ch.telegram}]\n${c}\n`));
      if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN이 없습니다');
      for (const text of chunks) {
        await post(fetchImpl, `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
          { chat_id: ch.telegram, text, parse_mode: 'HTML', disable_web_page_preview: true });
      }
    });
  }
  if (ch.email) {
    await run('email', async () => {
      const mail = formatEmail(alert, sel, { today, siteUrl });
      if (dryRun) return log(`[이메일 → ${ch.email}] ${mail.subject}\n${mail.text}\n`);
      if (!env.RESEND_API_KEY || !env.ALERT_EMAIL_FROM) throw new Error('RESEND_API_KEY 또는 ALERT_EMAIL_FROM이 없습니다');
      await post(fetchImpl, 'https://api.resend.com/emails',
        { from: env.ALERT_EMAIL_FROM, to: [ch.email], subject: mail.subject, html: mail.html, text: mail.text },
        { authorization: `Bearer ${env.RESEND_API_KEY}` });
    });
  }
  if (ch.webhook) {
    await run('webhook', async () => {
      if (!safeUrl(ch.webhook)) throw new Error('웹훅 주소는 https://로 시작해야 합니다');
      const body = formatWebhook(ch.webhook, alert, sel, { today, siteUrl });
      if (dryRun) return log(`[웹훅]\n${body.text ?? body.content}\n`);
      await post(fetchImpl, ch.webhook, body);
    });
  }
  return results;
}

/* ───────── 실행 ───────── */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

async function readJSON(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const current = await readJSON(arg('current', 'data/opportunities.json'));

  let prev = null;
  try {
    const p = await readJSON(arg('prev', 'data/previous.json'));
    const okSources = p.sources ? new Set(Object.entries(p.sources).filter(([, s]) => s.ok).map(([k]) => k)) : null;
    prev = { ids: new Set((p.items || []).map(it => it.id)), okSources };
  } catch {
    console.log('직전 결과가 없어 새 공고 알림은 건너뛰고 마감 알림만 보냅니다.');
  }

  const raw = process.env.ALERTS_JSON?.trim() || (arg('config') ? await readFile(arg('config'), 'utf8') : '');
  if (!raw) { console.log('ALERTS_JSON이 비어 있어 보낼 알림이 없습니다.'); return; }
  let alerts;
  try { alerts = JSON.parse(raw); } catch (e) { throw new Error(`ALERTS_JSON을 읽지 못했습니다: ${e.message}`); }
  if (!Array.isArray(alerts)) alerts = [alerts];

  const today = R.todayKST();
  const items = (current.items || []).filter(it => it && it.title).map(it => R.enrich(it, today));
  const siteUrl = process.env.SITE_URL || '';
  let failed = 0;

  for (const alert of alerts) {
    const name = alert.name || '이름 없는 알림';
    const sel = selectForAlert(items, alert, prev);
    if (!sel.fresh.length && !sel.due.length) { console.log(`${name}: 보낼 공고 없음`); continue; }
    const results = await deliver(alert, sel, process.env, { today, siteUrl, dryRun });
    if (!results.length) console.log(`${name}: 받을 곳(channels)이 없습니다`);
    for (const r of results) {
      const done = dryRun ? '미리보기만 함' : '보냄';
      console.log(`${name}: ${r.channel} ${r.ok ? done : `실패 (${r.error})`} · 새 공고 ${sel.fresh.length}건, 마감 임박 ${sel.due.length}건`);
      if (!r.ok) failed++;
    }
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
