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
 *
 * minIncrease 는 좌석맵을 못 보는 체인에서 단석·연석을 흉내 내는 수단이다.
 * 한 번에 2석이 풀렸다면 둘이 같이 취소했을 가능성이 크고, 그러면 붙어 있을
 * 가능성도 크다. **보장은 아니다** — 서로 다른 자리 둘이 우연히 같은 주기에
 * 풀렸을 수도 있다. 좌석맵을 보는 롯데에서는 이걸 쓸 이유가 없다.
 */
export function risen(prev: Snapshot, next: Showtime[], minIncrease = 1): Showtime[] {
  const need = Math.max(1, minIncrease);
  return next.filter((s) => {
    const before = prev.get(seatMapKey(s));
    return before !== undefined && s.remainingSeats - before >= need;
  });
}

/** 잔여석이 줄어든 회차. 알릴 일은 아니지만 중복 억제를 되돌릴 신호다. */
export function fell(prev: Snapshot, next: Showtime[]): Showtime[] {
  return next.filter((s) => {
    const before = prev.get(seatMapKey(s));
    return before !== undefined && s.remainingSeats < before;
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
 *
 * 다만 **다시 팔린 뒤에 또 나온 것은 새 사건이다.** 잔여수를 지문에 넣어
 * 두는 바람에 0→1 로 알리고, 1→0 으로 팔리고, 다시 0→1 이 되면 지문이
 * 같아서 쿨다운에 걸려 묻혔다. 감시를 계속 돌려두는 쪽에서는 그게 바로
 * 놓치면 안 되는 순간이다. 그래서 값이 떨어지면 그 회차의 기억을 지운다.
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

  /**
   * 이 회차에 대한 기억을 지운다.
   *
   * 잔여수가 떨어졌다는 건 그 자리가 팔렸다는 뜻이다. 다음에 또 나면
   * 그건 앞서 알린 것과 다른 사건이므로 쿨다운을 적용하면 안 된다.
   */
  forget(keyPrefix: string): void {
    for (const fp of this.sent.keys()) {
      if (fp.startsWith(keyPrefix)) this.sent.delete(fp);
    }
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
