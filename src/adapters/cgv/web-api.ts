/**
 * CGV 웹 예매 API.
 *
 * `api.cgv.co.kr` 과는 **다른 계열이다.** 그쪽은 HMAC 서명이 필요하고
 * Node 에서 부르면 403 이지만, 이쪽은 웹앱이 자기 출처로 부르는 평범한
 * REST 라 서명 헤더가 없다. 대신 세션 쿠키와 custNo 로 사람을 가린다.
 *
 * 2026-08-10 실측(scripts/cgv-explore.ts). 한 번 예매하면 44종이 오간다.
 * 여기 적은 것은 우리가 실제로 쓸 것만이다.
 *
 * ⚠️ custNo 는 계정 식별자다. 코드에도 설정 파일에도 넣지 않는다 —
 * 로그인된 브라우저에서 읽는다.
 */

export const CGV_WEB = {
  BASE_URL: 'https://cgv.co.kr/api/v1',
  COMPANY_CODE: 'A420',

  /**
   * 회차 목록. 우리가 api.cgv.co.kr 에서 쓰던 것과 같은 내용이 온다.
   *   coCd, siteNo, scnYmd, movNo, rtctlScopCd='08', custNo
   * movNo 를 비우면 그 지점 전 회차가 온다.
   */
  TIMETABLE: '/booking/searchSchByMov',

  /**
   * 좌석맵. **이게 우리가 찾던 것이다.**
   *   coCd, siteNo, scnYmd, scnsNo, scnSseq, custNo
   * data.items[0] 안에 seats·seatArea·szones·sblcks·salfrms·stknds 가 있다.
   *
   * 이걸 폴링 2단으로 쓰면 좌석 블록과 연석 조건이 CGV 알림에서도 걸린다.
   * 지금은 잔여수만 보고 알리느라 조건이 통째로 무시된다.
   */
  SEAT_MAP: '/booking/searchIfSeatData',

  /**
   * 회차 상세. 총 좌석(stcnt)과 예매된 수(movbktCnt)가 같이 온다.
   * 잔여 = stcnt - movbktCnt 로 교차 검증할 수 있다.
   */
  SHOWTIME_INFO: '/booking/searchAtktAdncSeatInfo',

  /**
   * ⭐ 좌석 임시 점유. 예매 화면을 밟지 않고도 자리를 잡는 호출이다.
   *
   * POST 본문:
   *   coCd, siteNo, scnYmd, scnsNo, scnSseq, custNo, sachlCd='10',
   *   atktChnlCd='01', sachlTypCd='01', rtctlScopCd='08', cusgdCd='01',
   *   seatPrmpDataList: [{ seatRowNm, seatNo, seatLocNo, sbordNo, seatAreaNo, szoneNo }]
   *
   * 응답에 **seatTempPrmpLimitDt** 가 온다 — 'YYYYMMDDHHmmss' 형식의
   * 서버 만료 시각이다. 지금까지는 만료를 몰라서 5분으로 어림했는데,
   * 이제 서버가 정한 값을 그대로 쓸 수 있다.
   *
   * movAtktNo 도 함께 온다. 해제할 때 필요할 가능성이 크다.
   */
  SEAT_HOLD: '/content/seatTemp/seatTempPrmp',

  /** 고른 좌석의 가격. 점유 직전에 웹앱이 부른다. */
  SEAT_PRICE: '/booking/searchMovAtktSeatPrcList',

  /** 지점 기준 조회 */
  SCOPE_BY_SITE: '08',
} as const;

/**
 * 'YYYYMMDDHHmmss' → epoch ms. KST 로 읽는다.
 *
 * seatTempPrmpLimitDt 가 이 형식으로 온다. 시간대 표시가 없어서 UTC 로
 * 읽으면 9시간 뒤로 밀리고, 그러면 만료된 좌석을 계속 붙들고 있다고 믿는다.
 */
export function parsePrmpLimit(s: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m;
  return Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +sec!) - 9 * 3_600_000;
}
