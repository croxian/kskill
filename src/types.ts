/**
 * 체인 중립 도메인 모델.
 *
 * 체인마다 응답 모양이 전부 다르므로 어댑터가 이 타입으로 정규화하고,
 * core/ 아래의 판정 로직은 어느 체인인지 전혀 모른 채 동작한다.
 */

export type Chain = 'lotte' | 'megabox' | 'cgv';

/**
 * blocked = 장애인석·거리두기·고장 등 "비어 있지만 살 수 없는" 좌석.
 * free 와 반드시 구분해야 한다. 합치면 잡을 수 없는 자리에 알림이 간다.
 */
export type SeatState = 'free' | 'sold' | 'blocked';

export interface Seat {
  /** 체인 원본 좌석 ID. 점유 단계에서 그대로 필요하다 (롯데: SeatNo, 예: "1H12"). */
  id: string;
  /** 화면에 표시되는 열 문자. 'H' */
  row: string;
  /** 화면에 표시되는 좌석 번호. 12 */
  col: number;
  /**
   * 물리 좌표. col 이 연속이어도 통로를 사이에 두면 연석이 아니므로 반드시 필요하다.
   * 좌상단 기준, 단위는 체인 내부 좌표계.
   */
  x: number;
  y: number;
  /**
   * 통로로 구분되는 좌석 구획 번호. 값이 다르면 사이에 통로가 있다.
   * 롯데는 SeatColumGroupNo 로 직접 알려준다. 없는 체인은 x 간격으로 추정한다.
   */
  group: number;
  state: SeatState;
  /**
   * 체인 원본 상태 코드. 진단용으로 남긴다.
   *
   * blocked 안에는 성격이 다른 것들이 섞여 있다 — 장애인석처럼 영원히
   * 안 열리는 자리와, 남이 지금 결제 화면에 붙잡고 있어서 곧 돌아올 수도
   * 있는 자리가 같은 버킷에 들어간다. 판정에는 쓰지 않지만, 왜 못 잡는지
   * 알아야 할 때가 있다.
   */
  rawStatus?: number;
  /** 요금/등급 블록. 롯데는 DisplayPhysicalBlockCode. */
  grade?: number;
  /** 체인이 "명당"으로 표시한 좌석. 점수 가점에 쓴다. */
  sweetSpot?: boolean;
}

export interface SeatMap {
  chain: Chain;
  theaterId: string;
  screenId: string;
  playDate: string; // 'YYYYMMDD' (KST)
  playSequence: string;
  seats: Seat[];
  fetchedAt: number;
}

/** 1단 감시가 다루는 단위. 좌석맵 없이 카운트만 들고 있다. */
export interface Showtime {
  chain: Chain;
  theaterId: string;
  theaterName: string;
  movieId: string;
  movieName: string;
  screenId: string;
  screenName: string;
  playDate: string;
  playSequence: string;
  startTime: string; // 'HH:mm'
  /** 좌석 구역 코드. 한 회차가 구역별로 여러 행으로 쪼개져 온다 (롯데: 일반 100 / 리클라이너 960). */
  divisionCode: string;
  totalSeats: number;
  /** 남은 좌석 수. 어댑터가 체인별 함정을 흡수한 뒤의 값이다. */
  remainingSeats: number;
}

export function showtimeKey(s: Showtime): string {
  return `${s.chain}:${s.playDate}:${s.theaterId}:${s.screenId}:${s.playSequence}:${s.divisionCode}`;
}
