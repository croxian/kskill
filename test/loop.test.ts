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
    deps: {
      listShowtimes,
      fetchSeatMap,
      notify: async (a) => { alerts.push(a); },
      now: () => now,
      onError: (stage, _err, ctx) => { errors.push([stage, ctx]); },
    },
  };
}

describe('Watcher — 첫 관측', () => {
  it('시작하자마자 현재 빈자리를 알려준다', async () => {
    const h = harness();
    const w = new Watcher(SPEC, h.deps);

    const res = await w.runOnce();

    expect(res.alerts).toHaveLength(1);
    expect(res.alerts[0]!.candidate.seats.map((s) => `${s.row}${s.col}`)).toEqual(['J10', 'J11']);
  });

  it('baseline 으로 시작하면 기준만 잡고 조용히 있는다', async () => {
    const h = harness();
    const w = new Watcher(SPEC, h.deps, { coldStart: 'baseline' });

    const res = await w.runOnce();

    expect(res.alerts).toHaveLength(0);
    expect(h.fetchSeatMap).not.toHaveBeenCalled();
  });
});

describe('Watcher — 변화 감지', () => {
  it('잔여석이 그대로면 좌석맵을 뜯지 않는다', async () => {
    const h = harness();
    const w = new Watcher(SPEC, h.deps, { coldStart: 'baseline' });

    await w.runOnce();
    const res = await w.runOnce();

    expect(res.targets).toBe(0);
    expect(h.fetchSeatMap).not.toHaveBeenCalled();
  });

  it('잔여석이 늘면 2단으로 넘어간다', async () => {
    const h = harness([showtime({ remainingSeats: 4 })]);
    const w = new Watcher(SPEC, h.deps, { coldStart: 'baseline' });

    await w.runOnce();
    h.setRows([showtime({ remainingSeats: 6 })]); // 취소표 발생
    const res = await w.runOnce();

    expect(res.targets).toBe(1);
    expect(res.alerts).toHaveLength(1);
  });

  it('잔여석이 줄면 무시한다 — 남이 예매한 것이다', async () => {
    const h = harness([showtime({ remainingSeats: 6 })]);
    const w = new Watcher(SPEC, h.deps, { coldStart: 'baseline' });

    await w.runOnce();
    h.setRows([showtime({ remainingSeats: 2 })]);
    const res = await w.runOnce();

    expect(res.targets).toBe(0);
  });

  it('매진된 회차는 좌석맵을 조회하지 않는다', async () => {
    const h = harness([showtime({ remainingSeats: 0 })]);
    const w = new Watcher(SPEC, h.deps);

    const res = await w.runOnce();

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

    const res = await w.runOnce();

    expect(res.polled).toBe(1);
    expect(h.fetchSeatMap).toHaveBeenCalledTimes(1);
  });
});

describe('Watcher — 중복 억제', () => {
  it('같은 좌석으로 연달아 알리지 않는다', async () => {
    const h = harness([showtime({ remainingSeats: 4 })]);
    const w = new Watcher(SPEC, h.deps, { coldStart: 'baseline', cooldownMs: 180_000 });

    await w.runOnce();
    h.setRows([showtime({ remainingSeats: 6 })]);
    const first = await w.runOnce();

    h.setRows([showtime({ remainingSeats: 8 })]); // 또 늘었지만 좌석은 그대로
    const second = await w.runOnce();

    expect(first.alerts).toHaveLength(1);
    expect(second.targets).toBe(1); // 2단까지는 갔지만
    expect(second.alerts).toHaveLength(0); // 알림은 눌렸다
  });

  it('쿨다운이 지나면 다시 알린다', async () => {
    const h = harness([showtime({ remainingSeats: 4 })]);
    const w = new Watcher(SPEC, h.deps, { coldStart: 'baseline', cooldownMs: 60_000 });

    await w.runOnce();
    h.setRows([showtime({ remainingSeats: 6 })]);
    await w.runOnce();

    h.setNow(NOW + 120_000);
    h.setRows([showtime({ remainingSeats: 8 })]);
    const res = await w.runOnce();

    expect(res.alerts).toHaveLength(1);
  });
});

describe('Watcher — 실패와 종료', () => {
  it('조회가 깨져도 삼키지 않고 알린 뒤 계속 돈다', async () => {
    const h = harness();
    h.listShowtimes.mockRejectedValueOnce(new Error('HTTP 500'));
    const w = new Watcher(SPEC, h.deps);

    const res = await w.runOnce();

    expect(h.errors).toEqual([['1단', 'theater[0] 20260809']]);
    expect(res.polled).toBe(0);
  });

  it('좌석맵 조회가 깨지면 그 회차만 건너뛴다', async () => {
    const h = harness();
    h.fetchSeatMap.mockRejectedValueOnce(new Error('timeout'));
    const w = new Watcher(SPEC, h.deps);

    const res = await w.runOnce();

    expect(h.errors[0]![0]).toBe('2단');
    expect(res.alerts).toHaveLength(0);
  });

  it('상영 30분 안쪽 회차는 감시 대상에서 빠진다', async () => {
    const h = harness();
    h.setNow(Date.parse('2026-08-09T09:50:00Z')); // 상영 20분 전
    const w = new Watcher(SPEC, h.deps);

    const res = await w.runOnce();

    expect(res.polled).toBe(0);
    expect(res.nextWakeMs).toBe(STOP);
  });

  it('만료시각이 지나면 다음 깨어남이 없다', async () => {
    const h = harness();
    h.setNow(Date.parse('2026-08-11T00:00:00Z'));
    const w = new Watcher(SPEC, h.deps);

    expect(w.expired).toBe(true);
    expect((await w.runOnce()).nextWakeMs).toBe(STOP);
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

    const res = await w.runOnce();

    expect(res.targets).toBe(2);
    expect(res.alerts).toHaveLength(1);
  });

  it('notify 모드는 열린 회차를 전부 알린다', async () => {
    const h = harness([
      showtime({ playSequence: '4', remainingSeats: 6 }),
      showtime({ playSequence: '5', startTime: '22:40', remainingSeats: 215 }),
    ]);
    const w = new Watcher({ ...SPEC, action: 'notify' }, h.deps);

    const res = await w.runOnce();

    expect(res.alerts).toHaveLength(2);
  });
});
