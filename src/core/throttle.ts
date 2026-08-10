/**
 * 서버가 밀어내면 물러선다.
 *
 * CGV 는 429 나 Retry-After 같은 점잖은 신호를 주지 않는다. 2026-08-10 에
 * 우리가 받은 것은 곧바로 IP 차단이었다. 그래서 신호를 두 단으로 나눈다.
 *
 *   단단한 차단  "이용이 제한되었어요" → 멈춘다. 되돌릴 여지가 없다.
 *   그 밖의 거절  429 · 403 · 503 · 타임아웃 → 간격을 늘린다.
 *
 * 뒤엣것은 아직 협상의 여지가 있는 상태다. 같은 속도로 계속 두드리면
 * 앞엣것이 된다. 그래서 물러섰다가, 조용하면 천천히 돌아온다.
 *
 * **올라가지는 않는다.** 설정한 예산이 천장이고, 여기서는 그 아래로만
 * 움직인다. "차단당할 때까지 올려본다" 는 탐색은 하지 않는다 —
 * 되먹임 신호가 처벌뿐인 곳에서 쓸 수 있는 방법이 아니다.
 */

export interface BackoffOpts {
  /** 한 번 밀릴 때 간격을 몇 배로. */
  factor?: number;
  /** 아무리 밀려도 이 배수를 넘지 않는다. 넘어가면 사실상 감시가 아니다. */
  maxLevel?: number;
  /** 이만큼 연속으로 조용하면 한 단 돌아온다. */
  easeAfter?: number;
}

export class Backoff {
  private level = 0;
  private quiet = 0;
  private readonly factor: number;
  private readonly maxLevel: number;
  private readonly easeAfter: number;

  constructor(opts: BackoffOpts = {}) {
    this.factor = opts.factor ?? 2;
    this.maxLevel = opts.maxLevel ?? 4;
    this.easeAfter = opts.easeAfter ?? 5;
  }

  /** 지금 간격에 곱할 배수. */
  get multiplier(): number {
    return this.factor ** this.level;
  }

  get steps(): number {
    return this.level;
  }

  /** 밀렸다. 한 단 물러선다. 이미 바닥이면 그대로. */
  trip(): boolean {
    this.quiet = 0;
    if (this.level >= this.maxLevel) return false;
    this.level++;
    return true;
  }

  /**
   * 한 바퀴 무사히 돌았다.
   *
   * 바로 돌아오지 않는다. 한 번 성공했다고 원래 속도로 뛰면 밀리고 돌아오기를
   * 반복하면서 평균적으로는 계속 두드리는 꼴이 된다.
   */
  ease(): boolean {
    if (this.level === 0) return false;
    if (++this.quiet < this.easeAfter) return false;
    this.quiet = 0;
    this.level--;
    return true;
  }
}

/**
 * 물러설 만한 거절인가.
 *
 * 단단한 차단(CgvBlockedError)은 여기서 잡지 않는다. 그건 물러설 게 아니라
 * 멈출 일이고, 호출부가 따로 처리한다.
 */
export function isThrottled(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message;
  return (
    /HTTP (429|403|503|509)/.test(m) ||
    /too many requests/i.test(m) ||
    /rate.?limit/i.test(m) ||
    /timeout/i.test(m)
  );
}
