/**
 * 예매 화면 셀렉터.
 *
 * ⚠️ 이 파일의 값은 화면 스크린샷에서 읽은 **텍스트 기반 추정**이다.
 * GetPlaySequence / GetSeats 처럼 실측으로 확정한 계약과 다르다.
 * 실제 DOM 을 보고 채워야 한다.
 *
 * 채우는 법 — playwright 가 대신 받아 적어 준다:
 *
 *   npm run record
 *
 * 열린 브라우저에서 예매를 **좌석 선택까지만** 직접 해보면
 * (지점 → 영화 → 회차 → 인원 → 좌석 클릭 → 결제하기),
 * codegen 창에 실제 셀렉터가 줄줄이 찍힌다. 그걸 아래에 옮긴다.
 *
 * 좌석 셀렉터가 특히 중요하다. 좌석 하나를 클릭했을 때 codegen 이 뭐라고
 * 적는지 보고, 좌석 번호가 들어가는 자리를 {seat} 로 바꾸면 된다.
 * 예) '[data-seat="1H04"]'  →  '[data-seat="{seat}"]'
 */

export interface SelectorSet {
  /** 로그인 여부 판별. 이 요소가 보이면 로그인 안 된 것으로 본다. */
  loggedOut: string;
  /** 성인 인원 늘리기 버튼. 인원을 먼저 정해야 좌석이 눌린다. */
  adultPlus: string;
  /** 청소년 인원 늘리기 버튼. */
  youthPlus: string;
  /**
   * 좌석 하나. {seat} 자리에 좌석 ID 나 라벨이 들어간다.
   * 어떤 값이 들어가는지는 codegen 결과를 보고 seatKey 로 정한다.
   */
  seat: string;
  /** 좌석 선택 후 다음 단계로. */
  toPayment: string;
  /** 결제 화면에 도달했음을 알리는 요소. 여기 닿으면 멈춘다. */
  paymentMarker: string;
  /** 남은 시간 카운트다운. 없으면 undefined — 롯데는 실제로 없다. */
  countdown?: string;
  /** 캡차·대기열. 보이면 즉시 중단한다. 우회하지 않는다. */
  interstitial?: string;
}

/** 좌석 셀렉터의 {seat} 에 무엇을 넣을지. codegen 결과를 보고 고른다. */
export type SeatKey = 'id' | 'label';

export interface HoldSelectors extends SelectorSet {
  seatKey: SeatKey;
}

/**
 * 스크린샷에서 읽은 텍스트로 채운 초기값.
 *
 * 버튼 라벨("결제하기", "성인")은 화면에 그대로 보이므로 맞을 가능성이 높다.
 * 좌석 셀렉터는 순수한 자리표시자다 — 반드시 codegen 으로 확인해야 한다.
 */
export const LOTTE_SELECTORS: HoldSelectors = {
  loggedOut: 'text=로그인',
  adultPlus: 'xpath=//*[contains(text(),"성인")]/following::button[1]',
  youthPlus: 'xpath=//*[contains(text(),"청소년")]/following::button[1]',
  seat: '[data-seat-id="{seat}"]', // ← 반드시 실측
  seatKey: 'id',
  toPayment: 'text=결제하기',
  paymentMarker: 'text=최종 결제수단',
  interstitial: 'text=/캡차|보안문자|대기열/',
};

export function seatSelector(sel: HoldSelectors, seat: { id: string; row: string; col: number }): string {
  const value = sel.seatKey === 'id' ? seat.id : `${seat.row}${seat.col}`;
  return sel.seat.replace('{seat}', value);
}

/** 자리표시자가 그대로 남아 있으면 아직 실측 전이다. */
export function selectorsAreStubs(sel: HoldSelectors): boolean {
  return sel.seat.includes('data-seat-id');
}
