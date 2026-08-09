import type { SeatMap, Showtime } from '../../types.js';
import type { TheaterRef } from '../../core/spec.js';
import { buildCinemaId, REGION } from './api.js';
import { fetchPlaySequences, fetchSeats, toRequestDate } from './client.js';
import { parsePlaySequences, parseSeatMap } from './parse.js';

/**
 * 감시 루프가 쓰는 조회 두 개를 롯데 구현으로 채운다.
 *
 * 루프는 이 파일 너머를 모른다. 메가박스를 붙일 때도 같은 모양의
 * 어댑터를 하나 더 만들면 되고, 루프와 판정 코드는 손대지 않는다.
 */
export function createLotteAdapter(theaters: TheaterRef[], opts: { timeoutMs?: number } = {}) {
  return {
    async listShowtimes(theaterIdx: number, playDate: string): Promise<Showtime[]> {
      const t = theaters[theaterIdx];
      if (!t) throw new Error(`알 수 없는 지점 인덱스: ${theaterIdx}`);

      const res = await fetchPlaySequences({
        cinemaId: buildCinemaId(t.region ?? REGION.SEOUL, t.theaterId),
        playDate: toRequestDate(playDate),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      });
      // 서버가 다른 지점까지 섞어 줄 수 있으므로 요청한 지점만 남긴다.
      return parsePlaySequences(res).filter((s) => s.theaterId === t.theaterId);
    },

    async fetchSeatMap(s: Showtime): Promise<SeatMap> {
      const res = await fetchSeats({
        theaterId: s.theaterId,
        screenId: s.screenId,
        playDate: toRequestDate(s.playDate),
        playSequence: s.playSequence,
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      });
      return parseSeatMap(res, {
        theaterId: s.theaterId,
        screenId: s.screenId,
        playDate: s.playDate,
        playSequence: s.playSequence,
      });
    },
  };
}
