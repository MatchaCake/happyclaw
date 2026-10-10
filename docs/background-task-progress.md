# 后台 / 定时任务运行的结构化进度

本文档描述 durable 后台与定时任务运行（`task_runs`）的结构化进度机制：
数据模型、上报通道、信任边界、展示分期与生命周期交互。第一切片（Phase 1）
已随本文档落地。

## 1. 目标与现状

在本机制之前，隔离后台/定时运行没有任何进度通道：

- `task_runs` 只有状态机字段（queued/running/...），没有进度列。
- `/tasks` 页面在有活跃 Run 时每 3 秒轮询 `GET /api/tasks`，但只能看到
  "运行中"，看不到运行到了哪一步。
- `WsMessageOut` 里的 `task_state` 事件类型已定义但从未发出。
- 隔离运行的 stream event 广播在 `${workspace.jid}#task:${taskRunId}` 虚拟
  JID 上，Web 端从不订阅，整条流被丢弃。

目标：让长时间后台任务（`run_background_task`、isolated 定时任务）能以低成本
向用户暴露"做到哪了"，并为后续推送/流式展示留出清晰演进路径。

## 2. 数据模型

本切片在 `task_runs` 上新增三列（schema v77，`ensureColumn` 幂等迁移）：

| 列                    | 类型    | 含义                              |
| --------------------- | ------- | --------------------------------- |
| `progress_summary`    | TEXT    | 最新一条人类可读进度（≤300 字符） |
| `progress_percent`    | INTEGER | 可选总体完成度估计，0–100         |
| `progress_updated_at` | TEXT    | 快照写入时间（ISO）               |

这是**覆盖式快照**：每次上报覆盖上一次，Run 行上永远只有"当前进度"。

曾考虑过 append-only 的 progress events 表（每次上报插入一行），它能提供完整
进度时间线，但需要保留策略/清理任务、分页查询和去重展示；而现有消费方
（3 秒 REST 轮询）只需要最新一条。先选覆盖式快照的理由：

- 无保留策略负担：行数不随运行时长增长，随 Run 一起被既有清理逻辑管理。
- 轮询友好：`GET /api/tasks` 已返回 `current_run` 整行，零额外查询。
- 不排斥演进：未来若需要时间线，可增加 events 表并让快照列退化为物化的
  "最新一行"，接口不变。

## 3. 上报通道与信任边界

```text
Agent（隔离运行内）
  └─ report_task_progress MCP 工具（summary 1..300，percent 0..100 可选）
       └─ tasks IPC：{type:'report_task_progress', requestId, summary, percent?}
            └─ 主进程 processTaskIpc
                 ├─ 从 IPC 命名空间 task-run-<uuid>-attempt-<n> 推导 runId
                 ├─ resolveScheduledTaskIpcRunId 校验 Run 存在、isolated、
                 │   属于来源工作区
                 └─ updateTaskRunProgress：UPDATE ... WHERE status='running'
```

信任边界：**运行归属只由经过验证的 IPC 命名空间推导**。

- 每个隔离运行拥有私有 IPC 目录 `task-run-${runId}-attempt-${n}`，由主进程
  创建，容器不可伪造。
- 主进程拒绝一切来自 payload 的 runId（`scheduledTaskRunId` 只允许与命名空间
  一致）；普通会话 Agent 的 IPC 目录没有任务命名空间，请求被直接拒绝，返回
  `Progress reporting is only available inside a background/scheduled task run.`
- group 模式定时任务走工作区主会话，不属于本机制（其进度即主会话本身）。

工具侧约定：宿主机拒绝（非后台运行、Run 已结束）返回**非错误**的提示文本，
不会使 Agent 当前回合失败；只有格式非法的输入（空 summary）才是工具错误。

## 4. 展示分期

- **Phase 1（本切片）**：REST 轮询。`GET /api/tasks` 的 `current_run` 与
  `GET /api/tasks/:id/runs` 的 Run 行自动携带三个新字段；`/tasks` 卡片在
  Run `running` 且有快照时显示 `42% · 摘要 · 相对时间`，详情页在"执行中..."
  旁显示同一行。
- **Phase 2**：复用已定义的 `WsMessageOut.task_state` 推送进度与状态变化，
  替代/补充 3 秒轮询，消除进度延迟。
- **Phase 3**：Web 订阅 `#task:` 虚拟 JID 的 stream_event，获得完整流式运行
  视图（工具调用、输出）；IM 渠道将进度映射为可更新卡片（飞书 Streaming
  Card 等）。

## 5. 与 Run 生命周期的交互

- **只在 `running` 时可写**：`updateTaskRunProgress` 的 UPDATE 以
  `status='running'` 为前置条件；来自已结束 Run 或过期 attempt 的迟到上报被
  丢弃（返回 `updated:false`，不报错）。
- **终态保留最后快照**：success/failed/cancelled 不清空进度列，作为历史记录
  随 Run 保留。
- **重试清空**：`claimNextTaskRun`（新 attempt 开始）与
  `releaseTaskRunForRetry`（释放等待重试）都会清空三列，新 attempt 永远不会
  显示上一个 attempt 的进度。
- **取消/失败不回写**：取消或失败路径不生成合成进度，字段停留在最后一次
  真实上报。

## 6. 测试与兼容性边界

- 迁移：`tests/schema-v77-task-run-progress.test.ts` 用 v76 遗留库验证列补齐、
  幂等重入与 `updateTaskRunProgress` 行为（含 running 门控与重试清空）；
  `tests/db-upgrade-safety.test.ts` 的版本 pin 同步升级。备份、前向升级与
  拒绝降级由通用迁移机制自动覆盖。
- 工具契约：`tests/mcp-task-v2-contract.test.ts` 断言 IPC payload 形状、
  空 summary 本地拒绝、宿主机拒绝时的非错误返回。
- 宿主机处理器：`tests/report-task-progress-ipc.test.ts` 用 runtime source
  harness 验证非任务命名空间拒绝、运行中 Run 更新成功、已结束 Run 返回
  `updated:false`。
- 兼容性：旧 Run 行三列为 NULL（语义即"从未上报"）；旧 Runner 不认识新工具
  不受影响；旧服务端收到未知 IPC type 走默认分支忽略，工具返回超时提示而非
  失败。
