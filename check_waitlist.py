# -*- coding: utf-8 -*-
"""
check_waitlist.py - 예약대기 지원 여부 확인 + 하루 전체 좌석 현황

search_train 은 한 번에 10건쯤만 돌려줍니다. 그래서 00:00 부터 찾으면
새벽 열차만 보이고 "전부 매진"처럼 보입니다. 이 스크립트는 하루 전체를
훑어서 실제로 어느 열차에 자리가 있는지 보여줍니다.

동시에 이 라이브러리가 예약대기(waiting list)를 지원하는지 확인합니다.

조회만 합니다. 예매도 예약대기 신청도 하지 않습니다.

    python check_waitlist.py
"""

from __future__ import annotations

import datetime as dt
import getpass
import inspect
import os
from pathlib import Path


def keep_supported(fn, candidates: dict) -> dict:
    """fn 이 실제로 받는 인자만 남깁니다.

    search_train 과 search_train_allday 는 받는 인자가 서로 다릅니다.
    한쪽 기준으로 만든 인자를 다른 쪽에 그대로 넘기면 TypeError 가 납니다.
    """
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return dict(candidates)
    # **kwargs 를 받는 함수면 전부 통과시킵니다.
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return dict(candidates)
    return {k: v for k, v in candidates.items() if k in params}


def line(title: str) -> None:
    print("\n" + "=" * 64)
    print(title)
    print("=" * 64)


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


import korail2
from korail2 import Korail

# --- 1. 이 라이브러리가 무엇을 할 수 있는지 -------------------------------
line("1. 라이브러리가 지원하는 기능")

has_allday = hasattr(Korail, "search_train_allday")
print("하루 전체 조회 (search_train_allday):", "있음" if has_allday else "없음")
if has_allday:
    try:
        print("  search_train_allday", inspect.signature(Korail.search_train_allday))
    except Exception as exc:
        print("  시그니처 확인 실패:", exc)

print("\nreserve 가 받는 인자:")
try:
    print("  reserve", inspect.signature(Korail.reserve))
except Exception as exc:
    print("  확인 실패:", exc)

# 예약대기 신청용 함수나 옵션이 있는지 찾아봅니다.
print("\n예약대기 관련으로 보이는 것:")
hits = []
for name in dir(korail2):
    low = name.lower()
    if "wait" in low or "reserveoption" in low or "option" in low:
        hits.append(name)
for name in dir(Korail):
    if name.startswith("_"):
        continue
    if "wait" in name.lower():
        hits.append(f"Korail.{name}")
print("  " + (", ".join(hits) if hits else "(없음)"))

# ReserveOption 이 있으면 어떤 값이 있는지 봅니다.
ReserveOption = getattr(korail2, "ReserveOption", None)
if ReserveOption is not None:
    opts = [n for n in dir(ReserveOption) if not n.startswith("_")]
    print("  ReserveOption 값:", ", ".join(opts))


# --- 2. 로그인 -------------------------------------------------------------
line("2. 로그인")
load_secrets()
korail_id = os.environ.get("KSKILL_KTX_ID") or input("코레일 아이디: ").strip()
korail_pw = os.environ.get("KSKILL_KTX_PASSWORD") or getpass.getpass("비밀번호(안 보입니다): ")

korail = Korail(korail_id, korail_pw)
print("로그인 상태:", getattr(korail, "logined", "(확인 불가)"))


# --- 3. 하루 전체 조회 -----------------------------------------------------
line("3. 하루 전체 좌석 현황")

dep = (input("출발역 [서울]: ").strip() or "서울").removesuffix("역") or "서울"
arr = (input("도착역 [부산]: ").strip() or "부산").removesuffix("역") or "부산"
raw_date = "".join(c for c in input("날짜 [내일]: ") if c.isdigit())
date = raw_date[:8] if len(raw_date) >= 8 else (dt.date.today() + dt.timedelta(days=1)).strftime("%Y%m%d")

print(f"\n{dep} -> {arr}  {date}  (첫차부터 끝차까지)\n")

# 쓰고 싶은 인자를 먼저 적어두고, 실제로 부를 함수가 받는 것만 골라 씁니다.
wanted = {"include_no_seats": True, "include_waiting_list": True}

fn = korail.search_train_allday if has_allday else korail.search_train
kwargs = keep_supported(fn, wanted)

dropped = sorted(set(wanted) - set(kwargs))
asked_waiting = "include_waiting_list" in kwargs
if dropped:
    print(f"(이 함수가 안 받는 인자는 뺐습니다: {', '.join(dropped)})")
if not has_allday:
    print("(하루 전체 조회가 없어 앞쪽 일부만 보입니다)")
print()

try:
    trains = fn(dep, arr, date, "000000", **kwargs)
except Exception as exc:
    print(f"[실패] {type(exc).__name__}: {exc}")
    raise SystemExit(1)

print(f"총 {len(trains)}건\n")


def call(train, method: str):
    """train.has_seat() 같은 걸 있으면 부르고, 없으면 None 을 돌려줍니다."""
    fn = getattr(train, method, None)
    if not callable(fn):
        return None
    try:
        return bool(fn())
    except Exception:
        return None


free = 0
waitable = 0
for t in trains:
    seat = call(t, "has_seat")
    wait = call(t, "has_waiting_list")

    if seat:
        mark, free = "[빈자리]", free + 1
    elif wait:
        mark, waitable = "[예약대기]", waitable + 1
    elif seat is None:
        mark = "[판단불가]"
    else:
        mark = "[매진]  "

    print(f"  {mark} {t}")

line("4. 결론")
print(f"빈자리 있는 열차   : {free}건")
print(f"예약대기 가능 열차 : {waitable}건")

if free:
    print("\n자리가 있습니다. 지금 코레일톡으로 바로 예매하세요.")
elif waitable:
    print("\n빈자리는 없지만 예약대기를 걸 수 있는 열차가 있습니다.")
    print("코레일톡 앱에서 예약대기를 신청하는 편이 가장 확실합니다.")
    print("줄을 서두면 자리가 나올 때 코레일이 배정해 줍니다.")
else:
    print("\n빈자리도 예약대기도 없습니다.")
    print("ktx_watch.py 로 취소표를 감시하거나, 다른 날짜/시간대를 보세요.")

if not asked_waiting:
    print("\n[주의] 이 조회는 예약대기 열차를 빼고 가져왔을 수 있습니다.")
    print("       (search_train_allday 가 include_waiting_list 를 안 받습니다)")
    print("       예약대기 가능 여부는 코레일톡 앱에서 확인하는 것이 정확합니다.")

print("\n위 출력을 전부 복사해서 보여주시면 더 도와드릴 수 있습니다.")
