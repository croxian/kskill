import { CgvBrowserClient } from '../src/adapters/cgv/browser.js';
import { fetchSiteTimetable } from '../src/adapters/cgv/client.js';
import { parseCgvTimetable } from '../src/adapters/cgv/parse.js';
import { parseSeatData } from '../src/adapters/cgv/web-parse.js';
import { renderSeatMapText } from '../src/notify/render.js';

/**
 * 좌석 API 를 실제로 불러 본다.
 *
 *   npx tsx scripts/cgv-seatdata.ts --theater 0059 --date 20260814
 *   npx tsx scripts/cgv-seatdata.ts --theater 0013 --date 20260814 --screen IMAX
 *
 * 확인하려는 것은 셋이다.
 *   1. custNo 없이도 좌석이 오는가 — 오면 계정 식별자를 안 들고 다녀도 된다
 *   2. 빈자리 판정이 맞는가 — 좌석맵의 빈자리 수와 회차 잔여수가 같아야 한다
 *   3. 통로 구획이 그럴듯한가
 *
 * 2번이 어긋나면 감시기에 붙이면 안 된다. 없는 자리를 알리게 된다.
 *
 * ⚠️ 2026-08-10, 이 스크립트가 부르는 좌석 API 를 반복 시도하다가 CGV 에
 * 차단당했다. 감시기는 이 경로를 쓰지 않는다 — 잔여수만 본다.
 * 그래서 실수로 돌아가면 안 된다. --i-know 를 붙여야만 실행된다.
 */

const CONSENT = `⚠️  이 스크립트는 CGV 좌석 API 를 직접 부릅니다.

    2026-08-10 에 바로 이 경로를 반복 호출하다가 IP 가 차단됐습니다.
    감시기(npm run watch)는 이 경로를 쓰지 않습니다 — 잔여수만 봅니다.

    그래도 돌리시려면:  npm run cgv:seatdata -- --i-know --theater 0059
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.iKnow) {
    console.error(CONSENT);
    process.exit(1);
  }
  const theater = args.theater ?? '0059';
  const date = args.date ?? today();

  const showtimes = await listShowtimes(theater, date);
  if (showtimes.length === 0) {
    console.error(`회차가 없습니다. 지점 ${theater} · ${date}`);
    process.exit(1);
  }

  const wanted = args.screen
    ? showtimes.filter((s) => s.screenName.includes(args.screen!))
    : showtimes;
  const target = wanted.find((s) => s.remainingSeats > 0) ?? wanted[0];
  if (!target) {
    console.error(`'${args.screen}' 이 들어간 상영관이 없습니다.`);
    console.error(`  있는 상영관: ${[...new Set(showtimes.map((s) => s.screenName))].join(', ')}`);
    process.exit(1);
  }

  console.log(`${target.movieName} · ${target.screenName} · ${target.startTime}`);
  console.log(`  회차가 말하는 잔여: ${target.remainingSeats} / ${target.totalSeats}\n`);

  const browser = new CgvBrowserClient({ headless: !args.show });
  try {
    // 손으로 넣지 않아도 되도록 로그인된 세션에서 찾아본다.
    const found = args.cust ?? (await browser.findCustNo());
    console.log(found ? `custNo 를 세션에서 찾았습니다 (${mask(found)})\n` : 'custNo 를 못 찾았습니다\n');

    // custNo 없이 먼저. 되면 계정 식별자를 아예 안 들고 다녀도 된다.
    for (const custNo of [undefined, found ?? undefined]) {
      if (custNo === undefined) console.log('── custNo 없이 ──');
      else console.log('\n── custNo 를 넣고 ──');

      let res;
      try {
        res = await browser.seatData({
          theaterCode: target.theaterId,
          playDate: target.playDate,
          screenNo: target.screenId,
          scnSseq: target.playSequence,
          ...(custNo ? { custNo } : {}),
        });
      } catch (err) {
        console.error(`  실패: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const map = parseSeatData(res, {
        theaterId: target.theaterId,
        screenId: target.screenId,
        playDate: target.playDate,
        playSequence: target.playSequence,
      });

      const free = map.seats.filter((s) => s.state === 'free').length;
      const held = map.seats.filter((s) => s.state === 'held').length;
      const sold = map.seats.filter((s) => s.state === 'sold').length;
      const blocked = map.seats.filter((s) => s.state === 'blocked').length;
      const groups = new Set(map.seats.map((s) => `${s.row}:${s.group}`)).size;

      console.log(`  좌석 ${map.seats.length} · 빈 ${free} · 점유 ${held} · 판매 ${sold} · 제외 ${blocked}`);
      console.log(`  줄 ${new Set(map.seats.map((s) => s.row)).size} · 통로로 나뉜 구획 ${groups}`);

      // ── 가장 중요한 줄 ──────────────────────────────────
      const ok = free === target.remainingSeats;
      console.log(
        ok
          ? `  ✅ 잔여수 일치 (${free})`
          : `  ❌ 잔여수 불일치 — 좌석맵 ${free} vs 회차 ${target.remainingSeats}`,
      );
      if (!ok) {
        console.log('     빈자리 판정 규칙이 틀렸습니다. 감시기에 붙이면 안 됩니다.');
        console.log(`     상태 코드 분포: ${JSON.stringify(distribution(res))}`);
      }

      if (args.map && map.seats.length > 0) console.log(`\n${renderSeatMapText(map)}`);
      // 첫 시도가 통했으면 두 번째는 볼 이유가 없다.
      if (ok) break;
    }
  } finally {
    await browser.close();
  }
}

/** 계정 식별자는 화면에 통째로 찍지 않는다. 찾았다는 것만 보이면 된다. */
function mask(s: string): string {
  return s.length <= 4 ? '****' : `${s.slice(0, 3)}…${s.slice(-2)}`;
}

/** 어긋났을 때 무엇을 잘못 읽었는지 알아야 한다. */
function distribution(res: unknown): Record<string, number> {
  const seats = (res as { data?: { items?: { seats?: Record<string, unknown>[] }[] } }).data?.items?.flatMap(
    (i) => i.seats ?? [],
  );
  const out: Record<string, number> = {};
  for (const s of seats ?? []) {
    const key = `stus=${String(s['seatStusCd'])} sale=${String(s['seatSaleYn'])} knd=${String(s['stkndCd'])} sal=${s['salNo'] ? 'Y' : 'N'} atkt=${s['movAtktNo'] ? 'Y' : 'N'}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

async function listShowtimes(theater: string, date: string) {
  try {
    return parseCgvTimetable(await fetchSiteTimetable({ theaterCode: theater, playDate: date }));
  } catch {
    // 직접 호출이 막히면 브라우저로. 어차피 곧 띄운다.
    const b = new CgvBrowserClient({ headless: true });
    try {
      return parseCgvTimetable(await b.siteTimetable(theater, date));
    } finally {
      await b.close();
    }
  }
}

function parseArgs(argv: string[]) {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    theater: get('theater'),
    date: get('date'),
    screen: get('screen'),
    cust: get('cust'),
    iKnow: argv.includes('--i-know'),
    map: argv.includes('--map'),
    show: argv.includes('--show'),
  };
}

function today(): string {
  const d = new Date(Date.now() + 9 * 3_600_000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
