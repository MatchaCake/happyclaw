# HappyClaw Mac mini 生产部署

本仓库的生产实例运行在用户的 Mac mini 上。代码目录为
`/Users/riba2534/airepo/happyclaw`，服务由用户级 launchd 单元
`com.riba2534.happyclaw` 管理，监听 `*:3000`。部署只能更新 Git 跟踪的代码、构建产物和
Agent 镜像；`data/`、本机环境变量、Keychain、渠道凭据及 launchd 配置必须原样保留。

## 1. 连接与前置条件

在部署机的私有 SSH 配置中维护 `macmini` 别名。主机地址、端口和密钥属于运维配置，
不得提交到仓库。下面的命令都假定 `ssh macmini` 已能免交互登录。

部署前必须满足：

- 目标提交已经推送到远程分支，且本地测试、类型检查和生产构建通过。
- 若 `container/` 或 Agent Runner 发生变化：已合入 `main` 时等待 `latest` 发布；部署尚未
  合入的远程分支时，用 GitHub Actions 的 `workflow_dispatch` 在该精确 ref 上构建，并使用
  `riba2534/happyclaw-agent:git-<完整提交 SHA>`。分支构建只发布不可变提交标签，不得推进
  公共 `latest`；Mac mini 不做本地镜像构建。
- 明确记录本次远程分支名和预期提交 SHA，不使用浮动的本地工作树作为部署来源。
- Mac mini 的安全 IPC 结果发布依赖 `/usr/bin/python3` 的原生目录相对系统调用。
  在切换前检查 `open`、`rename` 和 `unlink` 均支持 `dir_fd`；能力缺失时不得降级为
  路径写入或继续部署。

连接并设置本次部署参数：

```bash
ssh macmini
cd /Users/riba2534/airepo/happyclaw
export HAPPYCLAW_DEPLOY_REF='codex/replace-with-remote-branch'
export HAPPYCLAW_EXPECTED_SHA='replace-with-full-commit-sha'
export HAPPYCLAW_PUBLIC_URL_PRIMARY='https://claw.riba2534.cn'
export HAPPYCLAW_PUBLIC_URL_SECONDARY='https://claw.home.riba2534.cn:23333'
export HAPPYCLAW_AGENT_IMAGE='riba2534/happyclaw-agent:latest'
# 分支不可变镜像会自动派生同 SHA 的 `-headroom` 能力标签；只有实际配置
# headroom MCP 时 Docker 才按需拉取它。
```

## 2. 只读预检与目标校验

远程工作树不干净时立即停止，不要 stash、覆盖或删除未知文件：

```bash
test -z "$(git status --porcelain)" || {
  git status --short
  echo 'Remote worktree is not clean; deployment stopped.' >&2
  exit 1
}

/usr/bin/python3 -I -S -c 'import os; assert all(f in os.supports_dir_fd for f in (os.open, os.rename, os.unlink)), "Secure IPC dir_fd support unavailable"'

export HAPPYCLAW_PREVIOUS_SHA="$(git rev-parse HEAD)"
printf 'Rollback commit: %s\n' "$HAPPYCLAW_PREVIOUS_SHA"
git fetch --prune origin \
  "refs/heads/${HAPPYCLAW_DEPLOY_REF}:refs/remotes/origin/${HAPPYCLAW_DEPLOY_REF}"
test "$(git rev-parse "origin/$HAPPYCLAW_DEPLOY_REF")" = "$HAPPYCLAW_EXPECTED_SHA"
```

所有者已明确选择不保留部署备份。部署期间不得运行 `make backup`，不得创建 SQLite
快照、完整运行数据归档或 `.env` 备份副本，除非所有者在未来明确撤销该策略。禁止运行
`make reset-init`、`git clean`、`git reset --hard`，也不要用带 `--delete` 的 rsync 同步
生产目录。Mac mini 的现有 `.env` 必须原地配置
`HAPPYCLAW_SKIP_MIGRATION_BACKUP=1`；它只关闭启动时的 schema 迁移快照，其他安装默认仍会
在迁移前创建并校验快照。

## 3. 构建与切换

使用远程分支的精确提交，以 detached HEAD 部署，避免意外推进 Mac mini 上的 `main`：

```bash
git switch --detach "$HAPPYCLAW_EXPECTED_SHA"
test "$(git rev-parse HEAD)" = "$HAPPYCLAW_EXPECTED_SHA"

if grep -q '^HAPPYCLAW_SKIP_MIGRATION_BACKUP=' .env 2>/dev/null; then
  sed -i '' 's/^HAPPYCLAW_SKIP_MIGRATION_BACKUP=.*$/HAPPYCLAW_SKIP_MIGRATION_BACKUP=1/' .env
else
  printf '\nHAPPYCLAW_SKIP_MIGRATION_BACKUP=1\n' >> .env
fi
chmod 600 .env

/bin/zsh -lic 'make install'
/bin/zsh -lic 'npm run build:all'
/bin/zsh -lic "docker pull '$HAPPYCLAW_AGENT_IMAGE'"
```

若本次使用不可变分支镜像，只原地更新现有 `.env` 中的 `CONTAINER_IMAGE`；不得创建
备份副本、覆盖其他环境变量或把 `.env` 提交到 Git：

```bash
if grep -q '^CONTAINER_IMAGE=' .env 2>/dev/null; then
  sed -i '' "s|^CONTAINER_IMAGE=.*$|CONTAINER_IMAGE=$HAPPYCLAW_AGENT_IMAGE|" .env
else
  printf '\nCONTAINER_IMAGE=%s\n' "$HAPPYCLAW_AGENT_IMAGE" >> .env
fi
chmod 600 .env
```

构建失败时不要重启服务；旧进程仍在使用此前的 `dist/`。修复分支后重新从预检开始。

## 4. 重启与生产验证

```bash
launchctl kickstart -k "gui/$(id -u)/com.riba2534.happyclaw"

for attempt in {1..30}; do
  if curl -fsS http://127.0.0.1:3000/api/health; then
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo 'HappyClaw did not become healthy.' >&2
    exit 1
  fi
  sleep 2
done

launchctl print "gui/$(id -u)/com.riba2534.happyclaw" | head -40
lsof -nP -iTCP:3000 -sTCP:LISTEN
curl -fsS http://127.0.0.1:3000/api/config/appearance/public
test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/auth/me)" = 401
curl -fsS "$HAPPYCLAW_PUBLIC_URL_PRIMARY/api/health"
curl -fsS "$HAPPYCLAW_PUBLIC_URL_SECONDARY/api/health"
tail -100 "$HOME/Library/Logs/happyclaw/happyclaw.log"
```

随后从真实公网入口完成与改动相关的真实测试，并分别记录结果：

1. 未登录打开登录页，确认自定义站点名称、图形 Logo 和浏览器标题生效。
2. 注册或登录后确认同一品牌立即进入侧边栏，无需刷新页面。
3. 管理员分别修改站点名称、图形 Logo 和文字 Logo，确认保存中控件禁用，最终页面与
   `/api/config/appearance/public` 一致。
4. 展开负载均衡设置，用键盘访问策略和数字字段；数字只在失焦或 Enter 后保存，快速操作
   不得回滚为旧值。
5. 发起一个真实 Web Agent 回合；若本次涉及渠道或容器，再完成对应 IM 收发和 Container
   Agent 回合，确认流式输出、文件访问及最终回执正常。
6. 检查两个生产公网入口的 `/api/health`、TLS 和静态资源加载均成功。

本地通过不等于部署完成；以上生产检查未通过时不得报告完成。

## 5. 回滚

应用代码或构建产物异常、且数据库仍兼容旧代码时，回到第 2 节记录的提交：

```bash
git switch --detach "$HAPPYCLAW_PREVIOUS_SHA"
/bin/zsh -lic 'make install'
/bin/zsh -lic 'npm run build:all'
launchctl kickstart -k "gui/$(id -u)/com.riba2534.happyclaw"
curl -fsS http://127.0.0.1:3000/api/health
```

所有者选择不保留数据备份，因此数据库迁移后不存在数据恢复路径。若迁移导致旧代码
不兼容，应停止继续切换并以前向修复恢复服务，不得自行创建或恢复备份。回滚后重复第 4
节的健康检查与真实功能测试，并明确报告仅发生了代码回滚。
