import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Page } from 'playwright';

import { describeScreen, formatScreen } from '../src/hold/resolve.js';

/**
 * codegen 대신 쓰는 탐색기.
 *
 *   npx tsx scripts/cgv-explore.ts
 *
 * playwright codegen 은 CGV 에서 제대로 안 붙는다. SPA 라 클릭 하나가
 * 주소 변화 없이 화면을 통째로 갈아치우고, 녹화기가 뱉는 건 그날 그 화면의
 * 사진이다 — '내일' 같은 게 셀렉터로 남는다.
 *
 * 그래서 반대로 한다. **사람이 평소처럼 예매를 진행하고, 우리는 지켜본다.**
 *
 *   1. 화면 오른쪽 아래 '📸 화면 덤프' 를 누르면 그 순간 누를 수 있는 것들을
 *      전부 적는다 → 셀렉터를 짤 재료
 *   2. api.cgv.co.kr 로 나가는 요청과 응답을 통째로 적는다 → 좌석 API 계약
 *
 * 2번이 특히 중요하다. 좌석 조회 엔드포인트를 알아내면 폴링 2단을 화면
 * 클릭 없이 JSON 한 번으로 끝낼 수 있고, 그러면 좌석 블록 조건이 CGV 에서도
 * 알림 단계에서 걸린다.
 *
 * 결과는 fixtures/explore/ 에 쌓인다. 로그인 상태나 개인정보가 섞일 수 있으니
 * 커밋하지 말 것 — .gitignore 에 넣어 두었다.
 */

/**
 * 실행할 때마다 새 폴더에 쌓는다.
 *
 * 한 폴더에 겹쳐 쌓았더니 지난 실행의 파일이 남아 요약기가 옛 형식에서
 * 터졌다. 회차를 나누면 그 일이 없고, 어떤 실행에서 나온 건지도 분명해진다.
 */
const ROOT = 'fixtures/explore';
const OUT = join(ROOT, stamp());

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * 처음엔 api.cgv.co.kr 만 봤는데 예매 호출이 하나도 안 잡혔다.
 * 실측에서 걸린 건 배너·공지(met/dsp/scrDsp)뿐이었다 — 예매는 다른 호스트를 쓴다.
 * 그래서 cgv 계열 호스트에서 오는 JSON 을 전부 본다.
 */
function isCgvJson(url: URL, contentType: string): boolean {
  if (!/(^|\.)cgv\.co\.kr$/.test(url.hostname)) return false;
  if (SKIP_HOST.test(url.hostname)) return false;
  if (!/json/i.test(contentType)) return false;
  return !SKIP_PATH.some((s) => url.pathname.includes(s));
}

/** 정적 파일 호스트. Lottie 애니메이션도 JSON 이라 그냥 두면 섞여 들어온다. */
const SKIP_HOST = /^(cdn|img|image|static|asset)/;

/** 배너·공지·로고. 매 화면 수십 개씩 오는데 예매와 무관하다. */
const SKIP_PATH = [
  '/scrDsp/',
  '/mngrNtce/',
  '/checkScrenUrlValid',
  'Cpot',
  'Logo',
  '/static/',
  '/animations/',
];

/** 예매 흐름일 가능성이 큰 경로. 콘솔에서 눈에 띄게 찍는다. */
const INTERESTING = /seat|Seat|atkt|book|Book|scn|Scn|schedule|visitor|Visitor|price|Price/;

async function main() {
  mkdirSync(OUT, { recursive: true });

  const { chromium } = await import('playwright');
  const ctx = await chromium.launchPersistentContext('.profile', {
    headless: false,
    viewport: null,
  });

  let dumps = 0;
  let calls = 0;

  await ctx.exposeBinding('__dump', async ({ page }) => {
    dumps++;
    const screen = await describeScreen(page as Page);
    const name = `${String(dumps).padStart(2, '0')}-${slug(screen.url)}.json`;
    writeFileSync(join(OUT, name), JSON.stringify(screen, null, 2), 'utf8');
    console.log(`\n── 덤프 ${dumps} → ${OUT}/${name}`);
    console.log(`   ${screen.url}`);
    console.log(formatScreen(screen));
  });

  // 화면이 통째로 다시 그려져도 버튼이 살아 있도록 계속 다시 붙인다.
  await ctx.addInitScript(BUTTON);

  ctx.on('response', async (res) => {
    const url = new URL(res.url());
    const type = res.headers()['content-type'] ?? '';
    if (!isCgvJson(url, type)) return;

    calls++;
    const req = res.request();
    const body = await res.text().catch(() => '');
    const name = `api-${String(calls).padStart(2, '0')}-${slug(url.pathname)}.json`;
    writeFileSync(
      join(OUT, name),
      JSON.stringify(
        {
          host: url.hostname,
          method: req.method(),
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          // 예매 호출은 POST 가 많다. 본문이 곧 계약이다.
          postData: parse(req.postData() ?? ''),
          status: res.status(),
          headers: sanitize(req.headers()),
          body: parse(body),
        },
        null,
        2,
      ),
      'utf8',
    );
    const mark = INTERESTING.test(url.pathname) ? '★' : ' ';
    console.log(`  ${mark} ${req.method()} ${res.status()} ${url.hostname}${url.pathname} → ${name}`);
  });

  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto('https://cgv.co.kr/');

  console.log(`
탐색기가 떴습니다. 평소처럼 예매를 진행하세요.

  · 화면이 바뀔 때마다 오른쪽 아래 📸 를 누르세요 (Ctrl+Shift+D 도 됩니다)
  · api.cgv.co.kr 호출은 누르지 않아도 자동으로 기록됩니다
  · 결제는 하지 마세요. 좌석 화면까지만 가면 필요한 건 다 얻습니다

기록: ${OUT}/
끝내려면 브라우저 창을 닫으세요.
`);

  await new Promise<void>((resolve) => ctx.on('close', () => resolve()));
  console.log(`\n덤프 ${dumps}건 · API 호출 ${calls}건 을 ${OUT}/ 에 남겼습니다.`);
}

/** 쿠키와 토큰은 남기지 않는다. 계약을 알아내려는 것이지 세션이 필요한 게 아니다. */
function sanitize(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (/cookie|authorization|token|session/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function parse(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return s.slice(0, 2000);
  }
}

function slug(s: string): string {
  return s.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'page';
}

/**
 * 페이지 안에 심는 덤프 버튼.
 *
 * SPA 가 body 를 갈아치우면 버튼도 같이 날아가므로 주기적으로 다시 붙인다.
 * addInitScript 는 문자열로 넘겨야 해서 여기만 평범한 JS 다.
 */
const BUTTON = `(() => {
  const ID = '__cgv_probe__';
  function mount() {
    if (!document.body || document.getElementById(ID)) return;
    const b = document.createElement('button');
    b.id = ID;
    b.textContent = '📸 화면 덤프';
    b.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'padding:10px 14px', 'font:600 13px/1 system-ui,sans-serif',
      'background:#111', 'color:#fff', 'border:1px solid #555',
      'border-radius:6px', 'cursor:pointer', 'opacity:.85',
    ].join(';');
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      b.textContent = '📸 기록됨';
      setTimeout(() => { b.textContent = '📸 화면 덤프'; }, 900);
      window.__dump();
    }, true);
    document.body.appendChild(b);
  }
  setInterval(mount, 700);
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) window.__dump();
  }, true);
})();`;

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
