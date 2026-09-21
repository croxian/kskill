# -*- coding: utf-8 -*-
"""
check_ktx.py - ktx_watch.py 가 안 될 때 원인을 찾는 진단 스크립트

예매는 절대 하지 않습니다. 조회만 몇 번 하고 끝납니다.

    python check_ktx.py
"""

from __future__ import annotations

import getpass
import inspect
import os
import sys
from pathlib import Path


SCRIPT_VERSION = "2026-09-21c"
print(f"*** check_ktx.py 버전: {SCRIPT_VERSION} ***")

def line(title: str) -> None:
    print("\n" + "=" * 60)
    print(title)
    print("=" * 60)


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


# --- 1. 파이썬과 라이브러리가 어디 것인지 ---------------------------------
line("1. 지금 쓰고 있는 파이썬과 korail2")
print("파이썬 버전 :", sys.version.split()[0])
print("파이썬 경로 :", sys.executable)

try:
    import korail2
except ImportError:
    print("\n[결론] korail2 가 이 파이썬에 없습니다.")
    print("       아래를 그대로 실행하세요.")
    print(f'       "{sys.executable}" -m pip install korail2-ncard pycryptodome')
    sys.exit(1)

print("korail2 경로:", getattr(korail2, "__file__", "?"))

# 설치된 배포판 이름을 확인합니다. korail2 냐 korail2-ncard 냐가 핵심입니다.
try:
    from importlib.metadata import distributions

    found = []
    for dist in distributions():
        name = (dist.metadata["Name"] or "").lower()
        if "korail" in name:
            found.append(f"{dist.metadata['Name']} {dist.version}")
    print("설치된 korail 패키지:", ", ".join(found) if found else "(이름을 못 찾음)")
    if len(found) > 1:
        print("\n[경고] korail 패키지가 두 개 이상 깔려 있습니다.")
        print("       서로 덮어써서 엉뚱한 코드가 돌 수 있습니다.")
        print("       둘 다 지우고 하나만 다시 까는 것을 권합니다.")
        print(f'       "{sys.executable}" -m pip uninstall -y korail2 korail2-ncard')
        print(f'       "{sys.executable}" -m pip install korail2-ncard')
except Exception as exc:
    print("패키지 목록 확인 실패:", exc)


# --- 2. search_train 이 실제로 받는 인자 ----------------------------------
line("2. 이 버전의 search_train 이 받는 인자")
from korail2 import Korail

try:
    sig = inspect.signature(Korail.search_train)
    print("search_train", sig)
    params = set(sig.parameters)
except Exception as exc:
    print("확인 실패:", exc)
    params = set()


# --- 3. 로그인 -------------------------------------------------------------
line("3. 로그인")
load_secrets()
korail_id = os.environ.get("KSKILL_KTX_ID") or input("코레일 아이디: ").strip()
korail_pw = os.environ.get("KSKILL_KTX_PASSWORD") or getpass.getpass("비밀번호(입력해도 안 보입니다): ")

try:
    korail = Korail(korail_id, korail_pw)
except Exception as exc:
    print(f"[실패] 로그인이 안 됩니다: {type(exc).__name__}: {exc}")
    sys.exit(1)

print("로그인 상태:", getattr(korail, "logined", "(확인 불가)"))


# --- 4. 조회 여러 방식으로 시도 -------------------------------------------
line("4. 조회 시도")

dep = input("출발역 [서울]: ").strip() or "서울"
arr = input("도착역 [부산]: ").strip() or "부산"
date = input("날짜 8자리 [내일]: ").strip()
if not date:
    import datetime as _dt

    date = (_dt.date.today() + _dt.timedelta(days=1)).strftime("%Y%m%d")

print(f"\n{dep} -> {arr}  {date}\n")


def attempt(label: str, **kwargs):
    """한 가지 방식으로 조회해 보고 결과를 출력합니다."""
    try:
        trains = korail.search_train(dep, arr, date, "000000", **kwargs)
        print(f"  [{label}] {len(trains)}건")
        for t in trains[:5]:
            print(f"       {t}")
        return trains
    except Exception as exc:
        print(f"  [{label}] {type(exc).__name__}: {exc}")
        return []


basic = attempt("기본 (빈자리만)")

full = []
if "include_no_seats" in params:
    full = attempt("매진 포함", include_no_seats=True)
else:
    print("  [매진 포함] 이 버전에는 include_no_seats 인자가 없습니다")


# --- 5. 결론 ---------------------------------------------------------------
line("5. 결론")

if basic:
    print("정상입니다. 빈자리가 있습니다.")
    print("ktx_watch.py 를 그대로 쓰시면 됩니다.")
elif full:
    print("라이브러리는 정상입니다. 열차는 보이는데 전부 매진입니다.")
    print("-> 아까 NoResultsError 가 난 건 고장이 아니라 실제로 자리가 없어서입니다.")
    print("-> ktx_watch.py 로 감시하시면 됩니다. 취소표가 나오면 잡힙니다.")
else:
    print("매진을 포함해도 열차가 하나도 안 보입니다.")
    print("아래를 순서대로 의심해 보세요.")
    print("  1) 역 이름 오타 (서울역 X -> 서울 O, 부산역 X -> 부산 O)")
    print("  2) 날짜가 너무 멀거나(예매 개시 전) 이미 지난 날짜")
    print("  3) korail2 대신 korail2-ncard 를 깔아야 하는 경우")
    print(f'     "{sys.executable}" -m pip uninstall -y korail2 korail2-ncard')
    print(f'     "{sys.executable}" -m pip install korail2-ncard')
    print("  4) 코레일이 API 를 바꿔서 라이브러리가 못 따라가는 경우")
    print("     -> 이건 사용자가 고칠 수 없습니다. 앱으로 예매하셔야 합니다.")

print("\n위 내용을 전부 복사해서 보여주시면 더 좁혀드릴 수 있습니다.")
print("(아이디와 비밀번호는 출력되지 않습니다.)")
