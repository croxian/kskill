/**
 * CGV 원본 응답을 그대로 본다.
 *
 * daiso 는 응답 필드를 골라 버린다 — 상영관 이름 같은 게 사라진다.
 * IMAX 를 좌석 수(624)로 추측하지 않으려면 원본에 무엇이 있는지 알아야 한다.
 *
 *   npm run cgv -- --theater 0013 --date 20260814
 *   npm run cgv -- --theater 0013 --date 20260814 --movie 30001323
 *
 * 지점 코드: 용산아이파크몰 0013 · 영등포타임스퀘어 0059 · 씨네드쉐프 용산 P013
 */
import { writeFileSync } from 'node:fs';

import { CgvBrowserClient } from '../src/adapters/cgv/browser.js';
import { fetchSiteTimetable } from '../src/adapters/cgv/client.js';
import type { CgvScnItem } from '../src/adapters/cgv/api.js';

const args = parseArgs(process.argv.slice(2));
const theaterCode = args.theater ?? '0013';
const playDate = args.date ?? kstToday();

/**
 * 직접 호출을 먼저 시도하고, 막히면 브라우저로 넘어간다.
 * 어느 쪽이 통하는지가 CGV 어댑터의 설계를 가른다.
 */
let items: CgvScnItem[] = [];
let via = '직접 호출';
const browser = new CgvBrowserClient({ headless: true });

try {
  items = await fetchSiteTimetable({ theaterCode, playDate });
  console.log('직접 호출 성공 — 브라우저 없이 폴링할 수 있습니다.');
} catch (e) {
  console.log(`직접 호출 실패 (${e instanceof Error ? e.message : String(e)}) — 브라우저로 재시도합니다.`);
  try {
    items = await browser.siteTimetable(theaterCode, playDate);
    via = '브라우저';
    console.log('브라우저 경로 성공.');
  } catch (e2) {
    console.error(`브라우저도 실패: ${e2 instanceof Error ? e2.message : String(e2)}`);
    console.error('npm run browser 로 chromium 을 설치했는지 확인하세요.');
    await browser.close();
    process.exit(1);
  }
}
await browser.close();

if (items.length === 0) {
  console.log('회차가 없습니다. 지점 코드와 날짜를 확인하세요.');
  process.exit(0);
}

console.log(`\n${theaterCode} · ${playDate} · ${items.length}개 회차 · 경로: ${via}\n`);

// ── 1. 원본에 어떤 필드가 있는가 ──────────────────────────────
const keys = [...new Set(items.flatMap((i) => Object.keys(i)))].sort();
console.log('원본 필드 전체:');
console.log('  ' + keys.join(', '));

console.log('\n첫 회차 원본:');
console.log(JSON.stringify(items[0], null, 2));

// ── 2. 상영관을 구분할 만한 필드 찾기 ─────────────────────────
// IMAX·4DX 같은 특별관 이름이 어딘가 들어 있으면 좌석 수로 추측할 필요가 없다.
const special = keys.filter((k) => {
  const values = items.map((i) => i[k]).filter((v) => typeof v === 'string') as string[];
  return values.some((v) => /IMAX|4DX|SCREENX|SPHERE|GOLD|PRIVATE|LASER/i.test(v));
});
console.log('\n특별관 이름이 들어 있는 필드:');
console.log(special.length ? '  ' + special.join(', ') : '  없음 — 좌석 수로 구분해야 함');

// ── 3. 좌석 수별 분포 ────────────────────────────────────────
const bySize = new Map<number, number>();
for (const i of items) {
  const n = Number(i.stcnt ?? 0);
  bySize.set(n, (bySize.get(n) ?? 0) + 1);
}
console.log('\n좌석 수별 회차 수 (상영관 지문):');
for (const [size, count] of [...bySize].sort((a, b) => b[0] - a[0])) {
  console.log(`  ${String(size).padStart(4)}석 → ${count}회차`);
}

// ── 4. 큰 관(IMAX 후보) 회차만 ───────────────────────────────
const biggest = Math.max(...items.map((i) => Number(i.stcnt ?? 0)));
console.log(`\n최대 상영관 ${biggest}석 회차:`);
for (const i of items.filter((x) => Number(x.stcnt) === biggest)) {
  console.log(
    `  ${fmt(i.scnsrtTm)}  잔여 ${String(i.frSeatCnt ?? '?').padStart(4)} / ${biggest}  ` +
      `${i.movNm ?? i.prodNm ?? ''}`,
  );
}

const out = `fixtures/cgv-${theaterCode}-${playDate}.json`;
writeFileSync(out, JSON.stringify(items, null, 2), 'utf8');
console.log(`\n원본 저장: ${out}`);

function fmt(t: unknown): string {
  const s = String(t ?? '');
  return s.length >= 4 ? `${s.slice(0, 2)}:${s.slice(2, 4)}` : s;
}
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1] ?? '';
  }
  return out;
}
function kstToday(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
}
