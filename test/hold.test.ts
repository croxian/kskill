import { describe, expect, it, vi } from 'vitest';

import { LoginRequiredError, LotteSeatHolder, SeatTakenError } from '../src/hold/lotte.js';
import { credentialsFromEnv } from '../src/hold/login.js';
import {
  HoldBusyError,
  HoldManager,
  type HeldSession,
  type HoldRequest,
  type ReleaseReason,
  type SeatHolder,
} from '../src/hold/session.js';
import {
  dayNamePattern,
  LOTTE_FLOW,
  movieNamePattern,
  seatSelector,
  selectorsAreStubs,
  showtimeNamePattern,
} from '../src/hold/selectors.js';
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

/**
 * 예매 화면을 흉내 내는 최소한의 가짜.
 * 홀더가 실제로 쓰는 표면만 구현한다.
 */
function fakeBrowser(
  opts: {
    seatStatus?: Record<string, string>;
    paymentVisible?: boolean;
    /** true 면 로그인 링크가 보인다 = 로그아웃 상태 */
    loggedOut?: boolean;
  } = {},
) {
  const clicks: string[] = [];
  const fills: Array<[string, string]> = [];
  const closed = { count: 0 };
  const seatStatus = opts.seatStatus ?? {};
  // 로그인 버튼을 누르면 로그인된 것으로 친다
  let loggedOut = opts.loggedOut ?? false;

  const locator = (sel: string) => ({
    isVisible: async () => false,
    getAttribute: async (_name: string) => {
      const m = sel.match(/seat-code="([^"]+)"/);
      return m ? (seatStatus[m[1]!] ?? '0') : null;
    },
    click: async () => {
      clicks.push(sel);
    },
    waitFor: async () => {
      if (opts.paymentVisible === false) throw new Error('timeout');
    },
    first: () => locator(sel),
    textContent: async () => null,
    // 지점 목록은 스크롤 컨테이너로 범위를 좁혀서 찾는다
    getByRole: (role: string, o: { name: unknown }) => ({
      click: async () => {
        clicks.push(`${sel}>${role}:${String(o.name)}`);
      },
    }),
  });

  const page = {
    setDefaultTimeout: () => {},
    goto: async () => {},
    locator,
    getByPlaceholder: (ph: string) => ({
      fill: async (v: string) => {
        fills.push([ph, v]);
      },
    }),
    getByRole: (role: string, o: { name: unknown }) => {
      const label = String(o.name);
      const isLoginLink = role === 'link' && label === '로그인';
      const isLoginSubmit = role === 'button' && label === '로그인';
      return {
        isVisible: async () => (isLoginLink ? loggedOut : false),
        waitFor: async () => {
          if (isLoginLink && loggedOut) throw new Error('still visible');
        },
        click: async () => {
          clicks.push(`${role}:${label}`);
          if (isLoginSubmit) loggedOut = false;
        },
        getByRole: (r2: string, o2: { name: unknown }) => ({
          click: async () => {
            clicks.push(`${role}>${r2}:${String(o2.name)}`);
          },
        }),
      };
    },
  };

  const ctx = {
    pages: () => [page],
    newPage: async () => page,
    close: async () => {
      closed.count++;
    },
  };

  return { clicks, fills, closed, launch: async () => ctx as never };
}

describe('LotteSeatHolder — 세션', () => {
  const CREDS = { id: 'someone', password: 'secret' };

  it('로그인되어 있으면 아무것도 하지 않는다', async () => {
    const b = fakeBrowser();
    const holder = new LotteSeatHolder({ launch: b.launch, credentials: CREDS });

    expect(await holder.checkSession()).toBe('already');
    expect(b.fills).toHaveLength(0);
  });

  /**
   * 세션이 죽었을 때만 자동 로그인한다. 매번 로그인하면 그게 계정 잠금으로
   * 가는 길이라, 이 구조를 유지하는 게 핵심이다.
   */
  it('세션이 죽었고 자격증명이 있으면 되살린다', async () => {
    const b = fakeBrowser({ loggedOut: true });
    const holder = new LotteSeatHolder({ launch: b.launch, credentials: CREDS });

    expect(await holder.checkSession()).toBe('recovered');
    expect(b.fills.map(([, v]) => v)).toEqual(['someone', 'secret']);
  });

  it('자격증명이 없으면 사람을 부른다', async () => {
    const b = fakeBrowser({ loggedOut: true });
    const holder = new LotteSeatHolder({ launch: b.launch });

    expect(await holder.checkSession()).toBe('needs-human');
    expect(b.fills).toHaveLength(0);
  });

  it('세션 점검은 브라우저를 남기지 않는다', async () => {
    const b = fakeBrowser();
    await new LotteSeatHolder({ launch: b.launch }).checkSession();

    expect(b.closed.count).toBe(1);
  });

  /** 로그인 없이 진행하면 좌석 클릭이 조용히 무시된다. 시작 전에 막는다. */
  it('로그아웃 상태에서 자격증명 없이 홀드하면 거부한다', async () => {
    const b = fakeBrowser({ loggedOut: true });
    const holder = new LotteSeatHolder({ launch: b.launch });

    await expect(holder.hold(req())).rejects.toThrow(LoginRequiredError);
    expect(b.clicks.filter((c) => c.startsWith('[seat-code'))).toHaveLength(0);
    expect(b.closed.count).toBe(1);
  });

  it('홀드 도중 세션이 죽어 있으면 되살리고 계속한다', async () => {
    const b = fakeBrowser({ loggedOut: true });
    const seen: string[] = [];
    const holder = new LotteSeatHolder({
      launch: b.launch,
      credentials: CREDS,
      onLogin: (o) => seen.push(o),
    });

    const session = await holder.hold(req());

    expect(seen).toEqual(['recovered']);
    expect(session.atPayment).toBe(true);
  });
});

describe('credentialsFromEnv', () => {
  it('둘 다 있어야 쓴다. 자동 로그인은 옵트인이다', () => {
    expect(credentialsFromEnv({ LOTTE_ID: 'a', LOTTE_PW: 'b' })).toEqual({
      id: 'a',
      password: 'b',
    });
    expect(credentialsFromEnv({ LOTTE_ID: 'a' })).toBeUndefined();
    expect(credentialsFromEnv({ LOTTE_PW: 'b' })).toBeUndefined();
    expect(credentialsFromEnv({})).toBeUndefined();
  });

  it('아이디의 앞뒤 공백을 떨어낸다', () => {
    expect(credentialsFromEnv({ LOTTE_ID: '  a  ', LOTTE_PW: 'b' })?.id).toBe('a');
  });
});

describe('LotteSeatHolder — 화면 진행', () => {
  const request = req();

  it('예매 → 지점 → 영화 → 날짜 → 회차 → 좌석 순서로 밟는다', async () => {
    const b = fakeBrowser();
    const holder = new LotteSeatHolder({ launch: b.launch });

    const session = await holder.hold(request);

    expect(session.atPayment).toBe(true);
    expect(b.clicks.join('\n')).toContain('link:예매');
    // 인원을 좌석보다 먼저 누른다. 인원이 0 이면 좌석이 눌리지 않는다.
    const audienceAt = b.clicks.findIndex((c) => c.includes('증가'));
    const seatAt = b.clicks.findIndex((c) => c.includes('seat-code'));
    expect(audienceAt).toBeGreaterThan(-1);
    expect(audienceAt).toBeLessThan(seatAt);
  });

  it('좌석 수만큼 인원을 올린다', async () => {
    const b = fakeBrowser();
    await new LotteSeatHolder({ launch: b.launch }).hold(request);

    expect(b.clicks.filter((c) => c.includes('증가'))).toHaveLength(2);
  });

  it('좌석을 seat-code 로 하나씩 클릭한다', async () => {
    const b = fakeBrowser();
    await new LotteSeatHolder({ launch: b.launch }).hold(request);

    expect(b.clicks.filter((c) => c.startsWith('[seat-code'))).toEqual([
      '[seat-code="1J10"]',
      '[seat-code="1J11"]',
    ]);
  });

  /**
   * 좌석 <a> 에 SeatStatusCode 가 실려 있다. 그냥 클릭하면 아무 일도
   * 일어나지 않고 결제 화면 대기에서 타임아웃으로 뒤늦게 실패한다.
   */
  it('그 사이 팔린 좌석은 클릭 전에 잡아낸다', async () => {
    const b = fakeBrowser({ seatStatus: { '1J11': '50' } });
    const holder = new LotteSeatHolder({ launch: b.launch });

    await expect(holder.hold(request)).rejects.toThrow(SeatTakenError);
    expect(b.clicks).not.toContain('[seat-code="1J11"]');
  });

  /** 잡다 만 상태로 두는 게 최악이다. 실패하면 반드시 컨텍스트를 닫는다. */
  it('실패하면 브라우저를 닫아 좌석을 놓는다', async () => {
    const b = fakeBrowser({ seatStatus: { '1J10': '50' } });

    await expect(new LotteSeatHolder({ launch: b.launch }).hold(request)).rejects.toThrow();
    expect(b.closed.count).toBe(1);
  });

  it('결제 화면에 못 닿으면 실패로 처리하고 닫는다', async () => {
    const b = fakeBrowser({ paymentVisible: false });

    await expect(new LotteSeatHolder({ launch: b.launch }).hold(request)).rejects.toThrow();
    expect(b.closed.count).toBe(1);
  });

  it('release 는 여러 번 불려도 한 번만 닫는다', async () => {
    const b = fakeBrowser();
    const session = await new LotteSeatHolder({ launch: b.launch }).hold(request);

    await session.release();
    await session.release();

    expect(b.closed.count).toBe(1);
  });
});

describe('셀렉터', () => {
  it('좌석 셀렉터에 좌석 값을 채운다', () => {
    const byId = { ...LOTTE_FLOW, seat: '[data-x="{seat}"]', seatKey: 'id' as const };
    expect(seatSelector(byId, SEATS[0]!)).toBe('[data-x="1J10"]');
    expect(seatSelector({ ...byId, seatKey: 'label' }, SEATS[0]!)).toBe('[data-x="J10"]');
    expect(seatSelector({ ...byId, seatKey: 'col' }, SEATS[0]!)).toBe('[data-x="10"]');
  });

  /**
   * 회차 버튼 이름에는 잔여석 수가 들어간다.
   *   "상영시간 17:20 종료 20:22 잔여석 35 / ..."
   * 우리가 보는 사이에도 변하므로 시작 시각으로만 맞춰야 한다.
   */
  it('회차는 잔여석이 아니라 시작 시각으로 맞춘다', () => {
    const re = showtimeNamePattern('17:20');
    expect(re.test('상영시간 17:20 종료 20:22 잔여석 35 / 342')).toBe(true);
    expect(re.test('상영시간 17:20 종료 20:22 잔여석 12 / 342')).toBe(true); // 잔여석이 변해도
    expect(re.test('상영시간 19:10 종료 22:12 잔여석 35 / 342')).toBe(false);
  });

  it('영화는 관람등급을 빼고 제목으로 맞춘다', () => {
    expect(movieNamePattern('오디세이').test('세 관람가 오디세이')).toBe(true);
    expect(movieNamePattern('오디세이').test('12세 관람가 스파이더맨')).toBe(false);
  });

  it('날짜는 일 + 요일 형식을 맞춘다', () => {
    const re = dayNamePattern('20260811');
    expect(re.test('11 화')).toBe(true);
    expect(re.test('1 토')).toBe(false);
    expect(re.test('21 금')).toBe(false);
  });

  /**
   * 좌석 <a> 의 seat-code 가 GetSeats 의 SeatNo 와 같은 값이다.
   * API 와 DOM 이 같은 키를 쓰므로 파싱한 id 를 그대로 넣으면 된다.
   *
   * codegen 이 뱉은 getByRole('link', { name: '24' }).first() 를 그대로 썼다면
   * A24·B24·C24 가 구분되지 않아 엉뚱한 열을 클릭하고도 에러 없이 넘어갔을 것이다.
   */
  it('좌석을 seat-code 로 고유하게 가리킨다', () => {
    expect(seatSelector(LOTTE_FLOW, SEATS[0]!)).toBe('[seat-code="1J10"]');
    expect(seatSelector(LOTTE_FLOW, SEATS[1]!)).toBe('[seat-code="1J11"]');
  });

  it('실측한 셀렉터로 인식한다', () => {
    expect(selectorsAreStubs(LOTTE_FLOW)).toBe(false);
    expect(selectorsAreStubs({ ...LOTTE_FLOW, measured: false })).toBe(true);
  });
});
