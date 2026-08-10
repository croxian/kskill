import type { Locator, Page } from 'playwright';

/**
 * 화면 단계를 "여러 방법으로 시도하고 되는 걸 쓴다".
 *
 * 처음에는 codegen 녹화에서 뽑은 셀렉터를 그대로 박아 넣었다. 그건 한 번의
 * 화면을 사진으로 찍어둔 것이라, 사이트가 조금만 달라도 — 날짜가 오늘이냐
 * 내일이냐, 특별관이냐 일반관이냐 — 조용히 안 눌린다. CGV 는 SPA 라
 * codegen 자체도 제대로 안 붙는다.
 *
 * 그래서 단계마다 후보를 여러 개 두고, 실제로 존재하는 것을 골라 누른다.
 * 전부 실패하면 **그때 화면에 뭐가 있었는지 같이 던진다.** 셀렉터를 고치려면
 * 결국 그 정보가 필요한데, 없으면 사람이 다시 재현해야 한다.
 */

export interface Attempt {
  /** 로그에 남을 이름. 어떤 전략이 통했는지 나중에 알아야 한다. */
  how: string;
  find(page: Page): Locator;
}

export interface ScreenItem {
  tag: string;
  role: string;
  name: string;
  /** data-* 같은 단서. 다음 셀렉터를 짤 재료다. */
  hint: string;
}

export interface ScreenDump {
  url: string;
  items: ScreenItem[];
  /** 좌석맵 화면인지. 좌석이 보이면 인원 선택은 이미 지났다는 뜻이다. */
  seats: number;
}

export class StepFailure extends Error {
  constructor(
    readonly step: string,
    readonly tried: string[],
    readonly screen: ScreenDump,
  ) {
    super(
      `'${step}' 을 찾지 못했습니다.\n` +
        `  시도: ${tried.join(', ')}\n` +
        `  화면: ${screen.url}\n` +
        formatScreen(screen),
    );
    this.name = 'StepFailure';
  }
}

export interface ClickOpts {
  /** 이 단계 전체에 쓸 시간(ms). 후보 수로 나눠 쓴다. */
  timeoutMs?: number;
  /** 못 찾아도 넘어간다. 화면에 따라 있을 수도 없을 수도 있는 단계용. */
  optional?: boolean;
  onStep?(step: string, how: string | null): void;
}

/**
 * 후보를 차례로 눌러 보고 처음 성공한 것을 쓴다.
 *
 * 후보가 많을수록 실패했을 때 오래 걸리므로 단계 전체 예산을 나눠 준다.
 * 표를 잡는 일이라 15초를 여섯 번 기다릴 여유가 없다.
 */
export async function clickFirst(
  page: Page,
  step: string,
  attempts: Attempt[],
  opts: ClickOpts = {},
): Promise<string | null> {
  const budget = opts.timeoutMs ?? 12_000;
  const each = clamp(Math.floor(budget / Math.max(1, attempts.length)), 1200, 5000);
  const tried: string[] = [];

  for (const a of attempts) {
    tried.push(a.how);
    try {
      const loc = a.find(page).first();
      await loc.waitFor({ state: 'visible', timeout: each });
      await loc.click({ timeout: each });
      opts.onStep?.(step, a.how);
      return a.how;
    } catch {
      // 이 후보는 아니었다. 다음 것을 본다.
    }
  }

  if (opts.optional) {
    opts.onStep?.(step, null);
    return null;
  }
  throw new StepFailure(step, tried, await describeScreen(page));
}

/**
 * 지금 화면에 있는 누를 수 있는 것들을 훑는다.
 *
 * 실패 메시지에 붙이고, 탐색 스크립트에서도 같은 걸 쓴다.
 * 접근성 이름을 정확히 계산하지는 않는다 — 셀렉터를 짤 단서면 충분하다.
 */
export async function describeScreen(page: Page): Promise<ScreenDump> {
  const empty: ScreenDump = { url: '', items: [], seats: 0 };
  try {
    const url = page.url();
    const items = await page.$$eval(
      'button, a, input, select, [role="button"], [role="tab"], [role="option"], [onclick]',
      (els) =>
        els
          .filter((el) => (el as HTMLElement).getClientRects().length > 0)
          .map((el) => {
            const h = el as HTMLElement;
            const attrs: string[] = [];
            for (const at of Array.from(el.attributes)) {
              // 빌드마다 바뀌는 해시 클래스는 단서가 못 된다. data-* 만 본다.
              if (at.name.startsWith('data-') && at.value) {
                attrs.push(`${at.name}=${at.value.slice(0, 24)}`);
              }
            }
            const name =
              el.getAttribute('aria-label') ??
              el.getAttribute('title') ??
              (el as HTMLInputElement).value ??
              (h.innerText || el.textContent || '');
            return {
              tag: el.tagName.toLowerCase(),
              role: el.getAttribute('role') ?? '',
              name: name.replace(/\s+/g, ' ').trim().slice(0, 60),
              hint: attrs.slice(0, 3).join(' '),
            };
          })
          .filter((x) => x.name || x.hint),
    );

    const seats = await page.$$eval('[data-seatlocno]', (e) => e.length).catch(() => 0);
    return { url, items: dedupe(items).slice(0, 80), seats };
  } catch {
    return empty;
  }
}

export function formatScreen(s: ScreenDump): string {
  if (s.items.length === 0) return '  (화면에서 아무것도 읽지 못했습니다)';
  const lines = s.items
    .slice(0, 30)
    .map((i) => `    ${pad(i.tag + (i.role ? `[${i.role}]` : ''), 14)} ${i.name}${i.hint ? `  · ${i.hint}` : ''}`);
  if (s.seats > 0) lines.push(`    (좌석 ${s.seats}개가 이미 보입니다)`);
  if (s.items.length > 30) lines.push(`    … 외 ${s.items.length - 30}개`);
  return lines.join('\n');
}

function dedupe(items: ScreenItem[]): ScreenItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = `${i.tag}|${i.role}|${i.name}|${i.hint}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
