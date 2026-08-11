import type { SeatMap, Showtime } from '../types.js';
import type { Candidate } from '../core/runs.js';
import { findCandidates } from '../core/runs.js';
import {
  collapseDivisions,
  Dedupe,
  fell,
  fingerprint,
  risen,
  snapshot,
  seatMapKey,
  type Snapshot,
} from '../core/diff.js';
import { intervalMs, nextWakeMs, STOP } from '../core/poll.js';
import { Backoff, isThrottled } from '../core/throttle.js';
import { matchesSpec, normalizeSpec, showtimeAt, type WatchSpec } from '../core/spec.js';

/**
 * 감시 루프.
 *
 * 네트워크와 시계를 전부 주입받는다. 그래야 실제 폴링 없이 루프 자체를
 * 테스트할 수 있고, 체인이 늘어나도 이 파일은 손대지 않는다.
 */

export interface Alert {
  spec: WatchSpec;
  showtime: Showtime;
  /**
   * 좌석 단위 후보. 좌석맵을 못 구하는 체인에서는 null 이다.
   * 그때는 "이 회차에 자리가 났다" 까지만 알리고 좌석은 사람이 고른다.
   */
  candidate: Candidate | null;
  seatMap: SeatMap | null;
  /** 직전 관측 대비 몇 석이 늘었는가. 첫 관측에서는 undefined. */
  increase?: number;
}

export interface WatchDeps {
  /** 1단: 한 지점·한 날짜의 전 회차. 구역별로 쪼개져 와도 된다. */
  listShowtimes(theaterIdx: number, playDate: string): Promise<Showtime[]>;
  /**
   * 2단: 한 회차의 좌석맵.
   *
   * 없어도 된다. 좌석맵을 구할 수 없는 체인에서는 1단 카운트만으로 알린다 —
   * 좌석 블록·연석 판정은 못 하지만, 자리가 났다는 사실은 알려줄 수 있다.
   */
  fetchSeatMap?(showtime: Showtime): Promise<SeatMap>;
  notify(alert: Alert): Promise<void>;
  now(): number;
  /** 조회 실패를 삼키지 않고 밖으로 알린다. */
  onError?(stage: '1단' | '2단', err: unknown, ctx: string): void;
  /** 물러서거나 돌아왔다. 조용히 느려지면 사람이 고장으로 오해한다. */
  onBackoff?(steps: number, everySec: number): void;
}

export interface RunResult {
  polled: number;
  /** 이번에 실제로 나간 요청 수. 얼마나 부담을 주고 있는지 볼 수 있어야 한다. */
  requests: number;
  /** 잔여석이 늘어 2단으로 넘어간 회차 수 */
  targets: number;
  alerts: Alert[];
  /** 상한에 걸려 이번에 보내지 않은 후보 수. 다음 폴링에서 다시 후보가 된다. */
  suppressed: number;
  /** 다음 폴링까지 밀리초. STOP 이면 감시 종료. */
  nextWakeMs: number;
  /** 1단 조회가 전부 실패했다. 회차가 없는 것과 구분해야 한다. */
  offline: boolean;
  /** 밀려서 물러선 단계. 0 이면 설정한 속도 그대로. */
  backoffSteps: number;
  /**
   * 감시를 시작한 뒤 지금까지 보낸 요청 수.
   *
   * 시간당 수치만 보면 하루치 총량이 안 보인다. 10초 감시를 20시간 돌리면
   * 7천 회인데, 화면에는 "360회/시" 하나만 떠 있으면 그 크기를 못 느낀다.
   */
  totalRequests: number;
}

export class Watcher {
  private readonly spec: WatchSpec;
  private snap: Snapshot = new Map();
  /** 직전 관측. 증가분을 알림에 실으려면 갱신 전 값이 필요하다. */
  private prevSnap: Snapshot = new Map();
  private readonly dedupe: Dedupe;
  private cold = true;
  /**
   * 상한에 잘려 이번에 보지 못한 회차.
   *
   * 이걸 들고 있지 않으면 잔여석이 다시 변할 때까지 영원히 묻힌다.
   * 다음 폴링에서 잔여석 변화와 무관하게 다시 확인한다.
   */
  private pending = new Set<string>();

  /**
   * 지점·날짜 짝마다 따로 잡는 다음 조회 시각.
   *
   * 처음에는 매 주기에 모든 짝을 한꺼번에 조회했다. 그런데 깨어나는 간격은
   * **전체에서 가장 급한 회차**가 정한다. 오늘 저녁 회차 하나 때문에 닷새 뒤
   * 날짜까지 45초마다 조회했다 — 지점 2 × 날짜 5 면 시간당 800회다.
   *
   * 짝마다 제 사정에 맞춰 재운다. 닷새 뒤는 30분에 한 번이면 충분하고,
   * 오늘 저녁은 45초마다 본다. 놓치는 것 없이 요청만 줄어든다.
   */
  private nextPollAt = new Map<string, number>();
  /** 이번에 조회하지 않은 짝의 직전 결과. 변화 판정에는 전체 그림이 필요하다. */
  private seen = new Map<string, Showtime[]>();
  /** 남은 회차가 없어 더 볼 이유가 없는 짝. */
  private done = new Set<string>();
  /**
   * 서버가 밀어내면 물러선다.
   *
   * 예산은 우리가 정한 천장일 뿐 서버가 동의한 값이 아니다. 429·403 이
   * 돌아오면 그건 "지금 그 속도는 안 된다" 는 뜻이고, 같은 속도로 계속
   * 두드리면 단단한 차단이 된다.
   */
  private readonly backoff = new Backoff();
  private total = 0;

  constructor(
    spec: WatchSpec,
    private readonly deps: WatchDeps,
    opts: { cooldownMs?: number; coldStart?: 'check' | 'baseline' } = {},
  ) {
    this.spec = normalizeSpec(spec);
    this.dedupe = new Dedupe(opts.cooldownMs);
    // 회차를 집어서 고른 감시는 방금 그 목록을 눈으로 보고 고른 것이다.
    // 첫 관측을 사건으로 알리면 시작하자마자 아는 사실을 되풀이할 뿐이다.
    if (opts.coldStart === 'baseline' || this.spec.showtimes?.length) this.cold = false;
  }

  get expired(): boolean {
    return this.deps.now() >= Date.parse(this.spec.expiresAt);
  }

  async runOnce(): Promise<RunResult> {
    const now = this.deps.now();
    const spec = this.spec;

    // ── 1단: 이번에 볼 짝만 훑는다 ──────────────────────────
    const due = this.duePairs(now);
    let failures = 0;
    for (const p of due) {
      try {
        const got = await this.deps.listShowtimes(p.idx, p.date);
        this.seen.set(p.key, got);

        const wait = this.pairInterval(got, now);
        if (wait === STOP) {
          // 이 날짜에 남은 회차가 없다. 다시 볼 이유가 없다.
          this.done.add(p.key);
          this.seen.delete(p.key);
        } else {
          this.nextPollAt.set(p.key, now + wait);
        }
      } catch (err) {
        failures++;
        this.deps.onError?.('1단', err, `theater[${p.idx}] ${p.date}`);
        // 밀린 것이면 전체 속도를 늦춘다. 이 짝만 늦춰봐야 소용없다 —
        // 서버가 보는 것은 우리 IP 의 총량이다.
        if (isThrottled(err) && this.backoff.trip()) {
          this.deps.onBackoff?.(this.backoff.steps, this.floorSec());
        }
        this.nextPollAt.set(p.key, now + Math.max(this.floorSec(), 60) * 1000);
      }
    }
    const offline = due.length > 0 && failures === due.length;
    // 한 바퀴를 무사히 돌면 천천히 돌아온다. 한 번 성공했다고 바로 뛰면
    // 밀리고 돌아오기를 반복하면서 평균적으로는 계속 두드리는 꼴이 된다.
    if (due.length > 0 && failures === 0 && this.backoff.ease()) {
      this.deps.onBackoff?.(this.backoff.steps, this.floorSec());
    }

    // 이번에 안 본 짝은 직전 결과를 그대로 쓴다. 변하지 않았으니 알림도 없다.
    const all = [...this.seen.values()].flat();

    const live = collapseDivisions(all)
      .filter((s) => matchesSpec(s, spec))
      .filter((s) => intervalMs(showtimeAt(s.playDate, s.startTime), now, this.timing(s)) !== STOP);

    // 첫 관측이면 현재 상태를 한 번 보여주고, 이후로는 늘어난 것만 본다.
    // 지난 폴링에서 상한에 잘린 회차는 변화와 무관하게 다시 끼워 넣는다.
    // 다시 팔린 회차는 기억을 지운다. 그래야 또 났을 때 새 사건으로 알린다.
    // 이게 없으면 0→1 로 알린 뒤 1→0→1 이 쿨다운에 묻힌다.
    for (const s of fell(this.snap, live)) this.dedupe.forget(seatMapKey(s));

    const wasCold = this.cold;
    const fresh = wasCold ? live : risen(this.snap, live, this.spec.minIncrease);
    const carried = live.filter(
      (s) => this.pending.has(seatMapKey(s)) && !fresh.includes(s),
    );
    const changed = [...fresh, ...carried];

    this.prevSnap = this.snap;
    this.snap = snapshot(live);
    this.cold = false;
    this.pending.clear();

    // 잔여석 0 인 회차에 좌석맵을 조회할 이유가 없다.
    const targets = changed.filter((s) => s.remainingSeats > 0);

    // ── 2단: 좌석맵을 뜯어 실제로 판정한다 ──────────────────
    const cap = spec.maxAlertsPerRun ?? 5;
    const alerts: Alert[] = [];
    let suppressed = 0;

    for (const [i, showtime] of targets.entries()) {
      // 상한에 닿으면 좌석맵 조회조차 하지 않고 멈춘다. 남은 회차는
      // 지문을 남기지 않았으므로 다음 폴링에서 그대로 다시 후보가 된다.
      if (alerts.length >= cap) {
        const rest = targets.slice(i);
        // 첫 폴링은 "지금 뭐가 있나" 를 한 번 보여주는 목록이지 사건이 아니다.
        // 여기서 잘린 걸 다음으로 넘기면, 조건이 넓을 때 시작 시점의 재고
        // 수백 건이 몇십 분에 걸쳐 찔끔찔끔 알림으로 나온다.
        // 취소표는 사건이므로 그때부터 넘긴다.
        if (!wasCold) for (const t of rest) this.pending.add(seatMapKey(t));
        suppressed = rest.length;
        break;
      }

      // 좌석맵을 구할 수 없는 체인이면 카운트만으로 알린다.
      // 잔여수가 또 늘면 다시 알리도록 지문에 수를 넣는다.
      if (!this.deps.fetchSeatMap) {
        const fp = `${seatMapKey(showtime)}|n=${showtime.remainingSeats}`;
        if (!this.dedupe.shouldSend(fp, now)) continue;

        const rise = this.riseOf(showtime);
        const alert: Alert = {
          spec,
          showtime,
          candidate: null,
          seatMap: null,
          ...(rise !== undefined ? { increase: rise } : {}),
        };
        alerts.push(alert);
        await this.deps.notify(alert);
        if (spec.action === 'hold') break;
        continue;
      }

      let map: SeatMap;
      try {
        map = await this.deps.fetchSeatMap(showtime);
      } catch (err) {
        this.deps.onError?.('2단', err, seatMapKey(showtime));
        continue;
      }

      const found = findCandidates(map, spec.block, spec.party);
      const best = found[0];
      if (!best) continue;

      if (!this.dedupe.shouldSend(fingerprint(best.seats, showtime), now)) continue;

      const rose = this.riseOf(showtime);
      const alert: Alert = {
        spec,
        showtime,
        candidate: best,
        seatMap: map,
        ...(rose !== undefined ? { increase: rose } : {}),
      };
      alerts.push(alert);
      await this.deps.notify(alert);

      // 좌석 확보는 동시에 1건만. 하나 잡으면 이번 회차 순회를 멈춘다.
      if (spec.action === 'hold') break;
    }

    this.dedupe.prune(now);

    return {
      polled: live.length,
      targets: targets.length,
      alerts,
      suppressed,
      offline,
      requests: due.length,
      totalRequests: (this.total += due.length),
      backoffSteps: this.backoff.steps,
      nextWakeMs: this.nextWake(now, offline),
    };
  }

  /** 직전 관측 대비 증가분. 몇 석이 한꺼번에 풀렸는지 알림에 싣는다. */
  private riseOf(s: Showtime): number | undefined {
    const before = this.prevSnap.get(seatMapKey(s));
    return before === undefined ? undefined : s.remainingSeats - before;
  }

  /** 지금 봐야 할 지점·날짜 짝. */
  private duePairs(now: number): { idx: number; date: string; key: string }[] {
    const out: { idx: number; date: string; key: string }[] = [];
    for (let idx = 0; idx < this.spec.theaters.length; idx++) {
      for (const date of this.spec.dates) {
        const key = `${idx}:${date}`;
        if (this.done.has(key)) continue;
        if ((this.nextPollAt.get(key) ?? 0) <= now) out.push({ idx, date, key });
      }
    }
    return out;
  }

  /**
   * 이 짝을 다음에 언제 볼 것인가.
   *
   * 예산을 정했으면 **그게 간격이다.** 예전에는 예산을 하한으로만 걸었는데,
   * 그러면 실제 간격은 상영까지 남은 시간이 정한다 — 20시간 전이면 180초다.
   * 360회/시를 걸어놓고 3분 20초마다 도는 일이 실제로 있었다.
   *
   * 남은 시간에 따라 느긋해지는 표는 "난 자리가 한동안 남아 있다" 는 가정
   * 위에 서 있다. 매진된 특별관에서는 그 가정이 틀리다. 사람이 예산을
   * 정했다는 것은 그 판단을 이미 내렸다는 뜻이라 표를 덮어쓴다.
   *
   * 언제 **그만둘지**는 그대로 회차가 정한다. 판매가 끝난 회차를 예산이
   * 남았다고 계속 두드릴 이유는 없다.
   */
  private pairInterval(showtimes: Showtime[], now: number): number {
    const mine = collapseDivisions(showtimes).filter((s) => matchesSpec(s, this.spec));
    const tiered = nextWakeMs(
      mine.map((s) => ({
        showAt: showtimeAt(s.playDate, s.startTime),
        ...(s.salesEndAt ? { stopAt: showtimeAt(s.playDate, s.salesEndAt) } : {}),
      })),
      now,
      {
        floorSec: this.floorSec(),
        stopBeforeMin: this.spec.stopBeforeMin,
        ...(this.spec.maxIntervalSec ? { maxSec: this.spec.maxIntervalSec } : {}),
      },
    );
    if (tiered === STOP || !this.spec.maxRequestsPerHour) return tiered;

    // 정각에 몰리지 않게 흔든다. 표와 달리 여기서는 예산이 천장이므로
    // 아래로만 흔든다 — 위로 흔들면 정한 예산을 넘는다.
    const sec = this.floorSec();
    return Math.round(sec * (1 - Math.random() * 0.1) * 1000);
  }

  /**
   * 실제로 지킬 간격 하한.
   *
   * 총량 예산을 짝 수로 나눈다. 짝이 하나면 촘촘하게, 열이면 성기게 —
   * 어느 쪽이든 서버가 시간당 받는 요청 수는 같다. 감시 대상을 늘릴지
   * 촘촘하게 볼지는 사람이 정하고, 총량은 여기서 지킨다.
   */
  floorSec(): number {
    const budget = this.spec.maxRequestsPerHour;
    const base = budget
      ? Math.max(this.spec.pollFloorSec, Math.ceil((Math.max(1, this.livePairs()) * 3600) / budget))
      : this.spec.pollFloorSec;
    // 밀린 만큼 늘린다. 하한은 우리가 정한 값이지 서버가 동의한 값이 아니다.
    return Math.ceil(base * this.backoff.multiplier);
  }

  /** 아직 볼 것이 남은 지점·날짜 짝의 수. 끝난 날짜는 예산을 안 쓴다. */
  private livePairs(): number {
    return this.spec.theaters.length * this.spec.dates.length - this.done.size;
  }

  /**
   * 조회가 전부 실패한 것과 감시할 회차가 없는 것은 다르다.
   *
   * 둘 다 회차 목록이 비어 있지만, 전자에서 STOP 을 돌려주면
   * 잠깐의 네트워크 장애로 감시가 조용히 끝나버린다.
   */
  private nextWake(now: number, offline: boolean): number {
    if (this.expired) return STOP;
    if (offline) return Math.max(this.floorSec(), 60) * 1000;

    // 가장 먼저 깨어날 짝에 맞춘다. 아무 짝도 안 남았으면 끝난 것이다.
    const pending: number[] = [];
    for (let idx = 0; idx < this.spec.theaters.length; idx++) {
      for (const date of this.spec.dates) {
        const key = `${idx}:${date}`;
        if (this.done.has(key)) continue;
        pending.push(this.nextPollAt.get(key) ?? now);
      }
    }
    if (pending.length === 0) return STOP;
    return Math.max(1000, Math.min(...pending) - now);
  }

  /**
   * 언제까지 볼 것인가.
   *
   * 체인이 판매 종료 시각을 주면 그걸 쓴다. CGV 는 상영 시작 뒤에도
   * 15분 더 파는데, "30분 전 중단" 으로 잡으면 취소표가 가장 많이 나오는
   * 45분을 통째로 버린다.
   */
  private timing(s: Showtime) {
    return {
      floorSec: this.floorSec(),
      stopBeforeMin: this.spec.stopBeforeMin,
      ...(this.spec.maxIntervalSec ? { maxSec: this.spec.maxIntervalSec } : {}),
      ...(s.salesEndAt ? { stopAt: showtimeAt(s.playDate, s.salesEndAt) } : {}),
    };
  }
}
