import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ScreenDump } from '../src/hold/resolve.js';

/**
 * 탐색 결과를 한 화면에 요약한다.
 *
 *   npx tsx scripts/explore-show.ts
 *
 * 덤프 파일이 수십 개가 되면 그대로는 옮기기 어렵다. 셀렉터를 짜는 데
 * 필요한 것만 추려서 붙여넣을 수 있는 크기로 만든다.
 */

const ROOT = 'fixtures/explore';

/** 예매 흐름일 가능성이 큰 경로. 이것만 자세히 편다. */
const INTERESTING = /seat|atkt|book|scn|schedule|visitor|price|ticket/i;

interface ApiDump {
  host?: string;
  method?: string;
  path?: string;
  query?: Record<string, string>;
  postData?: unknown;
  status?: number;
  body?: unknown;
}

/** 가장 최근 실행 폴더. 옛날처럼 파일이 바로 들어 있으면 그 폴더를 쓴다. */
function latestRun(dir = ROOT): string {
  const runs = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  return runs.length ? join(dir, runs[runs.length - 1]!) : dir;
}

function main() {
  let dir: string;
  let files: string[];
  try {
    dir = latestRun();
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    console.error(`${ROOT} 가 없습니다. 먼저 npm run explore 를 돌리세요.`);
    process.exit(1);
  }
  console.log(`(${dir})`);

  const screens = files.filter((f) => !f.startsWith('api-'));
  const apis = files.filter((f) => f.startsWith('api-'));

  console.log('\n═══ 화면 ═══');
  for (const f of screens) {
    const d = read<ScreenDump>(dir, f);
    if (!d) continue;
    console.log(`\n▸ ${f}`);
    console.log(`  ${d.url ?? '?'}`);
    if (d.seats) console.log(`  좌석 ${d.seats}개`);
    for (const i of (d.items ?? []).slice(0, 40)) {
      const tag = i.tag + (i.role ? `[${i.role}]` : '');
      console.log(`    ${tag.padEnd(12)} ${i.name}${i.hint ? `  · ${i.hint}` : ''}`);
    }
    const extra = (d.items ?? []).length - 40;
    if (extra > 0) console.log(`    … 외 ${extra}개`);
  }

  // 같은 엔드포인트가 여러 번 불린다. 먼저 목록으로 훑고, 예매 관련만 편다.
  const byKey = new Map<string, { d: ApiDump; file: string; hits: number }>();
  for (const f of apis) {
    const d = read<ApiDump>(dir, f);
    if (!d) continue;
    const key = `${d.method ?? 'GET'} ${d.host ?? '?'}${d.path ?? f}`;
    const prev = byKey.get(key);
    if (prev) prev.hits++;
    else byKey.set(key, { d, file: f, hits: 1 });
  }

  console.log('\n═══ API 목록 ═══');
  for (const [key, { d, hits }] of byKey) {
    const mark = INTERESTING.test(d.path ?? '') ? '★' : ' ';
    console.log(`  ${mark} ${key}  [${d.status ?? '?'}] ${hits > 1 ? `(${hits}회)` : ''}`);
  }

  const hot = [...byKey.values()].filter((v) => INTERESTING.test(v.d.path ?? ''));
  console.log('\n═══ 예매 관련 상세 ═══');
  if (hot.length === 0) {
    console.log('  없습니다. 예매 호출이 XHR 이 아닐 수 있습니다.');
  }
  for (const { d, file } of hot) {
    console.log(`\n▸ ${d.method ?? 'GET'} ${d.host ?? '?'}${d.path ?? ''}  (${file})`);
    if (d.query && Object.keys(d.query).length) {
      console.log(`  query  ${JSON.stringify(d.query)}`);
    }
    if (d.postData) console.log(`  body   ${clip(JSON.stringify(d.postData), 400)}`);
    console.log(`  응답    ${shape(d.body)}`);
  }

  console.log(`\n화면 ${screens.length}건 · API ${byKey.size}종 (${apis.length}회 호출)`);
}

/**
 * 응답의 모양만 보여준다.
 *
 * 좌석 응답은 수백 개짜리 배열이라 통째로 찍으면 아무도 안 읽는다.
 * 어떤 키가 있는지, 배열이면 첫 원소가 어떻게 생겼는지면 계약을 알 수 있다.
 */
function shape(v: unknown, depth = 0): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return `[${v.length}개] ${depth < 4 ? shape(v[0], depth + 1) : "…"}`;
  }
  if (typeof v === 'object') {
    const e = Object.entries(v as Record<string, unknown>);
    if (depth >= 4) return `{${e.length}키}`;
    return `{ ${e.slice(0, 24).map(([k, x]) => `${k}: ${leaf(x, depth)}`).join(', ')}${e.length > 24 ? ', …' : ''} }`;
  }
  return leaf(v, depth);
}

function leaf(v: unknown, depth: number): string {
  if (v === null) return 'null';
  if (Array.isArray(v) || typeof v === 'object') return shape(v, depth + 1);
  const s = String(v);
  return typeof v === 'string' ? `"${clip(s, 40)}"` : s;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function read<T>(dir: string, f: string): T | null {
  try {
    return JSON.parse(readFileSync(join(dir, f), 'utf8')) as T;
  } catch {
    return null;
  }
}

main();
