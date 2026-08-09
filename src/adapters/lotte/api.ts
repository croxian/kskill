/**
 * 롯데시네마 예매 API 계약.
 *
 * 2026-08-09 에 실제 예매 화면(www.lottecinema.co.kr)의 DevTools Network 탭에서
 * 직접 캡처해 확인한 값이다. 추측한 값은 하나도 없다.
 *
 * 모든 호출이 같은 엔드포인트로 가고, FormData 필드 `paramList` 에
 * JSON 문자열을 실어 MethodName 으로 분기한다.
 */

export const LOTTE = {
  BASE_URL: 'https://www.lottecinema.co.kr',
  TICKETING_PATH: '/LCWS/Ticketing/TicketingData.aspx',

  METHODS: {
    /** 전체 지점 + 전체 상영작 목록 */
    TICKETING_PAGE: 'GetTicketingPageTOBE',
    /** 회차 + 구역별 잔여석 */
    PLAY_SEQUENCE: 'GetPlaySequence',
    /** 좌석 단위 배치도 */
    SEATS: 'GetSeats',
  },

  /** 모든 요청에 공통으로 실리는 필드 */
  COMMON: {
    channelType: 'HO',
    osType: 'W',
    osVersion:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  },
} as const;

/**
 * GetSeats 응답의 SeatStatusCode.
 *
 * 9관 360석 실측으로 검산했다:
 *   0(6) + 50(335) + 28(13) + 80(3) + 23(2) + 20(1) = 360
 *   BookingSeats 354 = 360 - 6  → 0 만 판매 가능
 * 사이트 표기 "6 / 342" 와 정확히 일치한다.
 */
export const SEAT_STATUS = {
  /** 판매 가능 — 우리가 노리는 상태 */
  FREE: 0,
  /** 예매 완료 */
  SOLD: 50,
} as const;

/**
 * 좌석 구역(ScreenDivisionCode). GetPlaySequence 가 구역마다 별도 행으로 준다.
 * 9관 = 일반 342석(100) + 리클라이너 18석(960).
 */
export const SCREEN_DIVISION = {
  NORMAL: '100',
  RECLINER: '960',
} as const;

/**
 * GetPlaySequence 의 cinemaID 는 지점 ID 단독이 아니라 합성 키다.
 *
 *   "{divisionCode}|{detailDivisionCode}|{theaterId}"   예) "1|0001|1016"
 *
 * ⚠️ 앞의 두 조각은 지점 고유 속성이 아니라 **조회 축**이다.
 * GetTicketingPageTOBE 응답의 지점 객체에 붙어 있는 DivisionCode/DetailDivisionCode
 * (월드타워의 경우 2|0960)를 그대로 쓰면 서버가 빈 배열을 돌려준다.
 * 실제 예매 화면은 지역 탭 코드를 쓴다: 서울 = 1|0001.
 *
 * daiso(@nomadamas/k-skill 의 korean-cinema-search 경유)가 정확히 이 지점에서
 * 틀려서 월드타워 40개 회차 중 0개를 반환했다. 실측 비교:
 *   1|0001|1016 → 40 showtimes
 *   2|0960|1016 →  0 showtimes
 */
export const REGION = {
  SEOUL: { division: '1', detail: '0001' },
} as const;

export function buildCinemaId(
  region: { division: string; detail: string },
  theaterId: string,
): string {
  return `${region.division}|${region.detail}|${theaterId}`;
}
