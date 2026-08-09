/**
 * CGV 예매 API 계약.
 *
 * 롯데와 달리 요청에 서명이 필요하다.
 *   X-TIMESTAMP  유닉스 초
 *   X-SIGNATURE  base64( HMAC-SHA256( secret, `${timestamp}|${path}|${body}` ) )
 *
 * 서명 키는 공개 npm 패키지 `daiso` 의 번들에 그대로 들어 있는 값이다.
 * 클라이언트에 박아 배포하는 종류라 사실상 공개지만, 언제든 바뀔 수 있으니
 * 여기서 한 번에 갈아끼울 수 있게 상수로 둔다.
 */

export const CGV = {
  BASE_URL: 'https://api.cgv.co.kr',
  COMPANY_CODE: 'A420',
  SIGNING_SECRET: 'ydqXY0ocnFLmJGHr_zNzFcpjwAsXq_8JcBNURAkRscg',

  /** 지점 목록 */
  THEATER_LIST: '/cnm/atkt/searchRegnList',
  /** 한 지점의 하루치 전 회차 */
  TIMETABLE_BY_SITE: '/cnm/atkt/searchMovScnInfo',
  /** 한 영화의 회차 */
  TIMETABLE_BY_MOVIE: '/cnm/atkt/searchSchByMov',

  /** 지점 기준 조회 */
  SCOPE_BY_SITE: '08',
  /** 영화 기준 조회 */
  SCOPE_BY_MOVIE: '01',
} as const;

/**
 * 우리가 아는 응답 필드.
 *
 * daiso 는 이 중 일부만 매핑해서 넘긴다. 직접 호출하면 원본이 그대로 오므로
 * 상영관 이름 같은 걸 더 건질 수 있다 — IMAX 를 좌석 수로 추측하지 않아도 된다.
 * 실제로 무엇이 오는지는 scripts/cgv-raw.ts 로 확인한다.
 */
export interface CgvScnItem {
  siteNo?: string;
  siteNm?: string;
  scnYmd?: string;
  /** 회차 순번. daiso 가 scheduleId 를 만들 때 쓰는 조각인데 고유하지 않다. */
  scnSseq?: string | number;
  movNo?: string;
  movNm?: string;
  prodNm?: string;
  scnsrtTm?: string;
  scnendTm?: string;
  /** 총 좌석 수 */
  stcnt?: number | string;
  /** 판매 가능 좌석 수 */
  frSeatCnt?: number | string;
  frtmpSeatCnt?: number | string;
  [key: string]: unknown;
}

/**
 * ⚠️ CGV 는 회차 고유 식별자를 주지 않는다.
 *
 * 실측: 용산아이파크몰 8/14 응답에서 daiso 가 만든 scheduleId
 * `2026081400131` 하나에 06:40 · 06:50 · 07:00 · 07:25 · 07:30 다섯 회차가
 * 붙어 있었다. 좌석 수도 190·134·201·142·624 로 제각각이라 상영관 번호도 아니다.
 *
 * 그래서 (지점, 날짜, 영화, 시작시각) 으로 회차를 특정한다.
 * 브라우저로 좌석을 잡을 때도 시작 시각으로 회차를 클릭하므로 일관된다.
 */
export function cgvShowtimeKey(
  theaterCode: string,
  playDate: string,
  movieCode: string,
  startTime: string,
): string {
  return `${theaterCode}:${playDate}:${movieCode}:${startTime}`;
}
