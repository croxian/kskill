/**
 * 롯데시네마 예매 화면 셀렉터.
 *
 * 2026-08-09 에 playwright codegen 으로 실제 예매 흐름을 녹화해 얻었다.
 * 좌석 셀렉터 하나만 아직 추정이다 (아래 SEAT 주석 참고).
 *
 * 로그인 단계는 의도적으로 없다. 아이디·비밀번호를 코드에 넣는 순간
 * 캡차와 이상 로그인 탐지에 걸린다. 사람이 한 번 로그인해 둔
 * 브라우저 프로필(.profile)을 그대로 재사용한다.
 */

export interface LotteFlow {
  /** 예매 진입. codegen 이 잡은 실제 주소다. */
  baseUrl: string;
  /** 상단 내비의 예매 링크. */
  ticketingLink: string;
  /**
   * 지점 목록이 담긴 스크롤 컨테이너.
   * 이걸로 범위를 좁히지 않으면 다른 곳의 같은 이름에 걸린다.
   */
  theaterScope: string;
  /** 성인 인원 스테퍼. 인원을 먼저 정해야 좌석이 눌린다. */
  adultStepper: string;
  /** 청소년 인원 스테퍼. */
  youthStepper: string;
  /** 스테퍼 안의 증가 버튼 이름. */
  stepperPlus: string;
  /** 좌석 선택 단계로 넘어가는 링크. */
  toSeatStep: string;
  /**
   * 좌석 하나. {seat} 자리에 좌석 값이 들어간다.
   *
   * ⚠️ 여기만 아직 실측 전이다.
   * codegen 은 `getByRole('link', { name: '24' }).first()` 를 뱉었는데,
   * 접근성 이름이 좌석 **번호뿐**이라 열이 다른 같은 번호 좌석과 구분되지 않는다.
   * `.first()` 로 넘기면 엉뚱한 열을 클릭한다 — 조용히 틀리는 종류다.
   * 좌석 <a> 의 실제 속성을 보고 채워야 한다.
   */
  seat: string;
  seatKey: SeatKey;
  /** 좌석 선택 후 다음 단계로. 결제 화면의 같은 이름 버튼과 다른 요소다. */
  toPayment: string;
  /** 결제수단 화면에 도달했음을 알리는 요소. 여기 닿으면 멈춘다. */
  paymentMarker: string;
  /** 로그인 안 됐을 때만 보이는 요소. */
  loggedOut: string;
  /** 남은 시간 카운트다운. 롯데는 없다 — 실측으로 확인했다. */
  countdown?: string;
  /** 캡차·대기열. 보이면 즉시 중단한다. 우회하지 않는다. */
  interstitial?: string;
}

/** 좌석 셀렉터의 {seat} 에 무엇을 넣을지. */
export type SeatKey = 'id' | 'label' | 'col';

export const LOTTE_FLOW: LotteFlow = {
  baseUrl: 'https://www.lottecinema.co.kr/NLCHS',
  ticketingLink: '예매',
  theaterScope: '#mCSB_1_container',
  adultStepper: '#person_10',
  youthStepper: '#person_20',
  stepperPlus: '증가',
  toSeatStep: '인원/좌석 선택',
  seat: '[data-seat="{seat}"]', // ← 실측 필요
  seatKey: 'id',
  toPayment: '결제하기',
  paymentMarker: 'text=최종 결제수단',
  loggedOut: 'text=로그인',
  interstitial: 'text=/캡차|보안문자|대기열/',
};

export function seatSelector(
  flow: LotteFlow,
  seat: { id: string; row: string; col: number },
): string {
  const value =
    flow.seatKey === 'id' ? seat.id : flow.seatKey === 'col' ? String(seat.col) : `${seat.row}${seat.col}`;
  return flow.seat.replace('{seat}', value);
}

/**
 * 회차 버튼의 접근성 이름에는 잔여석 수가 들어간다.
 *   "상영시간 17:20 종료 20:22 잔여석 35 / ..."
 * 잔여석은 우리가 보는 사이에도 변하므로 시작 시각으로만 맞춘다.
 */
export function showtimeNamePattern(startTime: string): RegExp {
  return new RegExp(`상영시간\\s*${escapeRe(startTime)}`);
}

/** 영화 링크 이름에는 관람등급이 앞에 붙는다. 제목으로만 맞춘다. */
export function movieNamePattern(movieName: string): RegExp {
  return new RegExp(escapeRe(movieName));
}

/** 날짜 링크 이름은 "11 화" 처럼 일 + 요일이다. */
export function dayNamePattern(playDate: string): RegExp {
  const day = String(Number(playDate.slice(6, 8)));
  return new RegExp(`^\\s*${day}\\s`);
}

/** 자리표시자가 그대로 남아 있으면 아직 실측 전이다. */
export function selectorsAreStubs(flow: LotteFlow): boolean {
  return flow.seat.includes('data-seat=');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
