import { describe, expect, it } from 'vitest';

import {
  collapseDivisions,
  Dedupe,
  fingerprint,
  risen,
  seatMapKey,
  snapshot,
} from '../src/core/diff.js';
import type { Seat, Showtime } from '../src/types.js';

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

describe('collapseDivisions', () => {
  /**
   * 롯데는 한 회차를 일반석(100)과 리클라이너(960) 두 행으로 준다.
   * 합치지 않으면 같은 좌석맵을 두 번 조회하고, 잔여석도 반쪽만 본다.
   */
  it('구역별로 쪼개진 같은 회차를 하나로 합친다', () => {
    const rows = [
      showtime({ divisionCode: '100', totalSeats: 342, remainingSeats: 6 }),
      showtime({ divisionCode: '960', totalSeats: 18, remainingSeats: 0 }),
    ];
    const merged = collapseDivisions(rows);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.totalSeats).toBe(360);
    expect(merged[0]!.remainingSeats).toBe(6);
    expect(merged[0]!.divisionCode).toBe('*');
  });

  it('다른 회차는 합치지 않는다', () => {
    const rows = [
      showtime({ playSequence: '4', divisionCode: '100' }),
      showtime({ playSequence: '4', divisionCode: '960', totalSeats: 18, remainingSeats: 0 }),
      showtime({ playSequence: '5', divisionCode: '100', startTime: '22:40', remainingSeats: 215 }),
    ];
    expect(collapseDivisions(rows)).toHaveLength(2);
  });

  it('좌석맵 키에는 구역이 들어가지 않는다', () => {
    const a = seatMapKey(showtime({ divisionCode: '100' }));
    const b = seatMapKey(showtime({ divisionCode: '960' }));
    expect(a).toBe(b);
  });
});

describe('risen', () => {
  it('잔여석이 늘어난 회차만 통과시킨다', () => {
    const before = snapshot([showtime({ remainingSeats: 6 })]);
    const after = [showtime({ remainingSeats: 8 })];
    expect(risen(before, after)).toHaveLength(1);
  });

  it('줄어든 건 무시한다 — 남이 예매한 것이다', () => {
    const before = snapshot([showtime({ remainingSeats: 8 })]);
    expect(risen(before, [showtime({ remainingSeats: 6 })])).toHaveLength(0);
  });

  it('그대로면 무시한다', () => {
    const before = snapshot([showtime({ remainingSeats: 6 })]);
    expect(risen(before, [showtime({ remainingSeats: 6 })])).toHaveLength(0);
  });

  it('처음 보는 회차는 통과시키지 않는다', () => {
    // 감시를 막 시작했을 때 전 회차가 한꺼번에 터지는 걸 막는다
    expect(risen(new Map(), [showtime()])).toHaveLength(0);
  });
});

describe('Dedupe', () => {
  const seats: Seat[] = [
    { id: '1J10', row: 'J', col: 10, x: 0, y: 0, group: 3, state: 'free' },
    { id: '1J11', row: 'J', col: 11, x: 283, y: 0, group: 3, state: 'free' },
  ];
  const fp = fingerprint(seats, showtime());

  it('쿨다운 안에서는 한 번만 보낸다', () => {
    const d = new Dedupe(180_000);
    expect(d.shouldSend(fp, 0)).toBe(true);
    expect(d.shouldSend(fp, 60_000)).toBe(false);
    expect(d.shouldSend(fp, 179_999)).toBe(false);
    expect(d.shouldSend(fp, 180_000)).toBe(true);
  });

  it('좌석 조합이 다르면 다른 알림이다', () => {
    const d = new Dedupe();
    const other = fingerprint([seats[0]!], showtime());
    expect(d.shouldSend(fp, 0)).toBe(true);
    expect(d.shouldSend(other, 0)).toBe(true);
  });

  it('좌석 순서가 달라도 같은 지문', () => {
    expect(fingerprint([seats[1]!, seats[0]!], showtime())).toBe(fp);
  });

  it('만료된 항목을 정리해 맵이 무한정 자라지 않게 한다', () => {
    const d = new Dedupe(1000);
    d.shouldSend('a', 0);
    d.shouldSend('b', 0);
    expect(d.size).toBe(2);
    d.prune(2000);
    expect(d.size).toBe(0);
  });
});
