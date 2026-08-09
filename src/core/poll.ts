/**
 * 폴링 간격.
 *
 * 상영 3일 전과 40분 전은 완전히 다른 상황이다. 고정 간격은 둘 다에서 틀린다.
 * 남은 시간에 따라 좁히되, 하한 30초는 어떤 경우에도 깨지 않는다.
 *
 * 간격을 더 줄여도 취소표를 더 잡지는 못한다 — 취소는 초 단위로 쏟아지지
 * 않는다. 차단 확률만 올라간다. 잡을 확률을 올리려면 간격이 아니라
 * 감시 대상 회차 수를 늘려야 한다.
 */

export const STOP = 0;

export interface IntervalOpts {
  floorSec?: number;
  /**
   * 판매가 실제로 끝나는 시각. 체인이 알려주면 이걸 쓴다.
   * stopBeforeMin 보다 우선한다 — 어림짐작보다 실제 값이 낫다.
   */
  stopAt?: Date;
  /** stopAt 이 없을 때만. 상영 이만큼 안쪽이면 감시 종료. */
  stopBeforeMin?: number;
  /** 정각 동시요청을 흩기 위한 흔들림 비율. 테스트에서는 0 으로 준다. */
  jitter?: number;
  random?: () => number;
}

/**
 * 다음 폴링까지 밀리초. 0 이면 이 회차 감시를 끝낸다.
 *
 *   3일 초과   30분   취소가 드물고 나도 급하지 않다
 *   1~3일      10분   일정 변경 취소가 시작된다
 *   3~24시간    3분   취소 밀도가 가장 높은 구간
 *   30분~3시간 45초   노쇼 취소와 결제 실패 좌석이 풀린다
 *   30분 미만  중단
 */
export function intervalMs(showAt: Date, now: number, opts: IntervalOpts = {}): number {
  const { floorSec = 30, stopAt, stopBeforeMin = 30, jitter = 0.25, random = Math.random } = opts;

  const minsLeft = (showAt.getTime() - now) / 60_000;
  if (stopAt) {
    if (now >= stopAt.getTime()) return STOP;
  } else if (minsLeft <= stopBeforeMin) {
    return STOP;
  }

  const hoursLeft = minsLeft / 60;
  const base =
    hoursLeft > 72 ? 1800 : hoursLeft > 24 ? 600 : hoursLeft > 3 ? 180 : 45;

  const sec = Math.max(base, floorSec);
  return Math.round((sec + random() * sec * jitter) * 1000);
}

/**
 * 여러 회차를 한 루프로 감시할 때의 다음 깨어날 시각.
 * 가장 급한 회차에 맞추되, 살아 있는 회차가 없으면 STOP.
 */
export function nextWakeMs(
  entries: Array<Date | { showAt: Date; stopAt?: Date }>,
  now: number,
  opts: IntervalOpts = {},
): number {
  const alive = entries
    .map((e) =>
      e instanceof Date
        ? intervalMs(e, now, opts)
        : intervalMs(e.showAt, now, { ...opts, ...(e.stopAt ? { stopAt: e.stopAt } : {}) }),
    )
    .filter((ms) => ms !== STOP);
  return alive.length === 0 ? STOP : Math.min(...alive);
}
