/**
 * CGV 좌석 화면의 DOM 을 분석한다.
 *
 * 좌석 상태를 class 로 구분하는지 title 로 구분하는지, 판매완료 좌석은
 * 어떤 값을 갖는지 — 한 번에 확인한다. outerHTML 을 하나씩 복사해
 * 주고받는 것보다 이쪽이 빠르다.
 *
 *   npm run cgv:seats
 *
 * 브라우저가 열리면 **좌석 선택 화면까지 직접 이동**한 뒤,
 * 이 터미널에서 Enter 를 누르세요. 예매를 끝까지 진행할 필요는 없습니다.
 */
import { createInterface } from 'node:readline/promises';

import { readRawSeats, splitLabel, type RawCgvSeat } from '../src/adapters/cgv/seatmap.js';

const { chromium } = await import('playwright');

const ctx = await chromium.launchPersistentContext('.profile', {
  headless: false,
  viewport: null,
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('https://cgv.co.kr/', { waitUntil: 'domcontentloaded' });

console.log('\n브라우저에서 좌석 선택 화면까지 이동한 뒤 여기서 Enter 를 누르세요.');
console.log('(예매를 끝까지 진행할 필요는 없습니다)\n');

const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question('');
rl.close();

const seats = await readRawSeats(page);

if (seats.length === 0) {
  console.log('좌석 요소를 못 찾았습니다. 좌석 화면이 맞는지 확인해 주세요.');
  console.log('(찾는 선택자: [data-seatlocno])');
  await ctx.close();
  process.exit(1);
}

console.log(`\n좌석 ${seats.length}개\n`);

// ── class 조합별 분포 ────────────────────────────────────────
// 해시 접미어(__JHck5)는 빌드마다 바뀌므로 떼고 센다.
const byClass = group(seats, (s) =>
  s.className
    .split(/\s+/)
    .filter(Boolean)
    .map((c) => c.replace(/__[A-Za-z0-9_-]+$/, ''))
    .sort()
    .join(' '),
);
console.log('class 조합별 좌석 수 (해시 접미어 제거):');
for (const [key, list] of sorted(byClass)) {
  console.log(`  ${String(list.length).padStart(4)}개  ${key}`);
  console.log(`        예: ${list.slice(0, 6).map((s) => s.label).join(', ')}`);
}

// ── title 별 분포 ────────────────────────────────────────────
console.log('\ntitle 별 좌석 수:');
for (const [key, list] of sorted(group(seats, (s) => s.title || '(없음)'))) {
  console.log(`  ${String(list.length).padStart(4)}개  "${key}"`);
}

// ── disabled 여부 ────────────────────────────────────────────
const disabled = seats.filter((s) => s.disabled).length;
console.log(`\ndisabled 속성: ${disabled}개 / ${seats.length}개`);

// ── 좌표로 통로 찾기 ─────────────────────────────────────────
// 롯데의 SeatColumGroupNo 같은 게 CGV 엔 없다. 픽셀 간격으로 끊어야 한다.
const rows = group(seats, (s) => splitLabel(s.label).row);
const sample = [...rows.entries()].sort((a, b) => b[1].length - a[1].length)[0];
if (sample) {
  const [row, list] = sample;
  list.sort((a, b) => a.x - b.x);
  console.log(`\n가장 긴 행 ${row} 의 x 간격:`);
  const gaps: number[] = [];
  for (let i = 1; i < list.length; i++) gaps.push(list[i]!.x - list[i - 1]!.x);
  console.log('  ' + gaps.join(', '));
  const uniq = [...new Set(gaps)].sort((a, b) => a - b);
  console.log(`  서로 다른 간격: ${uniq.join(', ')}  ← 큰 값이 통로`);
}

console.log('\n좌석 하나 원본:');
console.log(JSON.stringify(seats[0], null, 2));

await ctx.close();

function group<T>(list: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const item of list) {
    const k = key(item);
    const bucket = m.get(k);
    if (bucket) bucket.push(item);
    else m.set(k, [item]);
  }
  return m;
}
function sorted(m: Map<string, RawCgvSeat[]>): Array<[string, RawCgvSeat[]]> {
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
}
