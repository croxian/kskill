import type { BrowserContext, Page } from 'playwright';

import { findCandidates } from '../core/runs.js';
import type { Seat, Showtime } from '../types.js';
import {
  CGV_FLOW,
  cgvScreenPattern,
  cgvShowtimePattern,
  type CgvFlow,
} from './cgv-flow.js';
import { CGV_SEAT_RULES, readSeatMap, SEAT_ATTR, type CgvSeatRules } from '../adapters/cgv/seatmap.js';
import type { HeldSession, HoldRequest, SeatHolder } from './session.js';

/**
 * CGV 좌석 확보. 결제 직전에서 멈춘다.
 *
 * 롯데와 결정적으로 다른 점: **좌석을 화면에 들어가서야 알 수 있다.**
 * CGV 좌석 조회 API 는 서명이 필요하고 직접 호출이 막혀서, 폴링 단계에서는
 * 잔여수만 안다. 그래서 이 홀더가 2단(좌석 판정)과 점유를 한 세션에서 한다.
 *
 *   회차 진입 → 좌석맵을 DOM 에서 읽기 → 조건에 맞는 좌석 고르기 → 클릭
 *
 * 로그인은 자동화하지 않는다 — CGV 는 로그인에 캡차가 있다.
 * 캡차가 나타나면 뚫지 않고 중단한다.
 */

export class CgvCaptchaError extends Error {
  constructor() {
    super(
      'CGV 로그인이 풀렸습니다. 캡차 때문에 자동 로그인이 불가능합니다. ' +
        'npm run login:cgv 로 직접 로그인해 주세요.',
    );
    this.name = 'CgvCaptchaError';
  }
}

export class CgvNoSeatError extends Error {
  constructor(reason: string) {
    super(`조건에 맞는 좌석이 없습니다: ${reason}`);
    this.name = 'CgvNoSeatError';
  }
}

export class CgvNavigationError extends Error {
  constructor(step: string, cause?: unknown) {
    super(`CGV 화면 이동 실패 (${step})${cause instanceof Error ? `: ${cause.message}` : ''}`);
    this.name = 'CgvNavigationError';
  }
}

export interface CgvHolderOpts {
  profileDir?: string;
  flow?: CgvFlow;
  seatRules?: CgvSeatRules;
  stepTimeoutMs?: number;
  /** 고른 좌석을 알린다. 로그에 남겨두면 나중에 왜 그 자리였는지 알 수 있다. */
  onPick?(seats: Seat[]): void;
  launch?(profileDir: string): Promise<BrowserContext>;
}

export class CgvSeatHolder implements SeatHolder {
  private readonly profileDir: string;
  private readonly flow: CgvFlow;
  private readonly rules: CgvSeatRules;
  private readonly stepTimeout: number;

  constructor(private readonly opts: CgvHolderOpts = {}) {
    this.profileDir = opts.profileDir ?? '.profile';
    this.flow = opts.flow ?? CGV_FLOW;
    this.rules = opts.seatRules ?? CGV_SEAT_RULES;
    this.stepTimeout = opts.stepTimeoutMs ?? 15_000;
  }

  async hold(req: HoldRequest): Promise<HeldSession> {
    const ctx = await this.launch();
    let released = false;

    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      // 컨텍스트를 닫는 게 가장 확실한 해제다. 세션이 끊기면 서버가 좌석을 놓는다.
      await ctx.close().catch(() => {});
    };

    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      page.setDefaultTimeout(this.stepTimeout);

      await page.goto(this.flow.baseUrl, { waitUntil: 'domcontentloaded' });
      await this.navigate(page, req.showtime);
      await this.assertNoCaptcha(page);

      // 인원을 먼저 정해야 좌석이 눌린다.
      const size = req.seats.length || req.pick?.party.size || 1;
      await this.step('인원 선택', () =>
        page.getByRole('button', { name: this.flow.audience }).first().click(),
      );

      const seats = await this.chooseSeats(page, req, size);
      this.opts.onPick?.(seats);

      for (const seat of seats) {
        await this.step(`좌석 ${seat.row}${seat.col}`, () =>
          page.locator(`[${SEAT_ATTR}="${seat.id}"]`).first().click(),
        );
      }

      await this.step('선택완료', () =>
        page.getByRole('button', { name: this.flow.seatsDone }).click(),
      );
      // 좌석 화면의 "원  결제하기" — 다음 단계로 넘어가는 버튼이다.
      await this.step('결제 화면 이동', () =>
        page.getByRole('button', { name: this.flow.toPayment }).click(),
      );

      // ── 종점 ──────────────────────────────────────────────
      // 결제 화면에 닿았는지 확인만 한다. flow.payNever 는 실제로 돈이
      // 나가는 버튼이라 여기서도 클릭하지 않는다. 표식으로만 쓴다.
      await page
        .getByRole('button', { name: this.flow.payNever, exact: true })
        .waitFor({ state: 'visible' });

      return { atPayment: true, release };
    } catch (err) {
      await release();
      throw err;
    }
  }

  /**
   * 좌석맵을 DOM 에서 읽고 조건에 맞는 좌석을 고른다.
   *
   * 미리 정해진 좌석이 있으면 그걸 쓰고, 없으면 여기서 판정한다.
   * 판정 로직은 롯데와 완전히 같은 것을 쓴다 — 어댑터가 좌표와 상태만
   * 채워주면 core/runs 가 체인을 모른 채 동작한다.
   */
  private async chooseSeats(page: Page, req: HoldRequest, size: number): Promise<Seat[]> {
    if (req.seats.length > 0) return req.seats;

    const map = await readSeatMap(
      page,
      {
        theaterId: req.showtime.theaterId,
        screenId: req.showtime.screenId,
        playDate: req.showtime.playDate,
        playSequence: req.showtime.playSequence,
      },
      this.rules,
    );

    const free = map.seats.filter((s) => s.state === 'free').length;
    if (free === 0) throw new CgvNoSeatError('빈자리가 없습니다');

    const party = req.pick?.party ?? { mode: 'single' as const, size };
    const best = findCandidates(map, req.pick?.block ?? null, party)[0];
    if (!best) {
      throw new CgvNoSeatError(
        `빈자리 ${free}석은 있지만 블록·${party.mode === 'single' ? '단석' : `${party.size}연석`} 조건에 안 맞습니다`,
      );
    }
    return best.seats;
  }

  /** 예매·예약 → 영화 → 극장 → 극장선택 → 날짜 → 회차 → 확인 */
  private async navigate(page: Page, s: Showtime): Promise<void> {
    const f = this.flow;
    await this.step('예매 진입', () =>
      page.getByRole('button', { name: f.ticketing }).click(),
    );
    // CGV 는 롯데와 달리 영화를 먼저 고른다.
    await this.step('영화 선택', () =>
      page.getByRole('button', { name: s.movieName }).first().click(),
    );
    await this.step('극장 선택', () =>
      page.getByRole('button', { name: s.theaterName }).first().click(),
    );
    await this.step('극장 확정', () =>
      page.getByRole('button', { name: f.confirmTheater }).click(),
    );
    await this.step('날짜 선택', () => page.getByRole('button', { name: dayName(s) }).click());

    // 회차 버튼 이름에는 잔여석이 들어 있고 그 사이에도 변한다.
    // 시작 시각으로 좁히고, 같은 시각에 여러 관이 있으면 상영관으로 가른다.
    await this.step('회차 선택', async () => {
      const byTime = page.getByRole('button', { name: cgvShowtimePattern(s.startTime) });
      const withScreen = byTime.filter({ hasText: cgvScreenPattern(s.screenName) });
      const target = (await withScreen.count()) > 0 ? withScreen : byTime;
      await target.first().click();
    });
    await this.step('회차 확정', () =>
      page.getByRole('button', { name: f.confirmShowtime }).click(),
    );
  }

  /** 캡차는 뚫지 않는다. 세션이 살아 있어야만 진행할 수 있다. */
  private async assertNoCaptcha(page: Page): Promise<void> {
    const blocked = await page
      .locator(this.flow.captcha)
      .first()
      .isVisible()
      .catch(() => false);
    if (blocked) throw new CgvCaptchaError();
  }

  private async step(name: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      throw new CgvNavigationError(name, err);
    }
  }

  private async launch(): Promise<BrowserContext> {
    if (this.opts.launch) return this.opts.launch(this.profileDir);
    const { chromium } = await import('playwright');
    return chromium.launchPersistentContext(this.profileDir, {
      // 사람이 넘겨받아 결제해야 하므로 반드시 보이는 창이어야 한다.
      headless: false,
      viewport: null,
    });
  }
}

/** 날짜 버튼 이름. 오늘·내일은 이름이 따로 붙는다. */
export function dayName(s: Showtime): string | RegExp {
  const day = String(Number(s.playDate.slice(6, 8)));
  return new RegExp(`(^|\\D)${day}(\\D|$)`);
}
