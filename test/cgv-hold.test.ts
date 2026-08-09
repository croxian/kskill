import { describe, expect, it } from 'vitest';

import { CGV_FLOW } from '../src/hold/cgv-flow.js';
import { CgvCaptchaError, CgvNoSeatError, CgvSeatHolder, dayName } from '../src/hold/cgv.js';
import type { Showtime } from '../src/types.js';

const showtime = (over: Partial<Showtime> = {}): Showtime => ({
  chain: 'cgv',
  theaterId: '0013',
  theaterName: '용산아이파크몰',
  movieId: '30001323',
  movieName: '오디세이',
  screenId: '018',
  screenName: 'IMAX관',
  playDate: '20260814',
  playSequence: '4',
  startTime: '18:00',
  divisionCode: '*',
  totalSeats: 624,
  remainingSeats: 6,
  ...over,
});

/** 좌석 하나를 DOM 요소처럼 흉내 낸다. */
function seatEl(label: string, cls: string, x: number, y: number) {
  return {
    id: `id-${label}`,
    label,
    className: cls,
    title: '',
    disabled: cls.includes('Disabled'),
    x,
    y,
  };
}

const FREE = 'seatMap_seatNumber__a seatMap_seatNormal__b';
const SOLD = 'seatMap_seatNumber__a seatMap_seatNormal__b seatMap_seatDisabled__c';

function fakeCgv(opts: { seats?: ReturnType<typeof seatEl>[]; captcha?: boolean } = {}) {
  const clicks: string[] = [];
  const closed = { count: 0 };
  const seats = opts.seats ?? [
    seatEl('H5', FREE, 0, 100),
    seatEl('H6', FREE, 38, 100),
    seatEl('H7', SOLD, 76, 100),
  ];

  const locator = (sel: string) => ({
    first: () => locator(sel),
    isVisible: async () => (sel === CGV_FLOW.captcha ? !!opts.captcha : false),
    click: async () => { clicks.push(sel); },
    waitFor: async () => {},
  });

  const page = {
    setDefaultTimeout: () => {},
    goto: async () => {},
    locator,
    $$eval: async () => seats,
    getByRole: (role: string, o: { name: unknown }) => {
      const label = String(o.name);
      const node = {
        first: () => node,
        click: async () => { clicks.push(label); },
        waitFor: async () => {},
        count: async () => 1,
        filter: () => ({ ...node, count: async () => 0 }),
      };
      return node;
    },
  };

  return {
    clicks,
    closed,
    launch: async () =>
      ({
        pages: () => [page],
        newPage: async () => page,
        close: async () => { closed.count++; },
      }) as never,
  };
}

describe('CgvSeatHolder', () => {
  /**
   * CGV 는 좌석맵을 브라우저에서만 읽을 수 있다. 폴링 단계에서는 잔여수만
   * 알기 때문에, 홀더가 화면에 들어간 뒤 직접 좌석을 고른다.
   */
  it('후보가 비어 오면 화면에서 직접 고른다', async () => {
    const cgv = fakeCgv();
    const picked: string[] = [];
    const holder = new CgvSeatHolder({
      launch: cgv.launch,
      onPick: (seats) => picked.push(...seats.map((s) => `${s.row}${s.col}`)),
    });

    const session = await holder.hold({
      showtime: showtime(),
      seats: [],
      pick: { block: null, party: { mode: 'single', size: 1 } },
    });

    expect(session.atPayment).toBe(true);
    expect(picked).toHaveLength(1);
    expect(['H5', 'H6']).toContain(picked[0]); // 팔린 H7 은 안 고른다
  });

  it('2연석 조건을 지킨다', async () => {
    const cgv = fakeCgv();
    const picked: string[] = [];
    const holder = new CgvSeatHolder({
      launch: cgv.launch,
      onPick: (seats) => picked.push(...seats.map((s) => `${s.row}${s.col}`)),
    });

    await holder.hold({
      showtime: showtime(),
      seats: [],
      pick: { block: null, party: { mode: 'adjacent', size: 2 } },
    });

    expect(picked).toEqual(['H5', 'H6']);
  });

  it('빈자리가 없으면 잡으려 들지 않는다', async () => {
    const cgv = fakeCgv({ seats: [seatEl('H5', SOLD, 0, 100)] });
    const holder = new CgvSeatHolder({ launch: cgv.launch });

    await expect(
      holder.hold({ showtime: showtime(), seats: [], pick: { block: null, party: { mode: 'single', size: 1 } } }),
    ).rejects.toThrow(CgvNoSeatError);
    expect(cgv.closed.count).toBe(1);
  });

  it('조건에 안 맞으면 왜 안 맞는지 말한다', async () => {
    // 빈자리는 둘인데 통로 건너라 3연석이 안 된다
    const cgv = fakeCgv();
    const holder = new CgvSeatHolder({ launch: cgv.launch });

    await expect(
      holder.hold({
        showtime: showtime(),
        seats: [],
        pick: { block: null, party: { mode: 'adjacent', size: 3 } },
      }),
    ).rejects.toThrow(/3연석 조건에 안 맞/);
  });

  /** CGV 로그인에는 캡차가 있다. 뚫지 않고 사람을 부른다. */
  it('캡차가 뜨면 중단한다', async () => {
    const cgv = fakeCgv({ captcha: true });
    const holder = new CgvSeatHolder({ launch: cgv.launch });

    await expect(
      holder.hold({ showtime: showtime(), seats: [], pick: { block: null, party: { mode: 'single', size: 1 } } }),
    ).rejects.toThrow(CgvCaptchaError);
    expect(cgv.closed.count).toBe(1);
  });

  /**
   * ⛔ 좌석 화면의 "원  결제하기" 와 결제 화면의 "결제하기" 는 이름이 겹친다.
   * 후자를 누르면 돈이 나간다. 우리 코드에는 그 경로가 없어야 한다.
   */
  it('실제 결제 버튼은 누르지 않는다', async () => {
    const cgv = fakeCgv();
    await new CgvSeatHolder({ launch: cgv.launch }).hold({
      showtime: showtime(),
      seats: [],
      pick: { block: null, party: { mode: 'single', size: 1 } },
    });

    expect(cgv.clicks).toContain(CGV_FLOW.toPayment);
    expect(cgv.clicks).not.toContain(CGV_FLOW.payNever);
  });

  it('인원을 좌석보다 먼저 고른다', async () => {
    const cgv = fakeCgv();
    await new CgvSeatHolder({ launch: cgv.launch }).hold({
      showtime: showtime(),
      seats: [],
      pick: { block: null, party: { mode: 'single', size: 1 } },
    });

    const audienceAt = cgv.clicks.indexOf(CGV_FLOW.audience);
    const seatAt = cgv.clicks.findIndex((c) => c.includes('data-seatlocno'));
    expect(audienceAt).toBeGreaterThan(-1);
    expect(audienceAt).toBeLessThan(seatAt);
  });

  it('release 는 여러 번 불려도 한 번만 닫는다', async () => {
    const cgv = fakeCgv();
    const session = await new CgvSeatHolder({ launch: cgv.launch }).hold({
      showtime: showtime(),
      seats: [],
      pick: { block: null, party: { mode: 'single', size: 1 } },
    });

    await session.release();
    await session.release();
    expect(cgv.closed.count).toBe(1);
  });
});

describe('dayName', () => {
  it('날짜 버튼을 일 숫자로 맞춘다', () => {
    const re = dayName(showtime({ playDate: '20260814' })) as RegExp;
    expect(re.test('14')).toBe(true);
    expect(re.test('14 금')).toBe(true);
    expect(re.test('4')).toBe(false);
    expect(re.test('24')).toBe(false);
  });
});
