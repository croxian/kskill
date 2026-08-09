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
  candidate: Candidate;
  seatMap: SeatMap;
}

export interface WatchDeps {
  /** 1단: 한 지점·한 날짜의 전 회차. 구역별로 쪼개져 와도 된다. */
  listShowtimes(theaterIdx: number, playDate: string): Promise<Showtime[]>;
  /** 2단: 한 회차의 좌석맵. */
  fetchSeatMap(showtime: Showtime): Promise<SeatMap>;
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
  /** 다음 폴링까지 밀리초. STOP 이면 감시 종료. */
  nextWakeMs: number;
}

export class Watcher {
  private readonly spec: WatchSpec;
  private snap: Snapshot = new Map();
  private readonly dedupe: Dedupe;
  private cold = true;

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
    for (let i = 0; i < spec.theaters.length; i++) {
      for (const date of spec.dates) {
        try {
          all.push(...(await this.deps.listShowtimes(i, date)));
        } catch (err) {
          this.deps.onError?.('1단', err, `theater[${i}] ${date}`);
        }
      }
    }

    const live = collapseDivisions(all)
      .filter((s) => matchesSpec(s, spec))
      .filter((s) => intervalMs(showtimeAt(s.playDate, s.startTime), now, {
        floorSec: spec.pollFloorSec,
        stopBeforeMin: spec.stopBeforeMin,
      }) !== STOP);

    // 첫 관측이면 현재 상태를 한 번 보여주고, 이후로는 늘어난 것만 본다.
    const changed = this.cold ? live : risen(this.snap, live);
    this.snap = snapshot(live);
    this.cold = false;

    // 잔여석 0 인 회차에 좌석맵을 조회할 이유가 없다.
    const targets = changed.filter((s) => s.remainingSeats > 0);

    // ── 2단: 좌석맵을 뜯어 실제로 판정한다 ──────────────────
    const alerts: Alert[] = [];
    for (const showtime of targets) {
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
      nextWakeMs: this.expired
        ? STOP
        : nextWakeMs(
            live.map((s) => showtimeAt(s.playDate, s.startTime)),
            now,
            { floorSec: spec.pollFloorSec, stopBeforeMin: spec.stopBeforeMin },
          ),
    };
  }
}
