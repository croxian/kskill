import type { Seat, Showtime } from '../types.js';

/**
 * 변화 감지.
 *
 * 1단 감시의 전부다. 매번 전 회차의 좌석맵을 뜯으면 요청이 수십 배로 뛰므로,
 * 값싼 카운트로 훑다가 **늘어난 회차만** 2단으로 넘긴다.
 */

/** 좌석맵 조회 단위. 구역이 달라도 GetSeats 는 한 번이면 된다. */
export function seatMapKey(s: {
  chain: string;
  playDate: string;
  theaterId: string;
  screenId: string;
  playSequence: string;
}): string {
  return `${s.chain}:${s.playDate}:${s.theaterId}:${s.screenId}:${s.playSequence}`;
}

/**
 * 구역별로 쪼개져 온 회차를 하나로 합친다.
 *
 * 롯데는 한 회차를 일반석(100)과 리클라이너(960) 두 행으로 준다.
 * 그대로 순회하면 같은 좌석맵을 두 번 조회하게 되고, 잔여석도 반쪽만 본다.
 * GetSeats 는 구역과 무관하게 전 좌석을 주므로 여기서 합치는 게 맞다.
 */
export function collapseDivisions(showtimes: Showtime[]): Showtime[] {
  const merged = new Map<string, Showtime>();

  for (const s of showtimes) {
    const key = seatMapKey(s);
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...s, divisionCode: '*' });
      continue;
    }
    merged.set(key, {
      ...prev,
      totalSeats: prev.totalSeats + s.totalSeats,
      remainingSeats: prev.remainingSeats + s.remainingSeats,
    });
  }
  return [...merged.values()];
}

/** key → 잔여석 수 */
export type Snapshot = Map<string, number>;

export function snapshot(showtimes: Showtime[]): Snapshot {
  return new Map(showtimes.map((s) => [seatMapKey(s), s.remainingSeats]));
}

/**
 * 잔여석이 **늘어난** 회차만 통과시킨다.
 *
 * 줄어든 건 남이 예매한 것이라 관심 없다. 처음 보는 회차도 통과시키지 않는다 —
 * 감시를 막 시작했을 때 전 회차가 한꺼번에 터지는 걸 막는다.
 * 첫 관측에서 현재 상태를 알고 싶으면 호출부에서 coldStart 로 처리한다.
 */
export function risen(prev: Snapshot, next: Showtime[]): Showtime[] {
  return next.filter((s) => {
    const before = prev.get(seatMapKey(s));
    return before !== undefined && s.remainingSeats > before;
  });
}

/**
 * 같은 좌석 묶음을 반복해서 알리지 않기 위한 지문.
 * 좌석 조합이 바뀌면 다른 알림으로 친다.
 */
export function fingerprint(seats: Seat[], showtime: Showtime): string {
  const ids = seats.map((s) => s.id).sort().join(',');
  return `${seatMapKey(showtime)}|${ids}`;
}

/**
 * 중복 억제.
 *
 * 취소표가 나왔다 들어갔다 하면 같은 자리로 알림이 연달아 온다.
 * 쿨다운 안에서는 한 번만 보낸다.
 */
export class Dedupe {
  private readonly sent = new Map<string, number>();

  constructor(private readonly cooldownMs = 180_000) {}

  shouldSend(fp: string, now: number): boolean {
    const last = this.sent.get(fp);
    if (last !== undefined && now - last < this.cooldownMs) return false;
    this.sent.set(fp, now);
    return true;
  }

  /** 만료된 항목 정리. 장시간 감시에서 맵이 무한정 자라지 않게 한다. */
  prune(now: number): void {
    for (const [fp, at] of this.sent) {
      if (now - at >= this.cooldownMs) this.sent.delete(fp);
    }
  }

  get size(): number {
    return this.sent.size;
  }
}
