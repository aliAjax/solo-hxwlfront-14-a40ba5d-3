#!/usr/bin/env bash
# 在无法以 root 执行 `npx playwright install-deps` 的环境里，
# 用 apt-get download（无需 root）把 Chromium 运行所需的共享库下载并解包到 .syslib/root。
# 测试启动器 scripts/run-tests.mjs 会自动把这些目录加入 LD_LIBRARY_PATH。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYS="$ROOT/.syslib"
mkdir -p "$SYS/debs" "$SYS/lists/partial" "$SYS/root"
cd "$SYS/debs"

PKGS=(
  libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1
  libasound2 libdbus-1-3 libatspi2.0-0 libxi6 libwayland-server0
)

OPTS=(-o "Dir::State::Lists=$SYS/lists/" -o "Dir::State::status=/var/lib/dpkg/status")

# 仅在本地包索引缺失时更新
if [ -z "$(find "$SYS/lists" -name '*Packages*' -print -quit 2>/dev/null)" ]; then
  apt-get "${OPTS[@]}" update
fi
apt-get "${OPTS[@]}" download "${PKGS[@]}" || true

for f in *.deb; do
  [ -e "$f" ] && dpkg-deb -x "$f" "$SYS/root/"
done

echo "本地 Chromium 依赖库已解包到 $SYS/root"
