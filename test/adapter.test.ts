import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { createLotteAdapter } from '../src/adapters/lotte/adapter.js';
import type { TheaterRef } from '../src/core/spec.js';
import type { Showtime } from '../src/types.js';

const seatMapRaw = readFileSync(
  new URL('./fixtures/lotte-worldtower-9gwan-seq4.json', import.meta.url),
  'utf8',
);

const PLAY_SEQS = {
  IsOK: true,
  PlaySeqs: {
    Items: [
      { CinemaID: 1016, CinemaNameKR: '월드타워', RepresentationMovieCode: 24128, MovieNameKR: '오디세이', ScreenID: 101609, ScreenNameKR: '9관', PlayDt: '2026-08-09', PlaySequence: 4, StartTime: '19:10', TotalSeatCount: 342, BookingSeatCount: 6, ScreenDivisionCode: 100 },
      { CinemaID: 1004, CinemaNameKR: '건대입구', RepresentationMovieCode: 24128, MovieNameKR: '오디세이', ScreenID: 100401, ScreenNameKR: '1관', PlayDt: '2026-08-09', PlaySequence: 2, StartTime: '20:00', TotalSeatCount: 200, BookingSeatCount: 30, ScreenDivisionCode: 100 },
    ],
  },
};

const THEATERS: TheaterRef[] = [
  { chain: 'lotte', theaterId: '1016', label: '월드타워' },
  { chain: 'lotte', theaterId: '1004', label: '건대입구' },
];

/** paramList 를 되돌려 읽어 요청 내용을 검사한다. */
function captureFetch(body: unknown) {
  const sent: Array<Record<string, unknown>> = [];
  const impl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const form = init?.body as FormData;
    sent.push(JSON.parse(String(form.get('paramList'))));
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, sent };
}

describe('createLotteAdapter — listShowtimes', () => {
  it('실측으로 확인한 파라미터를 그대로 보낸다', async () => {
    const cap = captureFetch(PLAY_SEQS);
    vi.stubGlobal('fetch', cap.impl);

    await createLotteAdapter(THEATERS).listShowtimes(0, '20260809');

    expect(cap.sent[0]).toMatchObject({
      MethodName: 'GetPlaySequence',
      cinemaID: '1|0001|1016', // 지역 탭 코드. 지점 객체의 DivisionCode 가 아니다
      representationMovieCode: '', // 비워야 전 회차가 한 번에 온다
      playDate: '2026-08-09', // 요청은 하이픈 형식
    });
    vi.unstubAllGlobals();
  });

  it('요청한 지점만 남긴다', async () => {
    const cap = captureFetch(PLAY_SEQS);
    vi.stubGlobal('fetch', cap.impl);

    const rows = await createLotteAdapter(THEATERS).listShowtimes(0, '20260809');

    expect(rows).toHaveLength(1);
    expect(rows[0]!.theaterId).toBe('1016');
    vi.unstubAllGlobals();
  });

  it('잔여석을 BookingSeatCount 에서 가져온다', async () => {
    const cap = captureFetch(PLAY_SEQS);
    vi.stubGlobal('fetch', cap.impl);

    const rows = await createLotteAdapter(THEATERS).listShowtimes(0, '20260809');

    expect(rows[0]!.remainingSeats).toBe(6);
    expect(rows[0]!.totalSeats).toBe(342);
    vi.unstubAllGlobals();
  });

  it('없는 지점 인덱스는 조용히 넘어가지 않는다', async () => {
    await expect(createLotteAdapter(THEATERS).listShowtimes(9, '20260809')).rejects.toThrow(
      /지점 인덱스/,
    );
  });
});

describe('createLotteAdapter — fetchSeatMap', () => {
  const showtime: Showtime = {
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
    divisionCode: '*',
    totalSeats: 360,
    remainingSeats: 6,
  };

  it('GetSeats 는 소문자 cinemaId 에 숫자를 넣는다', async () => {
    const cap = captureFetch(JSON.parse(seatMapRaw));
    vi.stubGlobal('fetch', cap.impl);

    await createLotteAdapter(THEATERS).fetchSeatMap(showtime);

    expect(cap.sent[0]).toMatchObject({
      MethodName: 'GetSeats',
      cinemaId: 1016, // 숫자. GetPlaySequence 의 cinemaID 합성 문자열과 다르다
      screenId: 101609,
      playSequence: 4,
      playDate: '2026-08-09',
    });
    vi.unstubAllGlobals();
  });

  it('좌석맵을 도메인 모델로 정규화한다', async () => {
    const cap = captureFetch(JSON.parse(seatMapRaw));
    vi.stubGlobal('fetch', cap.impl);

    const map = await createLotteAdapter(THEATERS).fetchSeatMap(showtime);

    expect(map.seats).toHaveLength(360);
    expect(map.seats.filter((s) => s.state === 'free')).toHaveLength(6);
    expect(map.screenId).toBe('101609');
    vi.unstubAllGlobals();
  });
});

describe('createLotteAdapter — 실패', () => {
  it('HTTP 오류를 던진다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    );

    await expect(createLotteAdapter(THEATERS).listShowtimes(0, '20260809')).rejects.toThrow(
      /503/,
    );
    vi.unstubAllGlobals();
  });

  it('IsOK=false 를 성공으로 착각하지 않는다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ IsOK: false, ResultMessage: '조회 불가' }),
      })),
    );

    await expect(createLotteAdapter(THEATERS).listShowtimes(0, '20260809')).rejects.toThrow(
      /조회 불가/,
    );
    vi.unstubAllGlobals();
  });
});
