import type { Seat, SeatMap, SeatState, Showtime } from '../../types.js';
import { SEAT_STATUS } from './api.js';
import { items, type LotteResponse } from './client.js';

/**
 * 롯데 원본 응답 → 도메인 모델.
 *
 * 이 파일이 존재하는 이유는 롯데 응답에 두 개의 함정이 있기 때문이다.
 * 둘 다 실측으로 확인했고, 여기서 흡수한 뒤로는 아무도 신경 쓸 필요가 없다.
 */

interface RawPlaySeq {
  CinemaID?: string | number;
  CinemaNameKR?: string;
  RepresentationMovieCode?: string | number;
  MovieNameKR?: string;
  ScreenID?: string | number;
  ScreenNameKR?: string;
  PlayDt?: string;
  PlaySequence?: string | number;
  StartTime?: string;
  ScreenDivisionCode?: string | number;
  TotalSeatCount?: number;
  BookingSeatCount?: number;
}

interface RawSeat {
  SeatNo?: string;
  SeatRow?: string;
  SeatColumn?: number;
  ShowSeatRow?: string;
  ShowSeatColumn?: number;
  SeatColumGroupNo?: string | number; // 원문 오타 그대로 (Colum)
  SeatXCoordinate?: number;
  SeatYCoordinate?: number;
  SeatStatusCode?: number;
  DisplayPhysicalBlockCode?: number;
  SweetSpotYN?: string;
}

/**
 * ⚠️ 롯데 API 최대의 함정.
 *
 * `BookingSeatCount` 는 이름과 반대로 **남은 좌석 수**다.
 * "예매된 수"로 읽고 Total - Booking 을 하면 정확히 거꾸로 된 값이 나온다.
 *
 * 2026-08-09 월드타워 9관 실측:
 *   19:10 div100  Total 342  Booking   7  → 사이트 표기 "6 / 342"  (30분 뒤 6)
 *   22:40 div100  Total 342  Booking 215  → 30분 전 사이트 "237 / 342"
 *   19:10 div960  Total  18  Booking   0  → 프라임타임 리클라이너 매진
 *   22:40 div960  Total  18  Booking   6
 *
 * 결정적 근거는 div960 이다. "예매된 수"라면 프라임타임 리클라이너가 0석
 * 팔렸다는 뜻인데 말이 안 된다. "잔여 0 = 매진"으로 읽으면 전부 맞아떨어진다.
 */
export function parsePlaySequences(res: LotteResponse): Showtime[] {
  return items<RawPlaySeq>(res.PlaySeqs)
    .filter((r) => r.CinemaID && r.ScreenID && r.PlaySequence != null)
    .map((r) => ({
      chain: 'lotte' as const,
      theaterId: String(r.CinemaID),
      theaterName: r.CinemaNameKR ?? '',
      movieId: String(r.RepresentationMovieCode ?? ''),
      movieName: r.MovieNameKR ?? '',
      screenId: String(r.ScreenID),
      screenName: r.ScreenNameKR ?? '',
      playDate: (r.PlayDt ?? '').replace(/-/g, ''),
      playSequence: String(r.PlaySequence),
      startTime: normalizeTime(r.StartTime),
      divisionCode: String(r.ScreenDivisionCode ?? ''),
      totalSeats: r.TotalSeatCount ?? 0,
      remainingSeats: r.BookingSeatCount ?? 0, // ← 이름에 속지 말 것
    }));
}

/** '1910' / '19:10' / '19시 10분' 어느 쪽으로 와도 'HH:mm' 으로 맞춘다. */
function normalizeTime(raw: string | undefined): string {
  if (!raw) return '';
  const m = raw.match(/(\d{1,2})\D?(\d{2})/);
  if (!m) return raw;
  return `${m[1]!.padStart(2, '0')}:${m[2]}`;
}

export function parseSeatMap(
  res: LotteResponse,
  meta: { theaterId: string; screenId: string; playDate: string; playSequence: string },
): SeatMap {
  const raw = items<RawSeat>(res.Seats);

  const seats: Seat[] = raw
    .filter((s) => s.SeatNo)
    .map((s) => ({
      id: String(s.SeatNo).trim(),
      row: s.ShowSeatRow ?? s.SeatRow ?? '',
      col: s.ShowSeatColumn ?? s.SeatColumn ?? 0,
      x: s.SeatXCoordinate ?? 0,
      y: s.SeatYCoordinate ?? 0,
      group: Number(s.SeatColumGroupNo ?? 0),
      state: toState(s.SeatStatusCode),
      rawStatus: s.SeatStatusCode,
      grade: s.DisplayPhysicalBlockCode,
      sweetSpot: s.SweetSpotYN === 'Y',
    }));

  return {
    chain: 'lotte',
    theaterId: meta.theaterId,
    screenId: meta.screenId,
    playDate: meta.playDate,
    playSequence: meta.playSequence,
    seats,
    fetchedAt: Date.now(),
  };
}

/**
 * SeatStatusCode 0 만 살 수 있다.
 *
 * 50 은 예매 완료, 그 밖의 값은 "비어 있지만 지금 살 수 없는" 좌석이다.
 * 장애인석·거리두기처럼 영원히 안 열리는 것도 있고, 남이 결제 화면에서
 * 붙잡고 있어 곧 돌아올 수도 있는 것도 있다 — 실측으로 확인했다.
 * 브라우저에서 좌석 하나를 선택하고 결제 화면까지 가자, 밖에서 조회한
 * 그 좌석이 20초 만에 free 에서 벗어났고 잔여수도 19 → 18 로 줄었다.
 *
 * 어느 쪽이든 지금 살 수 없으므로 blocked 로 묶는다. free 에 섞으면
 * 남이 붙잡고 있는 자리에 알림이 간다. 원본 코드는 rawStatus 에 남긴다.
 */
function toState(code: number | undefined): SeatState {
  if (code === SEAT_STATUS.FREE) return 'free';
  if (code === SEAT_STATUS.SOLD) return 'sold';
  if (code === SEAT_STATUS.HELD) return 'held';
  return 'blocked';
}

/**
 * 좌석맵과 회차 카운트를 교차 검증한다.
 *
 * 두 엔드포인트가 서로 다른 계산으로 같은 사실을 말하므로, 어긋나면
 * 둘 중 하나의 계약이 바뀐 것이다. 감시 루프가 조용히 틀린 답을 내기 전에
 * 여기서 시끄럽게 실패하는 편이 낫다.
 */
export function crossCheck(
  map: SeatMap,
  showtimes: Showtime[],
): { ok: boolean; fromSeatMap: number; fromCounts: number } {
  const fromSeatMap = map.seats.filter((s) => s.state === 'free').length;
  const fromCounts = showtimes
    .filter((s) => s.screenId === map.screenId && s.playSequence === map.playSequence)
    .reduce((sum, s) => sum + s.remainingSeats, 0);
  return { ok: fromSeatMap === fromCounts, fromSeatMap, fromCounts };
}
