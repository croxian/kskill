import { describe, expect, it } from 'vitest';

import {
  inWindow,
  matchesSpec,
  normalizeSpec,
  showtimeAt,
  showtimeRef,
  toMinutes,
  type WatchSpec,
} from '../src/core/spec.js';
import type { Showtime } from '../src/types.js';

const base: WatchSpec = {
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
    remainingSeats: 7,
    ...over,
  };
}

describe('normalizeSpec', () => {
  /**
   * 하한은 30초에서 15초로 내렸다. 30초는 요청 하나를 기준으로 삼은 규칙이라
   * 총량과 어긋났다 — 짝이 하나뿐인 감시는 그보다 촘촘해도 서버가 받는
   * 총량은 여전히 적다. 총량은 maxRequestsPerHour 가 지킨다.
   */
  it('폴링 하한을 강제한다', () => {
    expect(normalizeSpec({ ...base, pollFloorSec: 5 }).pollFloorSec).toBe(15);
    expect(normalizeSpec({ ...base, pollFloorSec: 0 }).pollFloorSec).toBe(15);
    expect(normalizeSpec({ ...base, pollFloorSec: 60 }).pollFloorSec).toBe(60);
  });

  it('총량 예산을 받는다', () => {
    expect(normalizeSpec({ ...base, maxRequestsPerHour: 180 }).maxRequestsPerHour).toBe(180);
    expect(normalizeSpec(base).maxRequestsPerHour).toBeUndefined();
  });

  it('단석이면 인원을 1로 고정한다', () => {
    const s = normalizeSpec({ ...base, party: { mode: 'single', size: 4 } });
    expect(s.party).toEqual({ mode: 'single', size: 1 });
  });

  it('연석 최소 인원은 2다', () => {
    const s = normalizeSpec({ ...base, party: { mode: 'adjacent', size: 1 } });
    expect(s.party.size).toBe(2);
  });
});

describe('시간대', () => {
  /** 롯데 실측에 24:35 시작, 25:42 종료 회차가 있다. 24를 넘는 표기를 그대로 받는다. */
  it('심야 회차의 24시 넘는 표기를 처리한다', () => {
    expect(toMinutes('24:35')).toBe(1475);
    expect(inWindow('24:35', [{ from: '21:00', to: '26:00' }])).toBe(true);
    expect(inWindow('24:35', [{ from: '17:00', to: '21:00' }])).toBe(false);
  });

  it('여러 시간대는 OR 로 묶인다', () => {
    const windows = [
      { from: '06:00', to: '11:00' },
      { from: '21:00', to: '26:00' },
    ];
    expect(inWindow('09:30', windows)).toBe(true);
    expect(inWindow('22:40', windows)).toBe(true);
    expect(inWindow('19:10', windows)).toBe(false);
  });

  it('시간대를 비우면 전체 통과', () => {
    expect(inWindow('19:10', [])).toBe(true);
  });
});

describe('matchesSpec', () => {
  it('영화를 비우면 전 상영작', () => {
    expect(matchesSpec(showtime(), base)).toBe(true);
  });

  it('영화 목록은 OR', () => {
    const spec = { ...base, movies: ['24329', '24128'] };
    expect(matchesSpec(showtime({ movieId: '24128' }), spec)).toBe(true);
    expect(matchesSpec(showtime({ movieId: '99999' }), spec)).toBe(false);
  });

  it('상영관을 지정하면 그 관만', () => {
    const spec = { ...base, screens: ['101609'] };
    expect(matchesSpec(showtime({ screenId: '101609' }), spec)).toBe(true);
    expect(matchesSpec(showtime({ screenId: '101602' }), spec)).toBe(false);
  });

  it('축 사이는 AND — 영화가 맞아도 시간대를 벗어나면 탈락', () => {
    const spec = { ...base, movies: ['24128'], windows: [{ from: '06:00', to: '11:00' }] };
    expect(matchesSpec(showtime({ movieId: '24128', startTime: '19:10' }), spec)).toBe(false);
  });
});

describe('showtimeAt', () => {
  it('KST 를 UTC 로 옮긴다', () => {
    // 2026-08-09 19:10 KST = 10:10 UTC
    expect(showtimeAt('20260809', '19:10').toISOString()).toBe('2026-08-09T10:10:00.000Z');
  });

  it('24시 넘는 회차는 다음 날로 넘어간다', () => {
    // 2026-08-09 24:35 KST = 2026-08-10 00:35 KST = 2026-08-09 15:35 UTC
    expect(showtimeAt('20260809', '24:35').toISOString()).toBe('2026-08-09T15:35:00.000Z');
  });

  it('이른 조조도 날짜가 밀리지 않는다', () => {
    // 2026-08-09 06:00 KST = 2026-08-08 21:00 UTC
    expect(showtimeAt('20260809', '06:00').toISOString()).toBe('2026-08-08T21:00:00.000Z');
  });
});

/**
 * 회차 키는 지점까지 넣어야 한다. 상영관 번호는 지점 안에서만 고유해서
 * 용산 018 과 영등포 018 이 한 키로 뭉개진다 — 두 지점을 같이 볼 때
 * 고르지 않은 회차가 걸린다.
 */
describe('showtimeRef', () => {
  const at = (theaterId: string, screenId: string): Showtime => ({
    chain: 'cgv',
    theaterId,
    theaterName: '',
    movieId: '30001323',
    movieName: '오디세이',
    screenId,
    screenName: 'IMAX관',
    playDate: '20260814',
    playSequence: '4',
    startTime: '19:10',
    divisionCode: '*',
    totalSeats: 624,
    remainingSeats: 0,
  });

  it('다른 지점의 같은 상영관·순번을 구분한다', () => {
    expect(showtimeRef(at('0013', '018'))).not.toBe(showtimeRef(at('0059', '018')));
  });

  it('고른 회차만 걸린다', () => {
    const spec = { ...base, showtimes: [showtimeRef(at('0013', '018'))] };
    expect(matchesSpec(at('0013', '018'), spec)).toBe(true);
    expect(matchesSpec(at('0059', '018'), spec)).toBe(false);
    expect(matchesSpec(at('0013', '017'), spec)).toBe(false);
  });

  /** 회차를 집었으면 다른 조건은 볼 필요가 없다. */
  it('회차를 집으면 영화·상영관 조건보다 우선한다', () => {
    const spec = {
      ...base,
      movies: ['다른영화'],
      screenPattern: '4DX',
      showtimes: [showtimeRef(at('0013', '018'))],
    };
    expect(matchesSpec(at('0013', '018'), spec)).toBe(true);
  });
});
