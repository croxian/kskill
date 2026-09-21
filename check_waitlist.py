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

kwargs = {"include_no_seats": True}
# 예약대기 인자를 받는 버전이면 같이 켭니다.
if "include_waiting_list" in inspect.signature(Korail.search_train).parameters:
    kwargs["include_waiting_list"] = True

try:
    if has_allday:
        trains = korail.search_train_allday(dep, arr, date, "000000", **kwargs)
    else:
        trains = korail.search_train(dep, arr, date, "000000", **kwargs)
        print("(하루 전체 조회가 없어 앞쪽 일부만 보입니다)\n")
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

print("\n위 출력을 전부 복사해서 보여주시면 더 도와드릴 수 있습니다.")
