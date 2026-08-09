import type { BrowserContext } from 'playwright';

/**
 * CGV 로그인 세션 지킴이.
 *
 * CGV 로그인에는 **캡차(자동입력 방지문자)** 가 있다. 그래서 롯데와 달리
 * 자동 재로그인 경로가 없다 — 캡차를 뚫는 건 이 프로젝트가 하지 않는 일이다.
 *
 * 남는 방법은 두 가지뿐이고, 둘 다 한다.
 *   1. 세션이 죽었는지 빨리 알아채서 사람에게 알린다
 *   2. 주기적으로 사이트를 방문해 세션이 덜 죽게 한다
 *
 * 2번은 부수 효과가 아니라 목적이다. 로그인된 채로 탭을 열어두는 것과
 * 같은 일이고, 캡차 때문에 한 번 풀리면 복구 비용이 크기 때문에 값을 한다.
 */

export type CgvSessionState =
  | 'ok'
  /** 로그인 링크가 보인다 = 확실히 풀렸다 */
  | 'logged-out'
  /**
   * 둘 다 못 찾았다. 페이지 구조가 바뀌었거나 로딩이 덜 됐다.
   * 이때 경고를 보내면 헛알림이 된다 — 조용히 넘긴다.
   */
  | 'unknown';

export interface CgvSessionOpts {
  profileDir?: string;
  baseUrl?: string;
  /** 로그인 상태에서만 보이는 것. 확실한 신호라 이쪽을 먼저 본다. */
  loggedInMarker?: string;
  /** 로그아웃 상태에서만 보이는 것. */
  loggedOutMarker?: string;
  timeoutMs?: number;
  launch?(profileDir: string): Promise<BrowserContext>;
}

export class CgvSessionKeeper {
  private readonly profileDir: string;
  private readonly baseUrl: string;
  private readonly inMarker: string;
  private readonly outMarker: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: CgvSessionOpts = {}) {
    this.profileDir = opts.profileDir ?? '.profile';
    this.baseUrl = opts.baseUrl ?? 'https://www.cgv.co.kr';
    this.inMarker = opts.loggedInMarker ?? 'text=로그아웃';
    this.outMarker = opts.loggedOutMarker ?? 'text=로그인';
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /**
   * 세션 확인 + 갱신.
   *
   * 방문 자체가 세션을 연장하므로, 확인이 곧 유지다.
   * 판단이 애매하면 'unknown' 을 돌려주고 아무 말도 하지 않는다.
   * 헛알림은 진짜 알림의 신뢰도를 갉아먹는다.
   */
  async check(): Promise<CgvSessionState> {
    // 브라우저 실행 자체가 실패할 수 있다 — chromium 미설치, 프로필 잠김.
    // try 밖에서 띄우면 그 실패가 감시 루프를 죽인다.
    let ctx: BrowserContext | null = null;
    try {
      ctx = await this.launch();
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      page.setDefaultTimeout(this.timeoutMs);
      await page.goto(this.baseUrl, { waitUntil: 'domcontentloaded' });

      const visible = async (sel: string): Promise<boolean> =>
        page
          .locator(sel)
          .first()
          .isVisible()
          .catch(() => false);

      if (await visible(this.inMarker)) return 'ok';
      if (await visible(this.outMarker)) return 'logged-out';
      return 'unknown';
    } catch {
      // 네트워크가 흔들린 것과 로그아웃은 다르다. 섞으면 헛알림이 된다.
      return 'unknown';
    } finally {
      await ctx?.close().catch(() => {});
    }
  }

  private async launch(): Promise<BrowserContext> {
    if (this.opts.launch) return this.opts.launch(this.profileDir);
    const { chromium } = await import('playwright');
    return chromium.launchPersistentContext(this.profileDir, { headless: true });
  }
}

export const CGV_SESSION_WARNING =
  '⚠️ <b>CGV 로그인이 풀렸습니다</b>\n\n' +
  'CGV 는 로그인에 캡차가 있어 자동 복구가 되지 않습니다.\n' +
  'PC 에서 <code>npm run login:cgv</code> 로 다시 로그인해 주세요.\n\n' +
  '<i>그때까지 좌석 확보는 할 수 없습니다. 알림은 계속 옵니다.</i>';
