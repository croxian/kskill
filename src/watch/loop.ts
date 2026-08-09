import type { SeatMap, Showtime } from '../types.js';
import type { Candidate } from '../core/runs.js';
import { findCandidates } from '../core/runs.js';
import {
  collapseDivisions,
  Dedupe,
  fingerprint,
  risen,
  snapshot,
  seatMapKey,
  type Snapshot,
} from '../core/diff.js';
import { intervalMs, nextWakeMs, STOP } from '../core/poll.js';
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
}

export interface RunResult {
  polled: number;
  /** 잔여석이 늘어 2단으로 넘어간 회차 수 */
  targets: number;
  alerts: Alert[];
  /** 상한에 걸려 이번에 보내지 않은 후보 수. 다음 폴링에서 다시 후보가 된다. */
  suppressed: number;
  /** 다음 폴링까지 밀리초. STOP 이면 감시 종료. */
  nextWakeMs: number;
  /** 1단 조회가 전부 실패했다. 회차가 없는 것과 구분해야 한다. */
  offline: boolean;
}

export class Watcher {
  private readonly spec: WatchSpec;
  private snap: Snapshot = new Map();
  private readonly dedupe: Dedupe;
  private cold = true;
  /**
   * 상한에 잘려 이번에 보지 못한 회차.
   *
   * 이걸 들고 있지 않으면 잔여석이 다시 변할 때까지 영원히 묻힌다.
   * 다음 폴링에서 잔여석 변화와 무관하게 다시 확인한다.
   */
  private pending = new Set<string>();

  constructor(
    spec: WatchSpec,
    private readonly deps: WatchDeps,
    opts: { cooldownMs?: number; coldStart?: 'check' | 'baseline' } = {},
  ) {
    this.spec = normalizeSpec(spec);
    this.dedupe = new Dedupe(opts.cooldownMs);
    if (opts.coldStart === 'baseline') this.cold = false;
  }

  get expired(): boolean {
    return this.deps.now() >= Date.parse(this.spec.expiresAt);
  }

  async runOnce(): Promise<RunResult> {
    const now = this.deps.now();
    const spec = this.spec;

    // ── 1단: 카운트만 훑는다 ────────────────────────────────
    const all: Showtime[] = [];
    let attempts = 0;
    let failures = 0;
    for (let i = 0; i < spec.theaters.length; i++) {
      for (const date of spec.dates) {
        attempts++;
        try {
          all.push(...(await this.deps.listShowtimes(i, date)));
        } catch (err) {
          failures++;
          this.deps.onError?.('1단', err, `theater[${i}] ${date}`);
        }
      }
    }
    const offline = attempts > 0 && failures === attempts;

    const live = collapseDivisions(all)
      .filter((s) => matchesSpec(s, spec))
      .filter((s) => intervalMs(showtimeAt(s.playDate, s.startTime), now, {
        floorSec: spec.pollFloorSec,
        stopBeforeMin: spec.stopBeforeMin,
      }) !== STOP);

    // 첫 관측이면 현재 상태를 한 번 보여주고, 이후로는 늘어난 것만 본다.
    // 지난 폴링에서 상한에 잘린 회차는 변화와 무관하게 다시 끼워 넣는다.
    const wasCold = this.cold;
    const fresh = wasCold ? live : risen(this.snap, live);
    const carried = live.filter(
      (s) => this.pending.has(seatMapKey(s)) && !fresh.includes(s),
    );
    const changed = [...fresh, ...carried];

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

        const alert: Alert = { spec, showtime, candidate: null, seatMap: null };
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

      const alert: Alert = { spec, showtime, candidate: best, seatMap: map };
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
      nextWakeMs: this.nextWake(live, now, offline),
    };
  }

  /**
   * 조회가 전부 실패한 것과 감시할 회차가 없는 것은 다르다.
   *
   * 둘 다 회차 목록이 비어 있지만, 전자에서 STOP 을 돌려주면
   * 잠깐의 네트워크 장애로 감시가 조용히 끝나버린다.
   */
  private nextWake(live: Showtime[], now: number, offline: boolean): number {
    if (this.expired) return STOP;
    if (offline) return Math.max(this.spec.pollFloorSec, 60) * 1000;
    return nextWakeMs(
      live.map((s) => showtimeAt(s.playDate, s.startTime)),
      now,
      { floorSec: this.spec.pollFloorSec, stopBeforeMin: this.spec.stopBeforeMin },
    );
  }
}
