/**
 * 좌석 점유가 서버에 실제로 반영되는지, 반영된다면 얼마나 유지되는지 잰다.
 *
 * 롯데 결제 화면에는 카운트다운이 없다. 그래서 두 가지를 모른다.
 *   1. 좌석 선택만으로 서버가 남에게 그 자리를 잠그는가?
 *   2. 잠근다면 몇 분 뒤 풀리는가?
 *
 * 둘 다 밖에서 GetSeats 를 찔러보면 알 수 있다. 브라우저에서 좌석을 잡아둔 채
 * 이 스크립트를 돌리면, 그 좌석의 SeatStatusCode 가 변하는지 지켜본다.
 *
 * 회차 목록 보기:
 *   npm run probe -- --theater 1016 --date 20260811
 *
 * 특정 좌석 감시:
 *   npm run probe -- --theater 1016 --date 20260811 --screen 100101 --seq 1 --seat B2
 */
import { createLotteAdapter } from '../src/adapters/lotte/adapter.js';
import { collapseDivisions } from '../src/core/diff.js';
import type { Showtime } from '../src/types.js';

const args = parseArgs(process.argv.slice(2));
const theaterId = args.theater ?? '1016';
const playDate = args.date ?? kstToday();

const lotte = createLotteAdapter([{ chain: 'lotte', theaterId }]);

if (!args.screen || !args.seq) {
  await listShowtimes();
} else {
  await probe();
}

async function listShowtimes(): Promise<void> {
  let rows: Showtime[];
  try {
    rows = collapseDivisions(await lotte.listShowtimes(0, playDate));
  } catch (e) {
    console.error(`\n회차 조회 실패: ${e instanceof Error ? e.message : String(e)}`);
    console.error('지점 ID 와 날짜를 확인하세요. 월드타워는 1016 입니다.\n');
    process.exit(1);
  }
  if (rows.length === 0) {
    console.log(`\n지점 ${theaterId} · ${playDate} 에 회차가 없습니다.\n`);
    return;
  }
  rows.sort((a, b) => a.startTime.localeCompare(b.startTime));

  console.log(`\n지점 ${theaterId} · ${playDate} · ${rows.length}개 회차\n`);
  console.log('  screen    seq  시각    잔여  상영관              영화');
  console.log('  ' + '-'.repeat(72));
  for (const s of rows) {
    console.log(
      `  ${s.screenId.padEnd(9)} ${s.playSequence.padEnd(4)} ${s.startTime}  ` +
        `${String(s.remainingSeats).padStart(4)}  ${s.screenName.padEnd(18)} ${s.movieName}`,
    );
  }
  console.log('\n감시할 회차를 골라 --screen 과 --seq 를 넣고 다시 실행하세요.');
  console.log('  예: npm run probe -- --theater ' + theaterId + ' --date ' + playDate +
              ' --screen <screen> --seq <seq> --seat B2\n');
}

async function probe(): Promise<void> {
  const showtime = {
    chain: 'lotte',
    theaterId,
    screenId: args.screen!,
    playDate,
    playSequence: args.seq!,
  } as Showtime;

  const want = (args.seat ?? '').toUpperCase();
  const intervalSec = Number(args.every ?? 20);

  console.log(`\n감시 시작 · ${theaterId}/${args.screen}/seq${args.seq} · ${intervalSec}초 간격`);
  console.log(want ? `대상 좌석 ${want}` : '대상 좌석 미지정 — 전체 잔여수만 봅니다');
  console.log('브라우저에서 좌석을 잡았다 놓았다 하면서 값이 어떻게 변하는지 보세요.');
  console.log('Ctrl+C 로 종료.\n');

  let prev: { status: string; free: number } | null = null;
  const started = Date.now();

  for (;;) {
    try {
      const map = await lotte.fetchSeatMap(showtime);
      const free = map.seats.filter((s) => s.state === 'free').length;

      const target = want
        ? map.seats.find((s) => `${s.row}${s.col}` === want || s.id.toUpperCase() === want)
        : undefined;
      const status = target ? `${target.state}` : '-';

      const changed = prev && (prev.status !== status || prev.free !== free);
      const mark = changed ? '  ← 변화' : '';
      const elapsed = Math.round((Date.now() - started) / 1000);

      console.log(
        `[${clock()}] +${String(elapsed).padStart(4)}s  ` +
          (want ? `${want} ${status.padEnd(8)}` : '') +
          `잔여 ${String(free).padStart(3)}${mark}`,
      );
      prev = { status, free };
    } catch (e) {
      console.log(`[${clock()}] 조회 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(intervalSec * 1000);
  }
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
  const kst = new Date(Date.now() + 9 * 3600_000);
  return kst.toISOString().slice(0, 10).replace(/-/g, '');
}

function clock(): string {
  return new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Seoul' });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
