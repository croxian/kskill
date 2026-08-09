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
  /** 상영관 번호. daiso 가 버리는 필드인데 회차를 고유하게 만드는 열쇠다. */
  scnsNo?: string;
  /** 상영관 이름. "1관 (Laser)" 처럼 관 종류가 들어 있다. */
  scnsNm?: string;
  /** 전시용 상영관 이름. 제휴 브랜드가 붙기도 한다. */
  expoScnsNm?: string;
  scnYmd?: string;
  /** 회차 순번. 상영관 안에서만 고유하다. scnsNo 와 함께 써야 한다. */
  scnSseq?: string | number;
  /** 판매 종료 시각 'HHmm'. 언제까지 감시할지를 여기서 정할 수 있다. */
  salEndTm?: string;
  /** 1회 최대 예매 가능 매수. */
  atktPsblQty?: string | number;
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
 * 회차 고유 키.
 *
 * daiso 는 scheduleId 를 `scnYmd + siteNo + scnSseq` 로 조립하면서
 * **상영관을 빼먹었다.** 그래서 서로 다른 관의 같은 순번 회차가 한 ID 로
 * 뭉개졌다 — 실측에서 `2026081400131` 하나에 06:40·07:00·07:30 이 붙어
 * 있었고 좌석 수도 190·201·624 로 제각각이었다.
 *
 * scnsNo 를 넣으면 해결된다. 직접 호출하면 그 필드가 그대로 온다.
 */
export function cgvShowtimeKey(
  theaterCode: string,
  playDate: string,
  screenNo: string,
  scnSseq: string,
): string {
  return `${theaterCode}:${playDate}:${screenNo}:${scnSseq}`;
}
