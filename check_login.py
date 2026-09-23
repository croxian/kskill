# -*- coding: utf-8 -*-
"""
check_login.py - 코레일 로그인이 왜 실패하는지 실제 응답을 봅니다.

KeyError: 'strResult' 는 라이브러리가 응답을 해석하지 못했다는 뜻일 뿐,
코레일이 실제로 무엇을 돌려줬는지는 알려주지 않습니다. 이 스크립트는
주고받은 내용을 그대로 보여줍니다.

로그인을 딱 한 번만 시도합니다. 반복하지 않습니다.

    python check_login.py

보내는 값(아이디/비밀번호)은 출력하지 않습니다. 받은 응답만 봅니다.
"""

from __future__ import annotations

import getpass
import os
import sys
from pathlib import Path

SCRIPT_VERSION = "2026-09-23a"
print(f"*** check_login.py 버전: {SCRIPT_VERSION} ***\n")


def load_secrets() -> None:
    path = Path.home() / ".config" / "k-skill" / "secrets.env"
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        raw = raw.strip()
        if not raw or raw.startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


import requests

# 코레일이 실제로 무엇을 돌려주는지 가로채서 보여줍니다.
# 보내는 쪽(아이디/비밀번호)은 건드리지 않고 출력도 하지 않습니다.
_orig_post = requests.Session.post
_orig_get = requests.Session.get


def _show(label: str, resp) -> None:
    print(f"\n--- {label} {resp.url.split('?')[0]}")
    print(f"    상태코드 : {resp.status_code}")
    ctype = resp.headers.get("Content-Type", "?")
    print(f"    형식     : {ctype}")
    body = resp.text or ""
    print(f"    길이     : {len(body)} 글자")
    print(f"    앞부분   : {body[:400]!r}")


def _post(self, url, *a, **k):
    r = _orig_post(self, url, *a, **k)
    _show("POST", r)
    return r


def _get(self, url, *a, **k):
    r = _orig_get(self, url, *a, **k)
    _show("GET ", r)
    return r


requests.Session.post = _post
requests.Session.get = _get

load_secrets()
korail_id = os.environ.get("KSKILL_KTX_ID") or input("코레일 아이디: ").strip()
korail_pw = os.environ.get("KSKILL_KTX_PASSWORD") or getpass.getpass("비밀번호(안 보입니다): ")

print("로그인을 한 번만 시도합니다...")

from korail2 import Korail

try:
    korail = Korail(korail_id, korail_pw)
    print("\n=== 결과: 로그인 성공 ===")
    print("로그인 상태:", getattr(korail, "logined", "(확인 불가)"))
except Exception as exc:
    print(f"\n=== 결과: 로그인 실패 — {type(exc).__name__}: {exc} ===")
    print()
    print("위의 '앞부분' 을 보세요.")
    print("  - HTML 이고 '차단' / 'blocked' / '비정상' 이 보이면 -> 코레일이 이 IP 를 막은 것")
    print("  - HTML 이고 '점검' 이 보이면                       -> 코레일 시스템 점검 중")
    print("  - JSON 인데 strResult 가 없으면                    -> 코레일이 응답 형식을 바꾼 것")
    print("  - 상태코드가 403 / 503 이면                        -> 접근 거부 또는 서비스 중단")
    sys.exit(1)
