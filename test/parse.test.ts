import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { crossCheck, parsePlaySequences, parseSeatMap } from '../src/adapters/lotte/parse.js';
import type { LotteResponse } from '../src/adapters/lotte/client.js';

const raw = JSON.parse(
  readFileSync(new URL('./fixtures/lotte-worldtower-9gwan-seq4.json', import.meta.url), 'utf8'),
) as LotteResponse;

const META = {
  theaterId: '1016',
  screenId: '101609',
  playDate: '20260809',
  playSequence: '4',
};

/**
 * 2026-08-09 월드타워 GetPlaySequence 응답에서 9관(101609) 부분만 그대로 옮긴 것.
 * 한 회차가 구역(ScreenDivisionCode)별로 두 행씩 온다는 점이 핵심이다.
 */
const PLAY_SEQS: LotteResponse = {
  IsOK: true,
  PlaySeqs: {
    Items: [
      { CinemaID: 1016, CinemaNameKR: '월드타워', RepresentationMovieCode: 24128, MovieNameKR: '오디세이', ScreenID: 101609, ScreenNameKR: '9관', PlayDt: '2026-08-09', PlaySequence: 5, StartTime: '22:40', TotalSeatCount: 18,  BookingSeatCount: 6,   ScreenDivisionCode: 960 },
      { CinemaID: 1016, CinemaNameKR: '월드타워', RepresentationMovieCode: 24128, MovieNameKR: '오디세이', ScreenID: 101609, ScreenNameKR: '9관', PlayDt: '2026-08-09', PlaySequence: 4, StartTime: '19:10', TotalSeatCount: 18,  BookingSeatCount: 0,   ScreenDivisionCode: 960 },
      { CinemaID: 1016, CinemaNameKR: '월드타워', RepresentationMovieCode: 24128, MovieNameKR: '오디세이', ScreenID: 101609, ScreenNameKR: '9관', PlayDt: '2026-08-09', PlaySequence: 4, StartTime: '19:10', TotalSeatCount: 342, BookingSeatCount: 7,   ScreenDivisionCode: 100 },
      { CinemaID: 1016, CinemaNameKR: '월드타워', RepresentationMovieCode: 24128, MovieNameKR: '오디세이', ScreenID: 101609, ScreenNameKR: '9관', PlayDt: '2026-08-09', PlaySequence: 5, StartTime: '22:40', TotalSeatCount: 342, BookingSeatCount: 215, ScreenDivisionCode: 100 },
    ],
  },
};

describe('parsePlaySequences', () => {
  const showtimes = parsePlaySequences(PLAY_SEQS);

  it('한 회차가 구역별로 나뉘어 온다', () => {
    const seq4 = showtimes.filter((s) => s.playSequence === '4');
    expect(seq4.map((s) => s.divisionCode).sort()).toEqual(['100', '960']);
  });

  /**
   * 회귀 방지의 핵심.
   *
   * BookingSeatCount 를 "예매된 수"로 읽고 Total - Booking 을 하면
   * 19:10 회차가 335석 여유로 보인다. 실제로는 7석 남은 매진 직전이었다.
   * 이 테스트가 깨지면 알리미 판정이 통째로 뒤집힌다.
   */
  it('BookingSeatCount 를 잔여석으로 읽는다 (Total - Booking 이 아니다)', () => {
    const prime = showtimes.find((s) => s.startTime === '19:10' && s.divisionCode === '100')!;
    expect(prime.remainingSeats).toBe(7);
    expect(prime.remainingSeats).not.toBe(prime.totalSeats - 7);

    const late = showtimes.find((s) => s.startTime === '22:40' && s.divisionCode === '100')!;
    expect(late.remainingSeats).toBe(215);
  });

  it('프라임타임 리클라이너는 매진(잔여 0)으로 읽힌다', () => {
    const recliner = showtimes.find((s) => s.startTime === '19:10' && s.divisionCode === '960')!;
    expect(recliner.remainingSeats).toBe(0);
    expect(recliner.totalSeats).toBe(18);
  });

  it('playDate 를 YYYYMMDD 로 정규화한다', () => {
    expect(showtimes.every((s) => s.playDate === '20260809')).toBe(true);
  });
});

describe('parseSeatMap', () => {
  const map = parseSeatMap(raw, META);

  it('9관 전 좌석을 읽는다', () => {
    expect(map.seats).toHaveLength(360);
  });

  it('SeatStatusCode 0 만 free 로 분류한다', () => {
    const free = map.seats.filter((s) => s.state === 'free');
    expect(free).toHaveLength(6);
    expect(free.map((s) => `${s.row}${s.col}`).sort()).toEqual([
      'C15', 'H4', 'H5', 'J10', 'J11', 'N20',
    ]);
  });

  it('비어 있지만 팔지 않는 좌석은 blocked 로 따로 둔다', () => {
    // 20 / 23 / 28 / 80 = 19석. free 에 섞이면 잡을 수 없는 자리에 알림이 간다.
    expect(map.seats.filter((s) => s.state === 'blocked')).toHaveLength(19);
    expect(map.seats.filter((s) => s.state === 'sold')).toHaveLength(335);
  });

  it('통로 구획 번호를 그대로 가져온다', () => {
    const hist: Record<number, number> = {};
    for (const s of map.seats) hist[s.group] = (hist[s.group] ?? 0) + 1;
    expect(hist).toEqual({ 1: 40, 2: 60, 3: 200, 4: 60 });
  });

  it('점유 단계가 쓸 원본 좌석 ID 를 보존한다', () => {
    const h4 = map.seats.find((s) => s.row === 'H' && s.col === 4)!;
    expect(h4.id).toBe('1H04');
  });

  it('체인이 표시한 명당석을 읽는다', () => {
    expect(map.seats.some((s) => s.sweetSpot)).toBe(true);
  });

  /**
   * blocked 에는 성격이 다른 것들이 섞인다. 장애인석처럼 영원히 안 열리는
   * 자리와, 남이 결제 화면에서 붙잡고 있어 곧 돌아올 자리가 같은 버킷이다.
   * 판정에는 안 쓰지만 왜 못 잡는지 알려면 원본 코드가 필요하다.
   */
  it('원본 상태 코드를 진단용으로 남긴다', () => {
    const sold = map.seats.find((s) => s.state === 'sold')!;
    const blocked = map.seats.find((s) => s.state === 'blocked')!;
    const free = map.seats.find((s) => s.state === 'free')!;

    expect(sold.rawStatus).toBe(50);
    expect(free.rawStatus).toBe(0);
    expect([20, 23, 28, 80]).toContain(blocked.rawStatus);
  });
});

describe('crossCheck', () => {
  const map = parseSeatMap(raw, META);

  it('좌석맵 잔여수와 회차 카운트가 맞으면 통과', () => {
    const counts = parsePlaySequences({
      PlaySeqs: {
        Items: [
          { CinemaID: 1016, ScreenID: 101609, PlaySequence: 4, TotalSeatCount: 342, BookingSeatCount: 6, ScreenDivisionCode: 100 },
          { CinemaID: 1016, ScreenID: 101609, PlaySequence: 4, TotalSeatCount: 18, BookingSeatCount: 0, ScreenDivisionCode: 960 },
        ],
      },
    });
    expect(crossCheck(map, counts)).toMatchObject({ ok: true, fromSeatMap: 6, fromCounts: 6 });
  });

  it('두 엔드포인트가 어긋나면 잡아낸다', () => {
    const counts = parsePlaySequences(PLAY_SEQS); // 19:10 기준 7석 (30분 전 스냅샷)
    expect(crossCheck(map, counts).ok).toBe(false);
  });
});
