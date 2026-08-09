import type { Seat, Showtime } from '../types.js';
import type { SeatBlock } from '../core/block.js';
import type { PartySpec } from '../core/runs.js';

/**
 * 좌석 확보의 안전 규칙을 코드로 강제한다.
 *
 * 기술은 스나이핑 봇과 같다. 다른 건 운영 규칙뿐이라, 규칙을 문서에만
 * 적어두면 아무 의미가 없다. 여기서 지키는 것:
 *
 *   1. 동시 홀드 1건. 여러 회차를 동시에 잡아두지 않는다
 *   2. 미결제 즉시 해제. 만료를 기다리지 않는다
 *   3. 재시도 상한. 같은 회차 3회
 *   4. 결제는 사람. 이 코드는 결제 버튼을 절대 누르지 않는다
 */

export interface HoldRequest {
  showtime: Showtime;
  /**
   * 잡을 좌석. 비어 있으면 홀더가 직접 고른다.
   *
   * 롯데는 폴링 때 좌석맵을 미리 뜯어 후보를 정해 두지만, CGV 는 좌석맵을
   * 브라우저에서만 읽을 수 있다. 그래서 CGV 홀더는 화면에 들어간 뒤에야
   * 좌석을 알 수 있고, 그때 pick 조건으로 직접 고른다.
   */
  seats: Seat[];
  /** seats 가 비었을 때 홀더가 쓸 선택 조건. */
  pick?: { block: SeatBlock | null; party: PartySpec };
}

/** 실제로 좌석을 잡는 주체. Playwright 구현과 테스트용 가짜가 이걸 만족한다. */
export interface SeatHolder {
  hold(req: HoldRequest): Promise<HeldSession>;
}

export interface HeldSession {
  /** 결제 화면에 도달했는가. false 면 좌석을 잡지 못한 것이다. */
  atPayment: boolean;
  /** 화면에서 읽어낸 만료 시각. 롯데는 카운트다운이 없어 보통 undefined. */
  deadline?: number;
  /** 좌석을 놓아준다. 여러 번 불려도 안전해야 한다. */
  release(): Promise<void>;
}

export interface HoldManagerDeps {
  holder: SeatHolder;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** 남은 시간을 알린다. 같은 메시지를 고쳐 쓰는 쪽이 좋다. */
  onCountdown(req: HoldRequest, secondsLeft: number): Promise<void>;
  onHeld?(req: HoldRequest, secondsLeft: number): Promise<void>;
  onReleased?(req: HoldRequest, reason: ReleaseReason): Promise<void>;
  onError?(req: HoldRequest, err: unknown): void;
}

export type ReleaseReason = 'expired' | 'cancelled' | 'failed';

export interface HoldManagerOpts {
  /**
   * 스스로 정한 홀드 상한(초).
   *
   * 롯데는 결제 화면에 카운트다운을 보여주지 않아 서버 만료 시각을 알 수 없다.
   * 실측으로는 5분 안팎이었다. 서버보다 먼저 놓아주는 편이 안전하므로
   * 보수적으로 잡고, 화면에서 읽을 수 있으면 그 값을 우선한다.
   */
  holdSeconds?: number;
  /** 남은 시간을 알리는 간격(초). */
  tickSeconds?: number;
  /** 같은 회차 재시도 상한. */
  maxAttempts?: number;
}

export class HoldBusyError extends Error {
  constructor() {
    super('이미 다른 좌석을 확보 중입니다');
    this.name = 'HoldBusyError';
  }
}

export class HoldManager {
  private active: { req: HoldRequest; session: HeldSession } | null = null;
  private cancelled = false;
  private readonly attempts = new Map<string, number>();
  private readonly holdSeconds: number;
  private readonly tickSeconds: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly deps: HoldManagerDeps,
    opts: HoldManagerOpts = {},
  ) {
    this.holdSeconds = opts.holdSeconds ?? 300;
    this.tickSeconds = opts.tickSeconds ?? 30;
    this.maxAttempts = opts.maxAttempts ?? 3;
  }

  get busy(): boolean {
    return this.active !== null;
  }

  attemptsFor(showtime: Showtime): number {
    return this.attempts.get(key(showtime)) ?? 0;
  }

  /** 사람이 "건너뛰기" 를 눌렀을 때. 만료를 기다리지 않고 바로 놓아준다. */
  cancel(): void {
    this.cancelled = true;
  }

  /**
   * 좌석을 잡고, 결제 직전에서 멈춘 채 남은 시간을 세다가, 놓아준다.
   *
   * 이 함수가 끝났다는 건 좌석이 더 이상 우리 것이 아니라는 뜻이다.
   * 사람이 그 사이에 결제했다면 서버가 알아서 확정한다.
   */
  async run(req: HoldRequest): Promise<ReleaseReason | 'held'> {
    if (this.active) throw new HoldBusyError();

    const k = key(req.showtime);
    const tried = this.attempts.get(k) ?? 0;
    if (tried >= this.maxAttempts) return 'failed';
    this.attempts.set(k, tried + 1);

    let session: HeldSession;
    try {
      session = await this.deps.holder.hold(req);
    } catch (err) {
      this.deps.onError?.(req, err);
      await this.deps.onReleased?.(req, 'failed');
      return 'failed';
    }

    if (!session.atPayment) {
      // 좌석을 못 잡았다. 잡다 만 상태로 두지 않는다.
      await this.safeRelease(session, req, 'failed');
      return 'failed';
    }

    this.active = { req, session };
    this.cancelled = false;

    try {
      const reason = await this.countdown(req, session);
      await this.safeRelease(session, req, reason);
      return reason;
    } finally {
      this.active = null;
    }
  }

  private async countdown(req: HoldRequest, session: HeldSession): Promise<ReleaseReason> {
    const start = this.deps.now();
    const total = session.deadline
      ? Math.max(0, Math.round((session.deadline - start) / 1000))
      : this.holdSeconds;

    await this.deps.onHeld?.(req, total);

    for (;;) {
      if (this.cancelled) return 'cancelled';

      const left = total - Math.round((this.deps.now() - start) / 1000);
      if (left <= 0) return 'expired';

      await this.deps.onCountdown(req, left);
      await this.deps.sleep(Math.min(this.tickSeconds, left) * 1000);
    }
  }

  /** 해제는 실패해도 삼킨다. 여기서 던지면 다음 감시가 막힌다. */
  private async safeRelease(
    session: HeldSession,
    req: HoldRequest,
    reason: ReleaseReason,
  ): Promise<void> {
    try {
      await session.release();
    } catch (err) {
      this.deps.onError?.(req, err);
    }
    await this.deps.onReleased?.(req, reason);
  }
}

function key(s: Showtime): string {
  return `${s.chain}:${s.playDate}:${s.theaterId}:${s.screenId}:${s.playSequence}`;
}
