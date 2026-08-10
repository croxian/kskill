import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

import { createCgvAdapter } from '../src/adapters/cgv/adapter.js';
import { showtimeRef, type WatchSpec } from '../src/core/spec.js';
import type { Showtime } from '../src/types.js';
import { CGV_THEATERS } from './cgv-theaters.js';

/**
 * 회차를 눈으로 보고 골라서 바로 감시를 시작한다.
 *
 *   npm run pick
 *
 * 왜 로컬에 있나: 설정 화면을 웹 아티팩트로 만들었는데 거기서는 CGV 를
 * 부를 수 없다. 아티팩트는 외부 요청이 전부 막힌 샌드박스다. 그래서 회차를
 * 보여줄 수가 없고, 사용자는 상영관 번호와 회차 순번을 어디선가 찾아
 * 손으로 적어야 했다.
 *
 * 여기서는 실제로 부를 수 있다. 지점과 날짜만 고르면 그날 회차를 다 보여주고,
 * 고른 것으로 설정을 써서 감시까지 이어 붙인다. 붙여넣기 단계가 사라진다.
 *
 * 요청은 지점·날짜당 한 번. 감시기가 쓰는 것과 같은 엔드포인트다.
 */

const CONFIG = 'watch.json';

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\nCGV 빈자리 감시 — 회차 고르기\n');

    const theater = await askTheater(rl);
    const date = await askDate(rl);

    console.log(`\n${theater.name} · ${fmtDate(date)} 회차를 불러옵니다…`);
    const all = await fetchShowtimes(theater.code, date);
    if (all.length === 0) {
      console.log('회차가 없습니다. 날짜를 다시 확인해 주세요.');
      return;
    }

    const shown = show(all);
    const picked = await askPicks(rl, shown);
    if (picked.length === 0) {
      console.log('고른 회차가 없습니다.');
      return;
    }

    const spec = buildSpec(theater, date, picked);
    writeFileSync(CONFIG, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');

    console.log(`\n${CONFIG} 을 만들었습니다.`);
    console.log(`  회차 ${picked.length}개 · 요청 1건/주기 · 최대 ${budget(spec)}회/시간`);
    for (const s of picked) {
      console.log(`  ${s.startTime} ${s.screenName} · ${s.movieName}`);
    }

    const go = await rl.question('\n지금 감시를 시작할까요? [Y/n] ');
    if (go.trim().toLowerCase() === 'n') {
      console.log(`나중에 시작하시려면:  npm run watch -- ${CONFIG}`);
      return;
    }
    rl.close();
    await runWatcher();
  } finally {
    rl.close();
  }
}

/* ── 묻기 ─────────────────────────────────────────────── */

async function askTheater(rl: Interface): Promise<{ code: string; name: string }> {
  CGV_THEATERS.forEach((t, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${t.name}`);
  });
  console.log('   0. 직접 입력 (지점 코드 4자리)');

  for (;;) {
    const a = (await rl.question('\n지점 [1] ')).trim() || '1';
    if (a === '0') {
      const code = (await rl.question('지점 코드: ')).trim();
      if (/^\d{4}$/.test(code)) return { code, name: `지점 ${code}` };
      console.log('  네 자리 숫자여야 합니다.');
      continue;
    }
    const t = CGV_THEATERS[Number(a) - 1];
    if (t) return { code: t.code, name: t.name };
    console.log('  목록에 없는 번호입니다.');
  }
}

async function askDate(rl: Interface): Promise<string> {
  const days = Array.from({ length: 7 }, (_, i) => addDays(today(), i));
  days.forEach((d, i) => {
    const tag = i === 0 ? ' (오늘)' : i === 1 ? ' (내일)' : '';
    console.log(`  ${String(i + 1).padStart(2)}. ${fmtDate(d)}${tag}`);
  });

  for (;;) {
    const a = (await rl.question('\n날짜 [1] ')).trim() || '1';
    const d = days[Number(a) - 1];
    if (d) return d;
    if (/^\d{8}$/.test(a)) return a;
    console.log('  1~7 중에서 고르거나 YYYYMMDD 로 입력하세요.');
  }
}

/**
 * 고르기.
 *
 * 번호를 쉼표로 여러 개, 또는 상영관 이름 조각으로 한꺼번에.
 * 매진된 회차만 보는 게 보통이라 그것도 한 글자로 받는다.
 */
async function askPicks(rl: Interface, list: Showtime[]): Promise<Showtime[]> {
  console.log('\n  번호를 쉼표로 (1,3,5) · 이름 조각으로 (imax) · 매진만 (s) · 전부 (a)');
  const a = (await rl.question('회차 ')).trim() || 's';

  if (a.toLowerCase() === 'a') return list;
  if (a.toLowerCase() === 's') return list.filter((s) => s.remainingSeats === 0);

  const nums = a
    .split(/[,\s]+/)
    .map((x: string) => Number(x))
    .filter((n: number) => Number.isInteger(n) && n >= 1 && n <= list.length);
  if (nums.length > 0) return nums.map((n) => list[n - 1]!);

  // 숫자가 아니면 상영관 이름으로 본다
  const re = new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  return list.filter((s) => re.test(s.screenName));
}

/* ── 보여주기 ─────────────────────────────────────────── */

function show(all: Showtime[]): Showtime[] {
  const sorted = [...all].sort(
    (a, b) => a.startTime.localeCompare(b.startTime) || a.screenName.localeCompare(b.screenName),
  );
  console.log('');
  sorted.forEach((s, i) => {
    const n = String(i + 1).padStart(3);
    const seats =
      s.remainingSeats === 0
        ? '   매진'
        : `${String(s.remainingSeats).padStart(4)}석`;
    console.log(
      `  ${n}. ${s.startTime}  ${seats} /${String(s.totalSeats).padEnd(4)} ` +
        `${s.screenName.padEnd(16)} ${s.movieName}`,
    );
  });
  const soldOut = sorted.filter((s) => s.remainingSeats === 0).length;
  console.log(`\n  회차 ${sorted.length} · 매진 ${soldOut}`);
  return sorted;
}

/* ── 설정 ─────────────────────────────────────────────── */

function buildSpec(
  theater: { code: string; name: string },
  date: string,
  picked: Showtime[],
): WatchSpec {
  // 감시는 판매가 끝날 때까지. CGV 는 상영 시작 15분 뒤까지 판다.
  const lastEnd = [...picked]
    .map((s) => s.salesEndAt ?? s.startTime)
    .sort()
    .at(-1)!;
  return {
    id: `cgv-${theater.code}-${date}`,
    theaters: [{ chain: 'cgv' as const, theaterId: theater.code, label: theater.name }],
    movies: [],
    dates: [date],
    windows: [],
    showtimes: picked.map(showtimeRef),
    block: null,
    party: { mode: 'single', size: 1 },
    action: 'notify',
    pollFloorSec: 45,
    // 매진된 특별관은 사흘 전에 난 자리도 즉시 사라진다. 남은 시간과
    // 무관하게 자주 본다. 회차를 좁혔으니 요청은 여전히 1건/주기다.
    maxIntervalSec: 60,
    maxAlertsPerRun: 5,
    expiresAt: watchUntil(date, lastEnd),
  };
}

/** 시간당 최대 요청 수. 사용자가 자기 부담을 알고 있어야 한다. */
function budget(spec: WatchSpec): number {
  const pairs = spec.theaters.length * spec.dates.length;
  const sec = Math.max(spec.pollFloorSec, Math.min(spec.maxIntervalSec ?? 1800, 1800));
  return Math.round((pairs * 3600) / sec);
}

/* ── 실행 ─────────────────────────────────────────────── */

/**
 * 감시기를 띄운다.
 *
 * npm 을 셸로 부르면 Windows 에서 DEP0190 경고가 뜬다 — shell: true 와
 * 인자 배열을 함께 쓰면 인자가 이스케이프되지 않고 이어붙기만 한다.
 * node 를 직접 띄우고 tsx 를 로더로 물리면 셸이 끼지 않는다.
 */
function runWatcher(): Promise<void> {
  console.log('');
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--env-file-if-exists=.env', 'src/main.ts', CONFIG],
      { stdio: 'inherit' },
    );
    child.on('close', () => resolve());
  });
}

async function fetchShowtimes(theaterCode: string, date: string): Promise<Showtime[]> {
  const adapter = createCgvAdapter([{ chain: 'cgv', theaterId: theaterCode }]);
  try {
    return await adapter.listShowtimes(0, date);
  } finally {
    await adapter.close();
  }
}

/* ── 날짜 ─────────────────────────────────────────────── */

const KST = 9 * 3_600_000;

function today(): string {
  return new Date(Date.now() + KST).toISOString().slice(0, 10).replace(/-/g, '');
}

function addDays(ymd: string, n: number): string {
  const t = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
}

function fmtDate(ymd: string): string {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  const w = ['일', '월', '화', '수', '목', '금', '토'][d.getUTCDay()];
  return `${+ymd.slice(4, 6)}월 ${+ymd.slice(6, 8)}일(${w})`;
}

/**
 * 마지막 판매 종료 + 5분. 회차별 중단은 감시기가 salesEndAt 으로 지키고,
 * 이건 그 바깥을 감싸는 안전장치다.
 */
function watchUntil(ymd: string, lastSalesEnd: string): string {
  const base = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) - 9 * 3_600_000;
  const [h = '23', m = '59'] = lastSalesEnd.split(':');
  return new Date(base + (+h * 60 + +m + 5) * 60_000).toISOString();
}

type Interface = ReturnType<typeof createInterface>;

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
