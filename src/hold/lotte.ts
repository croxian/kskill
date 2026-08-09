import type { BrowserContext, Page } from 'playwright';

import type { Showtime } from '../types.js';
import {
  dayNamePattern,
  LOTTE_FLOW,
  movieNamePattern,
  seatSelector,
  showtimeNamePattern,
  type LotteFlow,
} from './selectors.js';
import type { HeldSession, HoldRequest, SeatHolder } from './session.js';

/**
 * 내 로그인 브라우저를 몰아 좌석을 잡는다. 결제 직전에서 멈춘다.
 *
 * 롯데 예매에는 회차로 바로 가는 주소가 없다 — codegen 으로 확인했다.
 * 전부 한 페이지 안의 클릭이라 예매 → 지점 → 영화 → 날짜 → 회차 →
 * 인원 → 좌석 순서를 그대로 밟아야 한다.
 *
 * 로그인 자동화는 하지 않는다. 사람이 한 번 로그인해 둔 프로필을 쓴다.
 *
 *   npm run login   ← 한 번만
 *
 * 이 클래스에는 **결제 버튼을 누르는 경로가 없다.** 결제수단 화면에
 * 도달하면 거기서 멈추고 사람에게 넘긴다.
 */

export class LoginRequiredError extends Error {
  constructor() {
    super('브라우저에 로그인되어 있지 않습니다. npm run login 을 먼저 실행하세요.');
    this.name = 'LoginRequiredError';
  }
}

export class InterstitialError extends Error {
  constructor() {
    super('캡차 또는 대기열이 나타났습니다. 자동 진행을 중단합니다.');
    this.name = 'InterstitialError';
  }
}

export class SeatTakenError extends Error {
  constructor(seat: string) {
    super(`좌석 ${seat} 을(를) 그 사이 다른 사람이 가져갔습니다.`);
    this.name = 'SeatTakenError';
  }
}

export class NavigationError extends Error {
  constructor(step: string, cause?: unknown) {
    super(`예매 화면 이동 실패 (${step})${cause instanceof Error ? `: ${cause.message}` : ''}`);
    this.name = 'NavigationError';
  }
}

export interface LotteHolderOpts {
  profileDir?: string;
  flow?: LotteFlow;
  /** 단계별 대기 상한(ms). */
  stepTimeoutMs?: number;
  /** 테스트에서 브라우저를 갈아끼우기 위한 구멍. */
  launch?(profileDir: string): Promise<BrowserContext>;
}

export class LotteSeatHolder implements SeatHolder {
  private readonly profileDir: string;
  private readonly flow: LotteFlow;
  private readonly stepTimeout: number;

  constructor(private readonly opts: LotteHolderOpts = {}) {
    this.profileDir = opts.profileDir ?? '.profile';
    this.flow = opts.flow ?? LOTTE_FLOW;
    this.stepTimeout = opts.stepTimeoutMs ?? 15_000;
  }

  async hold(req: HoldRequest): Promise<HeldSession> {
    const ctx = await this.launch();
    let released = false;

    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      // 컨텍스트를 닫는 것이 가장 확실한 해제다. 세션이 끊기면
      // 서버가 붙잡고 있던 좌석을 놓는다.
      await ctx.close().catch(() => {});
    };

    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      page.setDefaultTimeout(this.stepTimeout);

      await page.goto(this.flow.baseUrl, { waitUntil: 'domcontentloaded' });
      await this.assertUsable(page);

      await this.navigateToSeats(page, req.showtime);
      await this.setAudience(page, req.seats.length);
      await this.pickSeats(page, req.seats);

      await page.getByRole('link', { name: this.flow.toPayment }).click();

      // ── 종점. 결제수단 화면에 닿았는지만 확인하고 멈춘다. ──
      await page.locator(this.flow.paymentMarker).waitFor({ state: 'visible' });
      await this.assertUsable(page);

      return { atPayment: true, deadline: await this.readDeadline(page), release };
    } catch (err) {
      await release();
      throw err;
    }
  }

  /** 예매 → 지점 → 영화 → 날짜 → 회차 → 인원/좌석. codegen 이 잡은 순서 그대로. */
  private async navigateToSeats(page: Page, s: Showtime): Promise<void> {
    const f = this.flow;
    await this.step('예매 진입', () =>
      page.getByRole('link', { name: f.ticketingLink, exact: true }).click(),
    );
    await this.step('지점 선택', () =>
      page.locator(f.theaterScope).getByRole('link', { name: s.theaterName }).click(),
    );
    await this.step('영화 선택', () =>
      page.getByRole('link', { name: movieNamePattern(s.movieName) }).click(),
    );
    await this.step('날짜 선택', () =>
      page.getByRole('link', { name: dayNamePattern(s.playDate) }).click(),
    );
    // 회차 버튼 이름에는 잔여석 수가 들어가는데 그 사이에도 변한다.
    // 시작 시각으로만 맞춘다.
    await this.step('회차 선택', () =>
      page.getByRole('button', { name: showtimeNamePattern(s.startTime) }).click(),
    );
    await this.step('좌석 단계 이동', () =>
      page.getByRole('link', { name: f.toSeatStep }).click(),
    );
  }

  /** 인원을 먼저 정해야 좌석이 눌린다. 실측으로 확인한 순서다. */
  private async setAudience(page: Page, count: number): Promise<void> {
    const plus = page.locator(this.flow.adultStepper).getByRole('button', {
      name: this.flow.stepperPlus,
    });
    await this.step('인원 설정', async () => {
      for (let i = 0; i < count; i++) await plus.click();
    });
  }

  private async pickSeats(page: Page, seats: HoldRequest['seats']): Promise<void> {
    for (const seat of seats) {
      const label = `${seat.row}${seat.col}`;
      const target = page.locator(seatSelector(this.flow, seat));
      if (!(await target.isEnabled().catch(() => false))) throw new SeatTakenError(label);
      await this.step(`좌석 ${label}`, () => target.click());
    }
  }

  private async step(name: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      throw new NavigationError(name, err);
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

  /** 로그인이 풀렸거나 캡차가 뜨면 즉시 중단한다. 어느 쪽도 우회하지 않는다. */
  private async assertUsable(page: Page): Promise<void> {
    if (this.flow.interstitial) {
      const blocked = await page
        .locator(this.flow.interstitial)
        .isVisible()
        .catch(() => false);
      if (blocked) throw new InterstitialError();
    }
    const loggedOut = await page
      .locator(this.flow.loggedOut)
      .isVisible()
      .catch(() => false);
    if (loggedOut) throw new LoginRequiredError();
  }

  /**
   * 화면의 카운트다운에서 만료 시각을 읽는다.
   *
   * 롯데 결제 화면에는 카운트다운이 없다는 걸 실측으로 확인했다.
   * 그래서 대개 undefined 를 돌려주고, HoldManager 가 스스로 정한
   * 상한(기본 5분)을 쓴다. 숫자를 여기 박지 않는 이유다 —
   * 다른 체인이나 특별관에는 있을 수 있다.
   */
  private async readDeadline(page: Page): Promise<number | undefined> {
    if (!this.flow.countdown) return undefined;
    const raw = await page
      .locator(this.flow.countdown)
      .first()
      .textContent({ timeout: 3000 })
      .catch(() => null);
    const m = raw?.match(/(\d{1,2}):(\d{2})/);
    return m ? Date.now() + (Number(m[1]) * 60 + Number(m[2])) * 1000 : undefined;
  }
}
