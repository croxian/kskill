import type { Browser, BrowserContext, Page } from 'playwright';

import { LOTTE_TICKETING_URL } from '../notify/deeplink.js';
import { LOTTE_SELECTORS, seatSelector, type HoldSelectors } from './selectors.js';
import type { HeldSession, HoldRequest, SeatHolder } from './session.js';

/**
 * 내 로그인 브라우저를 몰아 좌석을 잡는다. 결제 직전에서 멈춘다.
 *
 * 로그인 자동화는 하지 않는다. 아이디·비밀번호를 코드에 넣는 순간
 * 캡차와 이상 로그인 탐지에 걸린다. 사람이 한 번 로그인해 둔
 * 브라우저 프로필(.profile)을 그대로 재사용한다.
 *
 *   npm run login   ← 한 번만
 *
 * 이 클래스는 **결제 버튼을 절대 누르지 않는다.** 결제수단 화면에
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

export interface LottePlaywrightOpts {
  profileDir?: string;
  selectors?: HoldSelectors;
  /** 회차 좌석선택 화면 딥링크 템플릿. 없으면 예매 첫 화면에서 시작한다. */
  deepLinkTemplate?: string;
  /** 단계별 대기 상한(ms). */
  stepTimeoutMs?: number;
  /** 테스트에서 브라우저를 갈아끼우기 위한 구멍. */
  launch?(profileDir: string): Promise<BrowserContext>;
}

export class LotteSeatHolder implements SeatHolder {
  private readonly profileDir: string;
  private readonly sel: HoldSelectors;
  private readonly stepTimeout: number;

  constructor(private readonly opts: LottePlaywrightOpts = {}) {
    this.profileDir = opts.profileDir ?? '.profile';
    this.sel = opts.selectors ?? LOTTE_SELECTORS;
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

      await page.goto(this.entryUrl(), { waitUntil: 'domcontentloaded' });
      await this.assertUsable(page);

      // 인원을 먼저 정해야 좌석이 눌린다. 실측으로 확인한 순서다.
      await this.setAudience(page, req.seats.length);

      for (const seat of req.seats) {
        const target = page.locator(seatSelector(this.sel, seat));
        if (!(await target.isEnabled().catch(() => false))) {
          throw new SeatTakenError(`${seat.row}${seat.col}`);
        }
        await target.click();
      }

      await page.locator(this.sel.toPayment).click();

      // ── 종점. 결제수단 화면에 닿았는지만 확인하고 멈춘다. ──
      await page.locator(this.sel.paymentMarker).waitFor({ state: 'visible' });
      await this.assertUsable(page);

      return {
        atPayment: true,
        deadline: await this.readDeadline(page),
        release,
      };
    } catch (err) {
      await release();
      throw err;
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

  private entryUrl(): string {
    return this.opts.deepLinkTemplate ?? LOTTE_TICKETING_URL;
  }

  /** 로그인이 풀렸거나 캡차가 뜨면 즉시 중단한다. 어느 쪽도 우회하지 않는다. */
  private async assertUsable(page: Page): Promise<void> {
    if (this.sel.interstitial) {
      const blocked = await page
        .locator(this.sel.interstitial)
        .isVisible()
        .catch(() => false);
      if (blocked) throw new InterstitialError();
    }
    const loggedOut = await page
      .locator(this.sel.loggedOut)
      .isVisible()
      .catch(() => false);
    if (loggedOut) throw new LoginRequiredError();
  }

  private async setAudience(page: Page, count: number): Promise<void> {
    const plus = page.locator(this.sel.adultPlus);
    for (let i = 0; i < count; i++) await plus.click();
  }

  /**
   * 화면의 카운트다운에서 만료 시각을 읽는다.
   *
   * 롯데 결제 화면에는 카운트다운이 없다는 걸 실측으로 확인했다.
   * 그래서 대개 undefined 를 돌려주고, 상위의 HoldManager 가
   * 스스로 정한 상한(기본 5분)을 쓴다. 숫자를 여기 박아 넣지 않는 이유다 —
   * 다른 체인이나 특별관에는 있을 수 있다.
   */
  private async readDeadline(page: Page): Promise<number | undefined> {
    if (!this.sel.countdown) return undefined;
    const raw = await page
      .locator(this.sel.countdown)
      .first()
      .textContent({ timeout: 3000 })
      .catch(() => null);
    const m = raw?.match(/(\d{1,2}):(\d{2})/);
    if (!m) return undefined;
    return Date.now() + (Number(m[1]) * 60 + Number(m[2])) * 1000;
  }
}

/** 타입만 쓰고 런타임 import 를 피하기 위한 재수출. */
export type { Browser, BrowserContext, Page };
