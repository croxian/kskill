import { describe, expect, it } from 'vitest';

import {
  audienceAttempts,
  dateAttempts,
  dayPattern,
  loose,
  relativeDay,
} from '../src/hold/cgv-steps.js';
import { CGV_FLOW } from '../src/hold/cgv-flow.js';

/** 2026-08-10 12:00 KST */
const NOW = Date.parse('2026-08-10T03:00:00Z');

describe('relativeDay', () => {
  it('KST 기준으로 며칠 뒤인지 센다', () => {
    expect(relativeDay('20260810', NOW)).toBe(0);
    expect(relativeDay('20260811', NOW)).toBe(1);
    expect(relativeDay('20260814', NOW)).toBe(4);
  });

  /**
   * UTC 로 계산하면 한국 시간 아침이 전날로 밀린다.
   * 그러면 '오늘' 버튼을 '내일' 로 찾는다.
   */
  it('한국 새벽에도 날짜가 밀리지 않는다', () => {
    const dawn = Date.parse('2026-08-09T22:00:00Z'); // KST 8/10 07:00
    expect(relativeDay('20260810', dawn)).toBe(0);
  });
});

describe('dateAttempts', () => {
  /**
   * codegen 이 '내일' 을 뱉었던 게 문제의 출발점이었다. 그건 녹화한 날
   * 그 화면의 이름이지 날짜를 고르는 방법이 아니다.
   */
  it('오늘이면 오늘 버튼을 먼저 본다', () => {
    const hows = dateAttempts('20260810', NOW).map((a) => a.how);
    expect(hows[0]).toContain('오늘');
    expect(hows.join()).not.toContain('내일');
  });

  it('내일이면 내일 버튼을 먼저 본다', () => {
    expect(dateAttempts('20260811', NOW)[0]?.how).toContain('내일');
  });

  it('그 밖의 날짜는 이름이 없으니 숫자와 속성으로 찾는다', () => {
    const hows = dateAttempts('20260814', NOW).map((a) => a.how);
    expect(hows.join()).not.toMatch(/오늘|내일/);
    expect(hows.join()).toContain('20260814');
    expect(hows.join()).toContain('14');
  });
});

describe('dayPattern', () => {
  it('14 는 맞고 4 나 24 는 아니다', () => {
    const re = dayPattern(14);
    expect(re.test('14')).toBe(true);
    expect(re.test('14 금')).toBe(true);
    expect(re.test('4')).toBe(false);
    expect(re.test('24')).toBe(false);
  });
});

describe('loose', () => {
  it('공백과 괄호를 무시하고 맞춘다', () => {
    expect(loose('1관 (Laser)').test('1관(Laser)')).toBe(true);
    expect(loose('1관 (Laser)').test('1관 ( Laser )')).toBe(true);
    expect(loose('IMAX관').test('IMAX 관')).toBe(true);
  });

  it('정규식 문자가 들어간 이름을 깨뜨리지 않는다', () => {
    expect(() => loose('F1: 더 무비')).not.toThrow();
    expect(loose('F1: 더 무비').test('F1:더 무비')).toBe(true);
  });
});

describe('audienceAttempts', () => {
  /**
   * flow.audience 는 '선택' 이다. 그 글자는 화면 곳곳에 있어서
   * 느슨하게 찾으면 엉뚱한 걸 누르고 성공했다고 믿는다.
   */
  it("'선택' 은 exact 로만 쓴다", () => {
    const hows = audienceAttempts(CGV_FLOW, 1).map((a) => a.how);
    const idx = hows.findIndex((h) => h.includes(CGV_FLOW.audience));
    expect(hows[idx]).toContain('exact');
    // 더 구체적인 후보가 앞에 있어야 한다
    expect(idx).toBeGreaterThan(0);
  });

  it('인원 수가 후보에 반영된다', () => {
    expect(audienceAttempts(CGV_FLOW, 2)[0]?.how).toContain('2');
  });
});
