import { describe, expect, it, vi } from 'vitest';

import {
  HoldBusyError,
  HoldManager,
  type HeldSession,
  type HoldRequest,
  type ReleaseReason,
  type SeatHolder,
} from '../src/hold/session.js';
import { LOTTE_SELECTORS, seatSelector, selectorsAreStubs } from '../src/hold/selectors.js';
import type { Seat, Showtime } from '../src/types.js';

const SEATS: Seat[] = [
  { id: '1J10', row: 'J', col: 10, x: 0, y: 0, group: 3, state: 'free' },
  { id: '1J11', row: 'J', col: 11, x: 283, y: 0, group: 3, state: 'free' },
];

const showtime = (over: Partial<Showtime> = {}): Showtime => ({
  chain: 'lotte',
  theaterId: '1016',
  theaterName: '월드타워',
  movieId: '24128',
  movieName: '오디세이',
  screenId: '101609',
  screenName: '9관',
  playDate: '20260811',
  playSequence: '4',
  startTime: '19:10',
  divisionCode: '*',
  totalSeats: 360,
  remainingSeats: 6,
  ...over,
});

const req = (over: Partial<HoldRequest> = {}): HoldRequest => ({
  showtime: showtime(),
  seats: SEATS,
  ...over,
});

/** 시계를 우리가 돌린다. sleep 은 즉시 반환하고 시간만 앞으로 민다. */
function harness(
  holder: SeatHolder,
  opts: { holdSeconds?: number; tickSeconds?: number; maxAttempts?: number } = {},
) {
  let now = 0;
  const countdowns: number[] = [];
  const released: ReleaseReason[] = [];
  const errors: unknown[] = [];

  const mgr = new HoldManager(
    {
      holder,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      onCountdown: async (_r, left) => {
        countdowns.push(left);
      },
      onReleased: async (_r, reason) => {
        released.push(reason);
      },
      onError: (_r, e) => {
        errors.push(e);
      },
    },
    opts,
  );
  return { mgr, countdowns, released, errors, cancelAt: (n: number) => { if (countdowns.length >= n) mgr.cancel(); } };
}

function fakeHolder(over: Partial<HeldSession> = {}) {
  const release = vi.fn(async () => {});
  const hold = vi.fn(
    async (): Promise<HeldSession> => ({ atPayment: true, release, ...over }),
  );
  return { hold, release, holder: { hold } as SeatHolder };
}

describe('HoldManager — 정상 흐름', () => {
  it('결제 화면까지 가면 남은 시간을 세다가 만료 시 놓아준다', async () => {
    const f = fakeHolder();
    const h = harness(f.holder, { holdSeconds: 120, tickSeconds: 30 });

    const reason = await h.mgr.run(req());

    expect(reason).toBe('expired');
    expect(h.countdowns).toEqual([120, 90, 60, 30]);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(h.released).toEqual(['expired']);
  });

  it('화면에서 만료 시각을 읽었으면 그 값을 우선한다', async () => {
    const f = fakeHolder({ deadline: 60_000 }); // now=0 기준 60초
    const h = harness(f.holder, { holdSeconds: 300, tickSeconds: 30 });

    await h.mgr.run(req());

    expect(h.countdowns).toEqual([60, 30]);
  });

  it('끝나면 다음 홀드를 받을 수 있다', async () => {
    const f = fakeHolder();
    const h = harness(f.holder, { holdSeconds: 30, tickSeconds: 30 });

    await h.mgr.run(req());

    expect(h.mgr.busy).toBe(false);
  });
});

describe('HoldManager — 안전 규칙', () => {
  /** 동시 홀드 1건. 여러 회차를 동시에 잡아두면 그만큼 남의 자리를 막는다. */
  it('이미 잡고 있으면 새 홀드를 거절한다', async () => {
    let resolveHold: (s: HeldSession) => void = () => {};
    const holder: SeatHolder = {
      hold: () => new Promise<HeldSession>((r) => (resolveHold = r)),
    };
    const h = harness(holder, { holdSeconds: 60 });

    const first = h.mgr.run(req());
    resolveHold({ atPayment: true, release: async () => {} });
    await Promise.resolve();
    await Promise.resolve();

    await expect(h.mgr.run(req({ showtime: showtime({ playSequence: '9' }) }))).rejects.toThrow(
      HoldBusyError,
    );
    await first;
  });

  /** 사람이 건너뛰면 만료를 기다리지 않는다. */
  it('취소하면 즉시 놓아준다', async () => {
    const f = fakeHolder();
    let now = 0;
    const countdowns: number[] = [];
    const mgr = new HoldManager(
      {
        holder: f.holder,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        onCountdown: async (_r, left) => {
          countdowns.push(left);
          if (countdowns.length === 2) mgr.cancel();
        },
      },
      { holdSeconds: 600, tickSeconds: 30 },
    );

    const reason = await mgr.run(req());

    expect(reason).toBe('cancelled');
    expect(countdowns).toHaveLength(2); // 600 까지 안 간다
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('같은 회차 재시도 상한을 넘기지 않는다', async () => {
    const f = fakeHolder();
    const h = harness(f.holder, { holdSeconds: 30, tickSeconds: 30, maxAttempts: 2 });

    await h.mgr.run(req());
    await h.mgr.run(req());
    const third = await h.mgr.run(req());

    expect(third).toBe('failed');
    expect(f.hold).toHaveBeenCalledTimes(2);
  });

  it('다른 회차는 재시도 횟수를 따로 센다', async () => {
    const f = fakeHolder();
    const h = harness(f.holder, { holdSeconds: 30, tickSeconds: 30, maxAttempts: 1 });

    await h.mgr.run(req());
    const other = await h.mgr.run(req({ showtime: showtime({ playSequence: '9' }) }));

    expect(other).toBe('expired');
    expect(f.hold).toHaveBeenCalledTimes(2);
  });
});

describe('HoldManager — 실패', () => {
  /** 잡다 만 상태로 두는 게 최악이다. 남도 못 쓰고 나도 못 쓴다. */
  it('결제 화면에 못 닿으면 좌석을 놓아준다', async () => {
    const f = fakeHolder({ atPayment: false });
    const h = harness(f.holder);

    const reason = await h.mgr.run(req());

    expect(reason).toBe('failed');
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(h.released).toEqual(['failed']);
  });

  it('좌석 잡기가 던지면 삼키지 않고 알린 뒤 실패로 끝낸다', async () => {
    const holder: SeatHolder = {
      hold: async () => {
        throw new Error('SEAT_TAKEN');
      },
    };
    const h = harness(holder);

    expect(await h.mgr.run(req())).toBe('failed');
    expect((h.errors[0] as Error).message).toBe('SEAT_TAKEN');
    expect(h.mgr.busy).toBe(false);
  });

  /** 해제 실패로 던지면 다음 감시가 통째로 막힌다. */
  it('해제가 깨져도 던지지 않는다', async () => {
    const holder: SeatHolder = {
      hold: async () => ({
        atPayment: true,
        release: async () => {
          throw new Error('context already closed');
        },
      }),
    };
    const h = harness(holder, { holdSeconds: 30, tickSeconds: 30 });

    await expect(h.mgr.run(req())).resolves.toBe('expired');
    expect(h.errors).toHaveLength(1);
    expect(h.mgr.busy).toBe(false);
  });
});

describe('셀렉터', () => {
  it('좌석 셀렉터에 좌석 값을 채운다', () => {
    const sel = { ...LOTTE_SELECTORS, seat: '[data-x="{seat}"]', seatKey: 'id' as const };
    expect(seatSelector(sel, SEATS[0]!)).toBe('[data-x="1J10"]');

    const byLabel = { ...sel, seatKey: 'label' as const };
    expect(seatSelector(byLabel, SEATS[0]!)).toBe('[data-x="J10"]');
  });

  /**
   * 이 파일의 값은 스크린샷에서 읽은 추정이지 실측이 아니다.
   * 실측 전에 감시기를 hold 모드로 돌리면 조용히 실패한다.
   */
  it('아직 실측 전임을 스스로 안다', () => {
    expect(selectorsAreStubs(LOTTE_SELECTORS)).toBe(true);
  });
});
