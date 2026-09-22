#!/usr/bin/env bash
# 최신 코드를 받아 서버에 반영하고 봇을 다시 시작합니다.
#
#   cd ~/kskill && bash deploy/update.sh
#
# sudo 를 앞에 붙이지 마세요. 필요한 부분에서만 알아서 씁니다.

set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

if [ "$(id -u)" -eq 0 ]; then
  echo "sudo 없이 실행하세요:  bash deploy/update.sh" >&2
  exit 1
fi

say "1/4 내가 고친 파일이 있는지 확인"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "    이 폴더에서 직접 고친 파일이 있습니다:"
  git --no-pager diff --name-only | sed 's/^/      /'
  echo
  echo "    받아오기 전에 정리해야 합니다. 둘 중 하나를 고르세요."
  echo "      내 수정을 살리려면 : git stash        (나중에 git stash pop)"
  echo "      내 수정을 버리려면 : git checkout ."
  exit 1
fi
echo "    깨끗합니다"

say "2/4 최신 코드 받기"
BEFORE="$(git rev-parse HEAD)"
git pull --ff-only
AFTER="$(git rev-parse HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  echo "    이미 최신입니다"
else
  echo "    바뀐 파일:"
  git --no-pager diff --name-only "$BEFORE" "$AFTER" | sed 's/^/      /'
fi

say "3/4 서버에 반영 (/opt/ktx-bot 으로 복사)"
sudo bash deploy/setup-ubuntu.sh >/dev/null
echo "    완료"

say "4/4 봇 다시 시작"
sudo systemctl restart ktx-bot
sleep 2
sudo systemctl status ktx-bot --no-pager | head -12

echo
echo "로그를 보려면:  sudo journalctl -u ktx-bot -f"
echo
