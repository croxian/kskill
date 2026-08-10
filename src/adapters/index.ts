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
   * CGV 는 좌석맵을 쓰지 않는다. 경로를 못 찾아서가 아니라 **안 쓰기로 한
   * 것이다.** searchIfSeatData 로 좌석을 다 받아올 수 있다는 건 확인했고
   * 파서까지 있다(cgv/web-parse.ts). 그런데 그 경로를 반복 호출하다가
   * 2026-08-10 에 차단당했다. 잔여수 조회는 다른 호스트이고 탈이 없었다.
   *
   * 그래서 CGV 는 카운트만 본다. 좌석 블록·연석 조건은 걸리지 않고,
   * 그 사실을 알림 안에 적는다 — 조용히 무시하면 오해한다.
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
