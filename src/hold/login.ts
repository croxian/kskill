import type { Page } from 'playwright';

import type { LotteFlow } from './selectors.js';

/**
 * 로그인 세션 관리.
 *
 * 자동 로그인은 **세션이 죽었을 때만** 쓴다. 평소에는 .profile 에 남은
 * 세션이 유지되므로 며칠에 한 번 일어날까 말까다. 계정 잠금의 진짜
 * 위험은 자동 로그인 자체가 아니라 빈도라서, 이 설계가 중요하다.
 *
 * 자격증명은 .env 에만 둔다. 셸 인자로 넘기면 히스토리에 남고,
 * 로그에 찍으면 터미널 스크롤백에 남는다. 둘 다 하지 않는다.
 */

export interface Credentials {
  id: string;
  password: string;
}

export type LoginOutcome =
  /** 이미 로그인되어 있었다 */
  | 'already'
  /** 자동 로그인에 성공했다 */
  | 'recovered'
  /** 로그아웃 상태인데 자격증명이 없다. 사람이 해야 한다 */
  | 'needs-human';

export class LoginFailedError extends Error {
  constructor(reason: string) {
    super(`자동 로그인 실패: ${reason}`);
    this.name = 'LoginFailedError';
  }
}

/** 있으면 쓰고 없으면 안 쓴다. 자동 로그인은 옵트인이다. */
export function credentialsFromEnv(env = process.env): Credentials | undefined {
  const id = env.LOTTE_ID?.trim();
  const password = env.LOTTE_PW;
  return id && password ? { id, password } : undefined;
}

/** 로그인 링크가 보이면 로그아웃 상태다. */
export async function isLoggedOut(page: Page, flow: LotteFlow): Promise<boolean> {
  return page
    .getByRole('link', { name: flow.loginLink, exact: true })
    .isVisible()
    .catch(() => false);
}

/**
 * 로그인되어 있으면 그대로 두고, 아니면 자격증명으로 한 번 시도한다.
 *
 * 재시도하지 않는다. 비밀번호가 틀렸는데 반복 시도하면 그게 바로
 * 계정 잠금으로 가는 길이다.
 */
export async function ensureLoggedIn(
  page: Page,
  flow: LotteFlow,
  creds?: Credentials,
): Promise<LoginOutcome> {
  if (!(await isLoggedOut(page, flow))) return 'already';
  if (!creds) return 'needs-human';

  await page.getByRole('link', { name: flow.loginLink, exact: true }).click();
  await page.getByPlaceholder(flow.idInput).fill(creds.id);
  await page.getByPlaceholder(flow.pwInput).fill(creds.password);
  await page.getByRole('button', { name: flow.loginSubmit, exact: true }).click();

  // 캡차나 기기 인증이 뜨면 뚫지 않는다. 사람을 부른다.
  if (flow.interstitial) {
    const blocked = await page
      .locator(flow.interstitial)
      .isVisible()
      .catch(() => false);
    if (blocked) throw new LoginFailedError('캡차 또는 추가 인증이 필요합니다');
  }

  await page
    .getByRole('link', { name: flow.loginLink, exact: true })
    .waitFor({ state: 'hidden', timeout: flow.loginTimeoutMs })
    .catch(() => {
      throw new LoginFailedError('로그인 후에도 로그인 링크가 남아 있습니다');
    });

  return 'recovered';
}
