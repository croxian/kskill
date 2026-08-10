import type { SeatMap, Showtime } from '../types.js';
import type { TheaterRef } from '../core/spec.js';
import { createCgvAdapter } from './cgv/adapter.js';
import { createLotteAdapter } from './lotte/adapter.js';

/**
 * 지점마다 체인이 다를 수 있으므로 인덱스로 갈라 보낸다.
 *
 * 감시 루프는 `listShowtimes(theaterIdx, date)` 만 안다. 어느 체인인지도,
 * 좌석맵을 구할 수 있는지도 모른다. 그 차이가 전부 여기서 흡수된다.
 */
export function createAdapter(theaters: TheaterRef[]) {
  const lotte = createLotteAdapter(theaters);
  const cgv = createCgvAdapter(theaters);

  const chainOf = (idx: number) => theaters[idx]?.chain;

  /**
   * 좌석맵을 구할 수 있는 체인이 하나라도 있는가.
   *
   * CGV 는 아직 좌석맵 경로가 없다 — 서명이 필요한 API 라 좌석 단위 조회를
   * 뚫지 못했고, 브라우저 DOM 에서 읽는 건 점유 단계와 함께 붙일 예정이다.
   * 그때까지는 카운트만으로 알린다. 좌석을 모르는 편이 알림이 없는 것보다 낫다.
   */
  const seatMapChains = new Set<string>(['lotte']);
  const canFetchSeatMap = theaters.some((t) => seatMapChains.has(t.chain));

  return {
    canFetchSeatMap,

    /** CGV 가 접근을 제한했는가. 그러면 감시를 이어갈 이유가 없다. */
    get cgvBlocked() {
      return cgv.blocked;
    },

    async listShowtimes(theaterIdx: number, playDate: string): Promise<Showtime[]> {
      switch (chainOf(theaterIdx)) {
        case 'lotte':
          return lotte.listShowtimes(theaterIdx, playDate);
        case 'cgv':
          return cgv.listShowtimes(theaterIdx, playDate);
        default:
          throw new Error(`지원하지 않는 체인: ${chainOf(theaterIdx) ?? '알 수 없음'}`);
      }
    },

    async fetchSeatMap(showtime: Showtime): Promise<SeatMap> {
      if (showtime.chain !== 'lotte') {
        throw new Error(`${showtime.chain} 은 아직 좌석맵을 지원하지 않습니다`);
      }
      return lotte.fetchSeatMap(showtime);
    },

    async close(): Promise<void> {
      await cgv.close();
    },
  };
}
