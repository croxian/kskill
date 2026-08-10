import { describe, expect, it } from 'vitest';

import { readable } from '../src/adapters/cgv/browser.js';

describe('readable', () => {
  /**
   * 차단 화면의 앞 200자는 전부 <style> 안의 CSS 였다.
   * 그것만 보고는 차단인지 로그인 만료인지 알 수 없었다.
   */
  it('style 과 script 를 걷어내고 글자만 남긴다', () => {
    const html =
      '<!DOCTYPE html><html><head><style>.container{display:flex;padding:0}</style>' +
      '<script>var a=1;</script></head><body><h1>비정상적인 접근입니다</h1></body></html>';
    expect(readable(html)).toBe('비정상적인 접근입니다');
  });

  it('HTML 이 아니면 그대로 자른다', () => {
    expect(readable('rate limited')).toBe('rate limited');
  });

  it('글자가 없으면 그렇다고 말한다', () => {
    expect(readable('<html><style>.a{color:red}</style></html>')).toContain('읽을 수 있는');
  });
});
