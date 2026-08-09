/**
 * CGV 예매 화면 셀렉터.
 *
 * 2026-08-09 playwright codegen 녹화에서 얻었다. 롯데와 흐름이 다르다.
 *
 *   예매·예약 → 영화 → 극장 → 극장선택 → 날짜 → 회차 → 확인
 *   → (세션 없으면 여기서 로그인 요구) → 인원 → 좌석 → 선택완료 → 결제
 *
 * 롯데는 극장을 먼저 고르는데 CGV 는 영화를 먼저 고른다.
 */

export interface CgvFlow {
  baseUrl: string;
  /** 상단 예매 진입 */
  ticketing: string;
  /** 극장 목록을 확정하는 버튼. 지점을 고른 뒤 눌러야 다음으로 넘어간다. */
  confirmTheater: string;
  /** 회차를 고른 뒤 확정 */
  confirmShowtime: string;
  /** 인원 선택 */
  audience: string;
  /** 좌석 선택을 마치고 다음 단계로 */
  seatsDone: string;
  /**
   * 좌석 화면에서 결제 화면으로 넘어가는 버튼.
   * 이름에 금액이 붙어 있어 "결제하기" 단독과 구분된다.
   */
  toPayment: string;
  /**
   * ⛔ 실제 결제 버튼. **절대 클릭하지 않는다.**
   *
   * 이 값은 클릭하려고 두는 게 아니라, 결제 화면에 도달했음을 확인하고
   * 거기서 멈추기 위해 둔다. 좌석 화면의 "원 결제하기" 와 이름이 겹치므로
   * exact 로 구분해야 한다 — 헷갈리면 돈이 나간다.
   */
  payNever: string;
  /** 좌석 하나. {seat} 자리에 좌석 값이 들어간다. */
  seat: string;
  /** 로그인 요구 화면에서만 보이는 것. 캡차라 자동 진행이 불가능하다. */
  captcha: string;
  /** 셀렉터를 실제 DOM 으로 확인했는가. */
  measured: boolean;
}

export const CGV_FLOW: CgvFlow = {
  baseUrl: 'https://cgv.co.kr/',
  ticketing: '예매·예약',
  confirmTheater: '극장선택',
  confirmShowtime: '확인',
  audience: '선택',
  seatsDone: '선택완료',
  toPayment: '원  결제하기',
  payNever: '결제하기',
  seat: '[data-seat="{seat}"]', // ← 실측 필요
  captcha: 'text=자동입력 방지문자',
  measured: false,
};

/**
 * 회차 버튼 이름에는 잔여석이 들어간다.
 *   ":30-10:32 128/200석 6관 (Laser)"
 * 우리가 보는 사이에도 변하므로 시작 시각으로만 맞춘다. 롯데와 같은 함정이다.
 */
export function cgvShowtimePattern(startTime: string): RegExp {
  return new RegExp(escapeRe(startTime.slice(-3)) + '-'); // '07:30' → ':30-'
}

/** 상영관 이름도 회차 버튼에 들어 있다. 특별관을 고를 때 교차 확인용. */
export function cgvScreenPattern(screenName: string): RegExp {
  return new RegExp(escapeRe(screenName));
}

export function cgvSeatSelector(flow: CgvFlow, label: string): string {
  return flow.seat.replace('{seat}', label);
}

export function cgvSelectorsAreStubs(flow: CgvFlow): boolean {
  return !flow.measured;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
