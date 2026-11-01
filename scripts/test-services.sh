#!/usr/bin/env bash
# 集成测试：启动 docker/compose.test.yml 里的 Gitea、WebDAV、S3，建测试账号，跑 tests/integration，最后停掉服务。
# 测试账号的密码每次随机生成，只放在本次运行的环境变量里，不写入任何文件。
#
# 用法：bash scripts/test-services.sh [--keep]      --keep 表示测完不停服务
# 性能测试：MB_TEST_CMD="pnpm test:perf" bash scripts/test-services.sh
# 用另一台机器的 Docker：MB_DOCKER_SSH=root@<测试机地址> bash scripts/test-services.sh
#   （需要能 ssh 登录这台机器；必须是可以随意改动的测试机，不要用生产服务器）
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$ROOT"

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1
REMOTE="${MB_DOCKER_SSH:-}"

if [ -n "$REMOTE" ]; then
  RDIR=/opt/multi-backup-test
  ssh "$REMOTE" "mkdir -p $RDIR"
  scp -q docker/compose.test.yml "$REMOTE:$RDIR/compose.test.yml"
  COMPOSE="docker compose -f $RDIR/compose.test.yml"
  HOST="${REMOTE#*@}"
  run() { ssh "$REMOTE" "$1"; }
else
  COMPOSE="docker compose -f docker/compose.test.yml"
  HOST=127.0.0.1
  run() { bash -c "$1"; }
fi

stop() { [ "$KEEP" = 1 ] || run "MB_WEBDAV_PASSWORD=x MB_S3_SECRET=x $COMPOSE down -v" >/dev/null 2>&1 || true; }
trap stop EXIT

gen() { node -e "process.stdout.write(require('crypto').randomBytes(12).toString('hex'))"; }
WEBDAV_PW="w$(gen)"
S3_SECRET="s$(gen)"
ENVS="MB_WEBDAV_PASSWORD=$WEBDAV_PW MB_S3_SECRET=$S3_SECRET"

echo "[1/3] 启动 Gitea（$HOST:3300）、WebDAV（$HOST:3880）、S3（$HOST:3900）"
run "$ENVS $COMPOSE up -d --wait gitea webdav s3"

echo "[2/3] 建测试账号 mbtest"
PW="mb$(node -e "process.stdout.write(require('crypto').randomBytes(12).toString('hex'))")"
GITEA="$ENVS $COMPOSE exec -T -u git gitea gitea admin user"
run "$GITEA create --admin --username mbtest --email mbtest@example.com --password $PW --must-change-password=false" >/dev/null 2>&1 \
  || run "$GITEA change-password --username mbtest --password $PW --must-change-password=false" >/dev/null

echo "[3/3] 集成测试"
MB_GITEA_URL="http://$HOST:3300" MB_GITEA_USER=mbtest MB_GITEA_PASSWORD="$PW" MB_WEBDAV_URL="http://$HOST:3880/" MB_WEBDAV_USER=mbtest MB_WEBDAV_PASSWORD="$WEBDAV_PW" MB_S3_ENDPOINT="http://$HOST:3900" MB_S3_KEY=mbtest MB_S3_SECRET="$S3_SECRET" ${MB_TEST_CMD:-pnpm test:integration}
