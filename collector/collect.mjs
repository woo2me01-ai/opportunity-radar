#!/usr/bin/env node
// 공공 API에서 공고를 모아 data/opportunities.json 하나로 저장합니다.
//
//   BIZINFO_API_KEY=... DATA_GO_KR_API_KEY=... YOUTH_API_KEY=... node collector/collect.mjs
//
// 옵션
//   --out <파일>        저장 위치 (기본: data/opportunities.json)
//   --only a,b          특정 출처만 (bizinfo,kstartup,youth,gov24,g2b)
//   --contests <파일>   직접 관리하는 공모전 목록 JSON (기본: data/contests.json, 없으면 건너뜀)
//
// 인증키가 없는 출처는 건너뛰고, 결과 파일의 sources 항목에 '인증키 없음'으로 남습니다.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAll } from './sources.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function readContests(path) {
  try {
    const list = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(list)) throw new Error('배열이 아닙니다');
    return list;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    console.warn(`공모전 목록을 읽지 못했습니다 (${path}): ${e.message}`);
    return [];
  }
}

const out = resolve(process.cwd(), arg('out', resolve(root, 'data/opportunities.json')));
const only = arg('only', '').split(',').map(s => s.trim()).filter(Boolean);
const contests = await readContests(resolve(process.cwd(), arg('contests', resolve(root, 'data/contests.json'))));

const payload = await collectAll(process.env, { only, contests, maxPages: 30 });

await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(payload));

for (const [id, s] of Object.entries(payload.sources)) {
  const state = s.ok ? `${s.count}건 (${s.ms ?? 0}ms)` : s.skipped ? '건너뜀: 인증키 없음' : `실패: ${s.error}`;
  console.log(`${id.padEnd(9)} ${state}`);
}
console.log(`합계 ${payload.count}건 → ${out}`);

// 키가 있는데 모든 출처가 실패했으면 CI에서 알 수 있게 실패로 끝냅니다
const tried = Object.values(payload.sources).filter(s => !s.skipped);
if (tried.length && tried.every(s => !s.ok)) process.exitCode = 1;
