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

/**
 * 화면을 흉내 낸다.
 *
 * `present` 에 없는 이름은 **없는 것처럼 군다** — waitFor 가 던진다.
 * 홀더가 후보를 차례로 시도하는지 보려면 실패하는 후보가 있어야 한다.
 * 기본값은 아무거나 다 있는 화면이다.
 */
function fakeCgv(
  opts: {
    seats?: ReturnType<typeof seatEl>[];
    captcha?: boolean;
    /** 이 술어가 false 를 주는 이름은 화면에 없다. */
    present?(label: string, kind: string): boolean;
  } = {},
) {
  const clicks: string[] = [];
  const tried: string[] = [];
  const closed = { count: 0 };
  const seats = opts.seats ?? [
    seatEl('H5', FREE, 0, 100),
    seatEl('H6', FREE, 38, 100),
    seatEl('H7', SOLD, 76, 100),
  ];
  const has = opts.present ?? (() => true);

  const node = (label: string, kind: string, visible = true) => {
    const self: Record<string, unknown> = {
      first: () => self,
      filter: () => node(label, kind, false), // 필터를 건 쪽은 기본적으로 안 맞는 걸로
      count: async () => (visible && has(label, kind) ? 1 : 0),
      isVisible: async () => visible && has(label, kind),
      waitFor: async () => {
        tried.push(label);
        if (!(visible && has(label, kind))) throw new Error(`없음: ${label}`);
      },
      click: async () => { clicks.push(label); },
    };
    return self;
  };

  const locator = (sel: string) =>
    node(sel, 'locator', sel === CGV_FLOW.captcha ? !!opts.captcha : true);

  const page = {
    setDefaultTimeout: () => {},
    goto: async () => {},
    url: () => 'https://cgv.co.kr/fake',
    locator,
    $$eval: async (sel: string) => (sel.includes('data-seatlocno') ? seats : []),
    getByRole: (kind: string, o: { name: unknown }) => node(String(o.name), kind),
    getByText: (name: unknown) => node(String(name), 'text'),
    getByLabel: (name: unknown) => node(String(name), 'label'),
  };

  return {
    clicks,
    tried,
    closed,
    launch: async () =>
      ({
        pages: () => [page],
        newPage: async () => page,
        close: async () => { closed.count++; },
      }) as never,
  };
}

const PICK_ONE = { block: null, party: { mode: 'single' as const, size: 1 } };

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
      pick: PICK_ONE,
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
      holder.hold({ showtime: showtime(), seats: [], pick: PICK_ONE }),
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
      holder.hold({ showtime: showtime(), seats: [], pick: PICK_ONE }),
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
      pick: PICK_ONE,
    });

    expect(cgv.clicks).toContain(CGV_FLOW.toPayment);
    expect(cgv.clicks).not.toContain(CGV_FLOW.payNever);
  });

  it('인원을 좌석보다 먼저 고른다', async () => {
    const cgv = fakeCgv();
    const steps: string[] = [];
    await new CgvSeatHolder({ launch: cgv.launch, onStep: (s) => steps.push(s) }).hold({
      showtime: showtime(),
      seats: [],
      pick: PICK_ONE,
    });

    const audienceAt = steps.indexOf('인원 선택');
    const seatAt = cgv.clicks.findIndex((c) => c.includes('data-seatlocno'));
    expect(audienceAt).toBeGreaterThan(-1);
    expect(seatAt).toBeGreaterThan(-1);
    // 인원은 좌석보다 먼저 끝나 있어야 한다
    expect(steps.slice(0, audienceAt + 1)).toContain('회차 확정');
  });

  /**
   * codegen 이 뽑아준 셀렉터 하나에만 기대면, 사이트가 조금만 달라도
   * 조용히 멈춘다. 첫 후보가 없으면 다음 후보로 넘어가야 한다.
   */
  it('첫 후보가 없으면 다음 방법으로 넘어간다', async () => {
    // 영화 제목이 button 이 아니라 a 로 그려진 화면.
    const cgv = fakeCgv({ present: (l, kind) => !(kind === 'button' && l.includes('오디세이')) });
    const steps: [string, string | null][] = [];

    const session = await new CgvSeatHolder({
      launch: cgv.launch,
      stepTimeoutMs: 100,
      onStep: (s, how) => steps.push([s, how]),
    }).hold({ showtime: showtime(), seats: [], pick: PICK_ONE });

    expect(session.atPayment).toBe(true);
    const movie = steps.find(([s]) => s === '영화 선택');
    expect(movie?.[1]).toBe('link "오디세이"');
  });

  /** 인원 선택은 화면마다 달라서 못 찾아도 계속 간다. */
  it('인원 선택을 못 찾아도 좌석까지 간다', async () => {
    const cgv = fakeCgv({
      present: (l) => !(l === '선택' || l.includes('성인') || /data-(people|count)/.test(l)),
    });
    const steps: [string, string | null][] = [];

    const session = await new CgvSeatHolder({
      launch: cgv.launch,
      stepTimeoutMs: 100,
      onStep: (s, how) => steps.push([s, how]),
    }).hold({ showtime: showtime(), seats: [], pick: PICK_ONE });

    expect(session.atPayment).toBe(true);
    expect(steps).toContainEqual(['인원 선택', null]);
  });

  /**
   * 필수 단계를 끝내 못 찾으면, 그때 화면에 무엇이 있었는지 같이 던진다.
   * 그게 없으면 사람이 재현해서 다시 찾아야 한다.
   */
  it('단계를 못 찾으면 화면 내용을 실어 던진다', async () => {
    // 느슨한 후보는 정규식 형태로 오므로, 잡음을 걷어내고 견준다.
    const clean = (s: string) => s.replace(/\\s/g, '').replace(/[[\]()*|^$/\s]/g, '');
    const cgv = fakeCgv({ present: (l) => !clean(l).includes('오디세이') });
    const holder = new CgvSeatHolder({ launch: cgv.launch, stepTimeoutMs: 100 });

    await expect(
      holder.hold({ showtime: showtime(), seats: [], pick: PICK_ONE }),
    ).rejects.toThrow(/영화 선택.*시도:/s);
    expect(cgv.closed.count).toBe(1);
  });

  it('release 는 여러 번 불려도 한 번만 닫는다', async () => {
    const cgv = fakeCgv();
    const session = await new CgvSeatHolder({ launch: cgv.launch }).hold({
      showtime: showtime(),
      seats: [],
      pick: PICK_ONE,
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
