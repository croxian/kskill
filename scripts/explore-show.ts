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

const DIR = 'fixtures/explore';

interface ApiDump {
  host: string;
  method: string;
  path: string;
  query: Record<string, string>;
  postData: unknown;
  status: number;
  body: unknown;
}

function main() {
  let files: string[];
  try {
    files = readdirSync(DIR).sort();
  } catch {
    console.error(`${DIR} 가 없습니다. 먼저 npm run explore 를 돌리세요.`);
    process.exit(1);
  }

  const screens = files.filter((f) => !f.startsWith('api-'));
  const apis = files.filter((f) => f.startsWith('api-'));

  console.log('═══ 화면 ═══');
  for (const f of screens) {
    const d = read<ScreenDump>(f);
    if (!d) continue;
    console.log(`\n▸ ${f}`);
    console.log(`  ${d.url}`);
    if (d.seats) console.log(`  좌석 ${d.seats}개`);
    for (const i of d.items.slice(0, 40)) {
      const tag = i.tag + (i.role ? `[${i.role}]` : '');
      console.log(`    ${tag.padEnd(12)} ${i.name}${i.hint ? `  · ${i.hint}` : ''}`);
    }
    if (d.items.length > 40) console.log(`    … 외 ${d.items.length - 40}개`);
  }

  console.log('\n═══ API ═══');
  // 같은 엔드포인트가 여러 번 불린다. 경로별로 한 번만 보여준다.
  const seen = new Set<string>();
  for (const f of apis) {
    const d = read<ApiDump>(f);
    if (!d) continue;
    const key = `${d.method} ${d.path}`;
    if (seen.has(key)) continue;
    seen.add(key);

    console.log(`\n▸ ${d.method} ${d.host}${d.path}  [${d.status}]  (${f})`);
    if (Object.keys(d.query).length) console.log(`  query  ${JSON.stringify(d.query)}`);
    if (d.postData) console.log(`  body   ${clip(JSON.stringify(d.postData), 300)}`);
    console.log(`  응답    ${shape(d.body)}`);
  }
  console.log(`\n화면 ${screens.length}건 · API ${seen.size}종 (${apis.length}회 호출)`);
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

function read<T>(f: string): T | null {
  try {
    return JSON.parse(readFileSync(join(DIR, f), 'utf8')) as T;
  } catch {
    return null;
  }
}

main();
