# 测试环境部署与回滚手册

本手册只适用于测试环境 `https://test.renwz.cn`。生产环境 `https://xm.renwz.cn` 不在本手册范围内，除非用户明确授权，不得重启、同步或修改生产服务。

## 部署前检查

```bash
cd /Users/eason/Documents/OZON/siboman
git status --short --branch
npm run test:erp
npm run test:extension-release
```

确认重点：

- 批量上架 guard 通过。
- 插件 `manifest.json`、`background.js VERSION`、店铺管理下载版本、zip 内版本一致。
- 本次变更没有触碰受保护的批量上架 payload 或插件核心逻辑；如触碰，必须补专门回归记录。

## 备份

测试环境部署前创建独立备份目录：

```bash
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/opt/ozon/backups/test-${TS}"
ssh root@test.renwz.cn "mkdir -p '$BACKUP_DIR' && rsync -a /opt/ozon/app-test/ '$BACKUP_DIR/app-test/'"
```

记录：

- 备份目录
- 当前 `/api/version`
- 本地 git 分支与 `git status --short`
- 扩展 zip sha256

## 部署

```bash
rsync -a --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude .env \
  --exclude '.env.*' \
  /Users/eason/Documents/OZON/siboman/ \
  root@test.renwz.cn:/opt/ozon/app-test/

ssh root@test.renwz.cn "cd /opt/ozon/app-test && npm install --omit=dev && systemctl restart ozon-app-test && systemctl status ozon-app-test --no-pager"
```

如果本次有明确验收版本，写入 `.env.build`：

```bash
ssh root@test.renwz.cn "cat > /opt/ozon/app-test/.env.build <<'EOF'
BUILD_VERSION=vX.Y.Z-test-描述
EOF
systemctl restart ozon-app-test"
```

注意：不要从本地同步 `.env` 到测试服务器。测试环境数据库、端口、登录密码等私密配置以服务器 `/opt/ozon/app-test/.env` 为准，部署只允许按需写入 `.env.build`。

## 部署后 Smoke

按 [test-env-smoke-checklist.md](/Users/eason/Documents/OZON/siboman/docs/deploy/test-env-smoke-checklist.md) 执行，并把结果写入 `docs/testing/acceptance-runs/`。

## 回滚

```bash
BACKUP_DIR="/opt/ozon/backups/test-YYYYMMDD-HHMMSS"
ssh root@test.renwz.cn "rsync -a --delete '$BACKUP_DIR/app-test/' /opt/ozon/app-test/ && systemctl restart ozon-app-test && systemctl status ozon-app-test --no-pager"
```

回滚后必须重新检查：

```bash
curl -fsS https://test.renwz.cn/api/version
curl -fsS https://test.renwz.cn/extension/zhumeng-collector/manifest.json
```
