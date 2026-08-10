import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import type { LotteResponse } from '../src/adapters/lotte/client.js';
import { parseSeatMap } from '../src/adapters/lotte/parse.js';
import { STOP } from '../src/core/poll.js';
import type { WatchSpec } from '../src/core/spec.js';
import type { Showtime } from '../src/types.js';
import { Watcher, type Alert, type WatchDeps } from '../src/watch/loop.js';

const raw = JSON.parse(
  readFileSync(new URL('./fixtures/lotte-worldtower-9gwan-seq4.json', import.meta.url), 'utf8'),
) as LotteResponse;

const MAP = parseSeatMap(raw, {
  theaterId: '1016',
  screenId: '101609',
  playDate: '20260809',
  playSequence: '4',
});

/** 회차(19:10 KST = 10:10 UTC)보다 2시간 10분 앞 */
const NOW = Date.parse('2026-08-09T08:00:00Z');

const SPEC: WatchSpec = {
  id: 'w1',
  theaters: [{ chain: 'lotte', theaterId: '1016' }],
  movies: [],
  dates: ['20260809'],
  windows: [],
  block: null,
  party: { mode: 'adjacent', size: 2 },
  action: 'notify',
  pollFloorSec: 30,
  expiresAt: '2026-08-10T00:00:00Z',
};

function showtime(over: Partial<Showtime> = {}): Showtime {
  return {
    chain: 'lotte',
    theaterId: '1016',
    theaterName: '월드타워',
    movieId: '24128',
    movieName: '오디세이',
    screenId: '101609',
    screenName: '9관',
    playDate: '20260809',
    playSequence: '4',
    startTime: '19:10',
    divisionCode: '100',
    totalSeats: 342,
    remainingSeats: 6,
    ...over,
  };
}

interface Harness {
  deps: WatchDeps;
  alerts: Alert[];
  listShowtimes: ReturnType<typeof vi.fn>;
  fetchSeatMap: ReturnType<typeof vi.fn>;
  errors: Array<[string, string]>;
  setRows(rows: Showtime[]): void;
  setNow(t: number): void;
  /** 폴링 사이에 시간을 흘린다. 짝마다 다음 조회 시각이 따로 있다. */
  tick(ms?: number): void;
}

function harness(rows: Showtime[] = [showtime()]): Harness {
  let current = rows;
  let now = NOW;
  const alerts: Alert[] = [];
  const errors: Array<[string, string]> = [];

  const listShowtimes = vi.fn(async () => current);
  const fetchSeatMap = vi.fn(async () => MAP);

  return {
    alerts,
    errors,
    listShowtimes,
    fetchSeatMap,
    setRows: (r) => { current = r; },
    setNow: (t) => { now = t; },
    tick: (ms = 60_000) => { now += ms; },
    deps: {
      listShowtimes,
      fetchSeatMap,
      notify: async (a) => { alerts.push(a); },
      now: () => now,
      onError: (stage, _err, ctx) => { errors.push([stage, ctx]); },
    },
  };
}

/**
 * 한 번의 폴링.
 *
 * 감시기는 지점·날짜 짝마다 다음 조회 시각을 따로 잡는다. 시계를 멈춰두고
 * 두 번 부르면 두 번째에는 아무것도 조회하지 않는다 — 실제로도 그렇게
 * 동작해야 맞다. 그래서 폴링 사이에 시간을 흘린다.
 */
async function poll(w: Watcher, h: Harness) {
  h.tick();
  return w.runOnce();
}

describe('Watcher — 첫 관측', () => {
  it('시작하자마자 현재 빈자리를 알려준다', async () => {
    const h = harness();
    const w = new Watcher(SPEC, h.deps);

    const res = await poll(w, h);

    expect(res.alerts).toHaveLength(1);
    expect(res.alerts[0]!.candidate!.seats.map((s) => `${s.row}${s.col}`)).toEqual(['J10', 'J11']);
  });

  it('baseline 으로 시작하면 기준만 잡고 조용히 있는다', async () => {
    const h = harness();
    const w = new Watcher(SPEC, h.deps, { coldStart: 'baseline' });

    const res = await poll(w, h);

    expect(res.alerts).toHaveLength(0);
    expect(h.fetchSeatMap).not.toHaveBeenCalled();
  });
});

describe('Watcher — 변화 감지', () => {
  it('잔여석이 그대로면 좌석맵을 뜯지 않는다', async () => {
    const h = harness();
    const w = new Watcher(SPEC, h.deps, { coldStart: 'baseline' });

    await poll(w, h);
    const res = await poll(w, h);

    expect(res.targets).toBe(0);
    expect(h.fetchSeatMap).not.toHaveBeenCalled();
  });

  it('잔여석이 늘면 2단으로 넘어간다', async () => {
    const h = harness([showtime({ remainingSeats: 4 })]);
    const w = new Watcher(SPEC, h.deps, { coldStart: 'baseline' });

    await poll(w, h);
    h.setRows([showtime({ remainingSeats: 6 })]); // 취소표 발생
    const res = await poll(w, h);

    expect(res.targets).toBe(1);
    expect(res.alerts).toHaveLength(1);
  });

  it('잔여석이 줄면 무시한다 — 남이 예매한 것이다', async () => {
    const h = harness([showtime({ remainingSeats: 6 })]);
    const w = new Watcher(SPEC, h.deps, { coldStart: 'baseline' });

    await poll(w, h);
    h.setRows([showtime({ remainingSeats: 2 })]);
    const res = await poll(w, h);

    expect(res.targets).toBe(0);
  });

  it('매진된 회차는 좌석맵을 조회하지 않는다', async () => {
    const h = harness([showtime({ remainingSeats: 0 })]);
    const w = new Watcher(SPEC, h.deps);

    const res = await poll(w, h);

    expect(res.targets).toBe(0);
    expect(h.fetchSeatMap).not.toHaveBeenCalled();
  });
});

describe('Watcher — 구역 합치기', () => {
  /** 같은 회차가 일반석·리클라이너 두 행으로 와도 좌석맵은 한 번만 뜯는다. */
  it('구역이 쪼개져 와도 GetSeats 는 한 번', async () => {
    const h = harness([
      showtime({ divisionCode: '100', totalSeats: 342, remainingSeats: 6 }),
      showtime({ divisionCode: '960', totalSeats: 18, remainingSeats: 0 }),
    ]);
    const w = new Watcher(SPEC, h.deps);

    const res = await poll(w, h);

    expect(res.polled).toBe(1);
    expect(h.fetchSeatMap).toHaveBeenCalledTimes(1);
  });
});

describe('Watcher — 중복 억제', () => {
  it('같은 좌석으로 연달아 알리지 않는다', async () => {
    const h = harness([showtime({ remainingSeats: 4 })]);
    const w = new Watcher(SPEC, h.deps, { coldStart: 'baseline', cooldownMs: 180_000 });

    await poll(w, h);
    h.setRows([showtime({ remainingSeats: 6 })]);
    const first = await poll(w, h);

    h.setRows([showtime({ remainingSeats: 8 })]); // 또 늘었지만 좌석은 그대로
    const second = await poll(w, h);

    expect(first.alerts).toHaveLength(1);
    expect(second.targets).toBe(1); // 2단까지는 갔지만
    expect(second.alerts).toHaveLength(0); // 알림은 눌렸다
  });

  it('쿨다운이 지나면 다시 알린다', async () => {
    const h = harness([showtime({ remainingSeats: 4 })]);
    const w = new Watcher(SPEC, h.deps, { coldStart: 'baseline', cooldownMs: 60_000 });

    await poll(w, h);
    h.setRows([showtime({ remainingSeats: 6 })]);
    await poll(w, h);

    h.setNow(NOW + 120_000);
    h.setRows([showtime({ remainingSeats: 8 })]);
    const res = await poll(w, h);

    expect(res.alerts).toHaveLength(1);
  });
});

describe('Watcher — 실패와 종료', () => {
  it('조회가 깨져도 삼키지 않고 알린 뒤 계속 돈다', async () => {
    const h = harness();
    h.listShowtimes.mockRejectedValueOnce(new Error('HTTP 500'));
    const w = new Watcher(SPEC, h.deps);

    const res = await poll(w, h);

    expect(h.errors).toEqual([['1단', 'theater[0] 20260809']]);
    expect(res.polled).toBe(0);
  });

  /**
   * 조회 실패로 회차 목록이 빈 것과, 감시할 회차가 정말 없는 것은 다르다.
   * 구분하지 않으면 잠깐의 네트워크 장애로 감시가 조용히 끝난다.
   */
  it('조회가 전부 실패하면 종료하지 않고 물러섰다 재시도한다', async () => {
    const h = harness();
    h.listShowtimes.mockRejectedValue(new Error('HTTP 403'));
    const w = new Watcher(SPEC, h.deps);

    const res = await poll(w, h);

    expect(res.offline).toBe(true);
    expect(res.polled).toBe(0);
    expect(res.nextWakeMs).toBeGreaterThan(0);
  });

  it('회차가 정말 없으면 종료한다', async () => {
    const h = harness([]);
    const w = new Watcher(SPEC, h.deps);

    const res = await poll(w, h);

    expect(res.offline).toBe(false);
    expect(res.nextWakeMs).toBe(STOP);
  });

  it('만료 뒤에는 조회가 실패해도 재시도하지 않는다', async () => {
    const h = harness();
    h.listShowtimes.mockRejectedValue(new Error('HTTP 403'));
    h.setNow(Date.parse('2026-08-11T00:00:00Z'));
    const w = new Watcher(SPEC, h.deps);

    expect((await poll(w, h)).nextWakeMs).toBe(STOP);
  });

  it('좌석맵 조회가 깨지면 그 회차만 건너뛴다', async () => {
    const h = harness();
    h.fetchSeatMap.mockRejectedValueOnce(new Error('timeout'));
    const w = new Watcher(SPEC, h.deps);

    const res = await poll(w, h);

    expect(h.errors[0]![0]).toBe('2단');
    expect(res.alerts).toHaveLength(0);
  });

  it('상영 30분 안쪽 회차는 감시 대상에서 빠진다', async () => {
    const h = harness();
    h.setNow(Date.parse('2026-08-09T09:50:00Z')); // 상영 20분 전
    const w = new Watcher(SPEC, h.deps);

    const res = await poll(w, h);

    expect(res.polled).toBe(0);
    expect(res.nextWakeMs).toBe(STOP);
  });

  it('만료시각이 지나면 다음 깨어남이 없다', async () => {
    const h = harness();
    h.setNow(Date.parse('2026-08-11T00:00:00Z'));
    const w = new Watcher(SPEC, h.deps);

    expect(w.expired).toBe(true);
    expect((await poll(w, h)).nextWakeMs).toBe(STOP);
  });
});

describe('Watcher — 알림 상한', () => {
  /**
   * 첫 폴링은 전 회차를 훑는다. 조건이 넓으면 수십 건이 한꺼번에 나가고,
   * 40번 울리는 알림은 아무도 읽지 않는다.
   */
  const many = () =>
    harness(
      Array.from({ length: 12 }, (_, i) =>
        showtime({ playSequence: String(i + 1), remainingSeats: 6 }),
      ),
    );

  it('한 번에 보내는 알림을 상한까지만 보낸다', async () => {
    const h = many();
    const w = new Watcher({ ...SPEC, maxAlertsPerRun: 3 }, h.deps);

    const res = await poll(w, h);

    expect(res.alerts).toHaveLength(3);
    expect(res.suppressed).toBe(9);
  });

  it('상한을 넘으면 좌석맵 조회조차 하지 않는다', async () => {
    const h = many();
    const w = new Watcher({ ...SPEC, maxAlertsPerRun: 3 }, h.deps);

    await poll(w, h);

    expect(h.fetchSeatMap).toHaveBeenCalledTimes(3);
  });

  /**
   * 취소표는 사건이므로, 상한에 잘렸다고 버리면 안 된다.
   * 다음 폴링에서 잔여석 변화와 무관하게 다시 확인한다.
   */
  it('취소표가 상한에 잘리면 다음 폴링에서 다시 후보가 된다', async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      showtime({ playSequence: String(i + 1), remainingSeats: 4 }),
    );
    const h = harness(rows);
    const w = new Watcher({ ...SPEC, maxAlertsPerRun: 3 }, h.deps, { coldStart: 'baseline' });

    await poll(w, h); // 기준만 잡는다
    h.setRows(rows.map((r) => ({ ...r, remainingSeats: 6 }))); // 전 회차에 취소표
    const first = await poll(w, h);

    h.setNow(NOW + 60_000);
    const second = await poll(w, h);

    expect(first.alerts).toHaveLength(3);
    expect(first.suppressed).toBe(9);
    // 지문을 남기지 않았으므로 쿨다운에 걸리지 않는다
    expect(second.alerts).toHaveLength(3);
    expect(second.alerts[0]!.showtime.playSequence).toBe('4');
  });

  /**
   * 첫 폴링은 "지금 뭐가 있나" 를 보여주는 목록이지 사건이 아니다.
   * 조건이 넓으면 시작 시점의 재고가 수백 건인데, 그걸 다 넘기면
   * 몇십 분에 걸쳐 찔끔찔끔 알림이 나온다.
   */
  it('첫 폴링에서 잘린 것은 넘기지 않는다', async () => {
    const h = many();
    const w = new Watcher({ ...SPEC, maxAlertsPerRun: 3 }, h.deps);

    const first = await poll(w, h);
    h.setNow(NOW + 60_000);
    const second = await poll(w, h);

    expect(first.alerts).toHaveLength(3);
    expect(first.suppressed).toBe(9);
    expect(second.alerts).toHaveLength(0); // 변화가 없으면 조용하다
  });

  it('상한을 안 주면 기본값 5', async () => {
    const h = many();
    const w = new Watcher(SPEC, h.deps);

    expect((await poll(w, h)).alerts).toHaveLength(5);
  });
});

describe('Watcher — 좌석 확보 모드', () => {
  /** 동시 홀드 1건 규칙. 여러 회차가 동시에 열려도 하나만 잡는다. */
  it('hold 모드는 첫 후보에서 멈춘다', async () => {
    const h = harness([
      showtime({ playSequence: '4', remainingSeats: 6 }),
      showtime({ playSequence: '5', startTime: '22:40', remainingSeats: 215 }),
    ]);
    const w = new Watcher({ ...SPEC, action: 'hold' }, h.deps);

    const res = await poll(w, h);

    expect(res.targets).toBe(2);
    expect(res.alerts).toHaveLength(1);
  });

  it('notify 모드는 열린 회차를 전부 알린다', async () => {
    const h = harness([
      showtime({ playSequence: '4', remainingSeats: 6 }),
      showtime({ playSequence: '5', startTime: '22:40', remainingSeats: 215 }),
    ]);
    const w = new Watcher({ ...SPEC, action: 'notify' }, h.deps);

    const res = await poll(w, h);

    expect(res.alerts).toHaveLength(2);
  });
});

/**
 * 요청량은 회차 수가 아니라 지점 × 날짜 로 늘어난다. 한 번 조회하면
 * 그 지점·그 날짜의 전 회차가 오기 때문이다 (CGV 실측 40개).
 *
 * 그래서 감시 회차를 늘리는 건 공짜지만, 날짜를 늘리는 건 아니다.
 */
describe('Watcher — 요청량', () => {
  const FIVE_DATES: WatchSpec = {
    ...SPEC,
    dates: ['20260809', '20260810', '20260811', '20260812', '20260813'],
  };

  it('회차가 몇 개든 지점·날짜당 한 번만 조회한다', async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      showtime({ playSequence: String(i + 1), startTime: '19:10' }),
    );
    const h = harness(many);
    const w = new Watcher(SPEC, h.deps, { coldStart: 'baseline' });

    const res = await poll(w, h);

    expect(res.requests).toBe(1);
    expect(h.listShowtimes).toHaveBeenCalledTimes(1);
  });

  /**
   * 예전에는 전체에서 가장 급한 회차가 깨우는 간격을 정했고, 깨어나면
   * 모든 짝을 조회했다. 오늘 저녁 회차 하나 때문에 닷새 뒤 날짜까지
   * 45초마다 두드렸다.
   */
  it('급하지 않은 날짜는 매번 조회하지 않는다', async () => {
    const h = harness();
    // 오늘 회차는 2시간 뒤(급함), 나머지 날짜는 며칠 뒤라 회차가 없다고 본다
    h.listShowtimes.mockImplementation(async (_idx: number, date: string) =>
      date === '20260809' ? [showtime()] : [showtime({ playDate: date, startTime: '19:10' })],
    );
    const w = new Watcher(FIVE_DATES, h.deps, { coldStart: 'baseline' });

    const first = await poll(w, h);
    expect(first.requests).toBe(5); // 처음에는 다 본다

    h.listShowtimes.mockClear();
    h.tick(60_000); // 1분 뒤
    const second = await w.runOnce();

    // 오늘 것만 다시 본다. 며칠 뒤 날짜는 아직 잘 시간이다.
    expect(second.requests).toBe(1);
    expect(h.listShowtimes).toHaveBeenCalledWith(0, '20260809');
  });

  it('남은 회차가 없는 날짜는 다시 조회하지 않는다', async () => {
    const h = harness([]);
    const w = new Watcher(SPEC, h.deps, { coldStart: 'baseline' });

    await poll(w, h);
    h.listShowtimes.mockClear();
    const second = await poll(w, h);

    expect(second.requests).toBe(0);
    expect(second.nextWakeMs).toBe(STOP);
  });
});

/**
 * 좌석맵을 못 보는 체인에서 단석·연석을 흉내 내는 수단.
 * 한 번에 2석이 풀렸다면 같이 취소한 것이고, 붙어 있을 가능성이 크다.
 */
describe('Watcher — 최소 증가분', () => {
  function countOnly(rows: Showtime[]) {
    var h = harness(rows);
    // 좌석맵을 못 구하는 체인처럼 군다
    var deps = { ...h.deps };
    delete (deps as { fetchSeatMap?: unknown }).fetchSeatMap;
    return { h: h, deps: deps };
  }

  it('1석만 풀리면 2연석 조건에서 알리지 않는다', async () => {
    const c = countOnly([showtime({ remainingSeats: 0 })]);
    const w = new Watcher({ ...SPEC, minIncrease: 2 }, c.deps, { coldStart: 'baseline' });

    await poll(w, c.h);
    c.h.setRows([showtime({ remainingSeats: 1 })]);
    const res = await poll(w, c.h);

    expect(res.alerts).toHaveLength(0);
  });

  it('2석이 한꺼번에 풀리면 알린다', async () => {
    const c = countOnly([showtime({ remainingSeats: 0 })]);
    const w = new Watcher({ ...SPEC, minIncrease: 2 }, c.deps, { coldStart: 'baseline' });

    await poll(w, c.h);
    c.h.setRows([showtime({ remainingSeats: 2 })]);
    const res = await poll(w, c.h);

    expect(res.alerts).toHaveLength(1);
    expect(res.alerts[0]!.increase).toBe(2);
  });

  it('기본값에서는 1석도 알린다', async () => {
    const c = countOnly([showtime({ remainingSeats: 0 })]);
    const w = new Watcher(SPEC, c.deps, { coldStart: 'baseline' });

    await poll(w, c.h);
    c.h.setRows([showtime({ remainingSeats: 1 })]);

    expect((await poll(w, c.h)).alerts).toHaveLength(1);
  });

  /**
   * 감시를 계속 돌려두는 쪽에서 가장 놓치면 안 되는 순간이다.
   * 잔여수를 지문에 넣어둔 탓에 0→1 로 알리고, 1→0 으로 팔리고,
   * 다시 0→1 이 되면 지문이 같아서 쿨다운에 묻혔다.
   */
  it('다시 팔린 자리가 또 나면 다시 알린다', async () => {
    const c = countOnly([showtime({ remainingSeats: 0 })]);
    const w = new Watcher(SPEC, c.deps, { coldStart: 'baseline' });

    await poll(w, c.h);
    c.h.setRows([showtime({ remainingSeats: 1 })]);
    expect((await poll(w, c.h)).alerts).toHaveLength(1); // 취소표

    c.h.setRows([showtime({ remainingSeats: 0 })]);
    expect((await poll(w, c.h)).alerts).toHaveLength(0); // 남이 채감

    c.h.setRows([showtime({ remainingSeats: 1 })]);
    expect((await poll(w, c.h)).alerts).toHaveLength(1); // 또 났다 — 새 사건
  });

  /** 한 번 알린 뒤에도 감시는 계속 돈다. 사람이 멈추기 전에는 끝나지 않는다. */
  it('알린 뒤에도 계속 감시한다', async () => {
    const c = countOnly([showtime({ remainingSeats: 0 })]);
    const w = new Watcher(SPEC, c.deps, { coldStart: 'baseline' });

    await poll(w, c.h);
    c.h.setRows([showtime({ remainingSeats: 1 })]);
    const res = await poll(w, c.h);

    expect(res.alerts).toHaveLength(1);
    expect(res.nextWakeMs).not.toBe(STOP);
  });
});

/**
 * 30초 하한은 요청 하나를 기준으로 삼은 규칙이었다. 서버가 실제로 느끼는
 * 건 총량이다 — 1짝을 20초마다 보는 것이 10짝을 45초마다 보는 것보다 가볍다.
 */
describe('Watcher — 총량 예산', () => {
  it('짝이 하나면 예산을 다 써서 촘촘하게 본다', () => {
    const w = new Watcher(
      { ...SPEC, maxRequestsPerHour: 180, pollFloorSec: 15 },
      harness().deps,
    );
    expect(w.floorSec()).toBe(20); // 3600/180
  });

  it('짝이 늘면 그만큼 성기게 본다 — 총량은 같다', () => {
    const w = new Watcher(
      {
        ...SPEC,
        theaters: [
          { chain: 'cgv', theaterId: '0013' },
          { chain: 'cgv', theaterId: '0059' },
        ],
        dates: ['20260809', '20260810'],
        maxRequestsPerHour: 180,
        pollFloorSec: 15,
      },
      harness().deps,
    );
    expect(w.floorSec()).toBe(80); // 4짝 × 3600 / 180
  });

  /** 예산이 아무리 커도 하한은 깨지 않는다. 순간 요청률이 튀면 창 단위로 걸린다. */
  it('예산이 커도 하한을 지킨다', () => {
    const w = new Watcher(
      { ...SPEC, maxRequestsPerHour: 100000, pollFloorSec: 15 },
      harness().deps,
    );
    expect(w.floorSec()).toBe(15);
  });

  it('예산이 없으면 예전처럼 하한만 쓴다', () => {
    const w = new Watcher({ ...SPEC, pollFloorSec: 45 }, harness().deps);
    expect(w.floorSec()).toBe(45);
  });
});

/**
 * 회차를 집어서 고른 감시는 방금 그 목록을 눈으로 보고 고른 것이다.
 * 첫 관측을 사건으로 알리면 시작하자마자 아는 사실을 되풀이할 뿐이다.
 */
describe('Watcher — 첫 관측은 기준점', () => {
  it('회차를 집어 골랐으면 시작하자마자 알리지 않는다', async () => {
    const h = harness([showtime({ remainingSeats: 6 })]);
    const w = new Watcher({ ...SPEC, showtimes: ['1016:101609:4'] }, h.deps);

    expect((await poll(w, h)).alerts).toHaveLength(0);
  });

  /** 그다음 늘어난 것은 사건이다. 6 → 3 → 5 에서 5 로 바뀔 때 알린다. */
  it('줄었다 늘어도 알린다', async () => {
    const h = harness([showtime({ remainingSeats: 6 })]);
    const w = new Watcher({ ...SPEC, showtimes: ['1016:101609:4'] }, h.deps);

    await poll(w, h);
    h.setRows([showtime({ remainingSeats: 3 })]);
    expect((await poll(w, h)).alerts).toHaveLength(0); // 3석 팔림

    h.setRows([showtime({ remainingSeats: 5 })]);
    const res = await poll(w, h);
    expect(res.alerts).toHaveLength(1); // 2석 돌아옴
    expect(res.alerts[0]!.increase).toBe(2);
  });
});

/**
 * 예산은 우리가 정한 천장일 뿐 서버가 동의한 값이 아니다.
 * 429·403 이 돌아오면 같은 속도로 계속 두드려서는 안 된다.
 */
describe('Watcher — 밀리면 물러선다', () => {
  const budgeted: WatchSpec = { ...SPEC, maxRequestsPerHour: 120, pollFloorSec: 10 };

  it('밀어내는 응답을 만나면 간격을 늘린다', async () => {
    const h = harness();
    const steps: number[] = [];
    const w = new Watcher(
      budgeted,
      { ...h.deps, onBackoff: (n) => steps.push(n) },
      { coldStart: 'baseline' },
    );

    expect(w.floorSec()).toBe(30); // 1짝 · 120회/시
    h.listShowtimes.mockRejectedValue(new Error('CGV HTTP 429'));
    const res = await poll(w, h);

    expect(steps).toEqual([1]);
    expect(w.floorSec()).toBe(60);
    expect(res.backoffSteps).toBe(1);
  });

  it('평범한 고장에는 물러서지 않는다', async () => {
    const h = harness();
    const w = new Watcher(budgeted, h.deps, { coldStart: 'baseline' });

    h.listShowtimes.mockRejectedValue(new Error('socket hang up'));
    await poll(w, h);

    expect(w.floorSec()).toBe(30);
  });

  it('조용해지면 천천히 돌아온다', async () => {
    const h = harness();
    const w = new Watcher(budgeted, h.deps, { coldStart: 'baseline' });

    h.listShowtimes.mockRejectedValue(new Error('CGV HTTP 429'));
    await poll(w, h);
    expect(w.floorSec()).toBe(60);

    // 조회를 실제로 해야 조용했다고 셀 수 있다. 물러선 간격만큼 시간을 흘린다.
    h.listShowtimes.mockResolvedValue([showtime()]);
    for (let i = 0; i < 4; i++) {
      h.tick(120_000);
      await w.runOnce();
      expect(w.floorSec()).toBe(60); // 아직 돌아오지 않는다
    }
    h.tick(120_000);
    await w.runOnce();
    expect(w.floorSec()).toBe(30); // 다섯 번 조용해야 한 단
  });
});
