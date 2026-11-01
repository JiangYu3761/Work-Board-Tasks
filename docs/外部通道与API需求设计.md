# 北向 NORTH：外部 CLI、Agent API 与飞书通知通道

版本：1.0 · 2026-10-25 · 当前状态：API、CLI、事件记录及飞书适配已实现；飞书真实发送待配置。

## 1. 要解决的问题

北向已经提供资讯、竞品品牌、ASIN 商品与搜索词监控。现在需要让这些能力脱离特定聊天任务：CLI 或其他 Agent 可以查询和操作同一套业务数据，系统出现变化后也可以把内容交给飞书通道。

本次建立三个稳定入口：

1. `/api/v1`：带身份、权限、版本和调用记录的 HTTP 接口。
2. `north` CLI：面向人和 Agent 的命令入口，默认输出 JSON。
3. `events` 事件流与 `notifications` 投递队列：连接监控结果、自定义内容和飞书 CLI。

另一台机器上的飞书 Agent 也可以只读取事件流，自行完成通知；这时不依赖本机安装飞书 CLI。

## 2. 使用场景与验收目标

| 编号 | 使用场景 | 预期结果 |
|---|---|---|
| R1 | 更换 Agent 后接手关键词监控 | 读取能力清单，获取同一份监控配置、排名、广告与品牌数据 |
| R2 | CLI 添加监控、导入销量或处理异常 | 调用现有领域服务，沿用网页的数据校验与采集额度 |
| R3 | 定时采集出现失败或重要变化 | 产生可追溯事件，启用飞书后进入持久化队列 |
| R4 | Agent 生成了报告或其他内容 | 发布自定义事件；可选择只保存，或请求飞书通知 |
| R5 | 更换飞书客户端或移到另一台机器 | 保留事件协议和游标，由新的消费者接续读取 |
| R6 | CLI 超时或进程退出 | 保留请求标识、事件和投递状态；不会把未知结果报告为成功 |
| R7 | 收回某个 Agent 的权限 | 撤销该 Agent 的独立凭证，不影响其他凭证 |

“同样的功能”指当前系统已经实现的业务能力。API 不额外产生亚马逊官方搜索词销量、未采集的历史或未确认的 HOMA ASIN 身份。

## 3. 架构

```mermaid
flowchart LR
    U[网页] --> D[现有业务服务]
    A[任意 Agent / north CLI] --> V[版本化 API / 身份与权限]
    V --> D
    D --> DB[(PostgreSQL)]
    DB --> B[监控事件汇集]
    A --> E[自定义事件发布]
    B --> L[(持久化事件流)]
    E --> L
    L --> C[外部 CLI 按游标读取]
    L --> Q[(飞书投递队列)]
    Q --> W[通知 worker]
    W --> F[本机 lark-cli / 群机器人]
    C --> X[其他机器上的飞书 Agent]
```

网页和 API 复用相同的业务函数。API 层负责认证、权限、精确路由、调用记录和错误格式；不会维护第二套计算排名、销量或广告份额的逻辑。

事件流用于记录“发生了什么”，投递队列用于记录“是否已通知”。事件入库与投递入队在同一事务中完成，API 返回“已入队”时，不能解读为飞书已收到。

## 4. API 能力范围

共 63 个方法与路径组合，以程序生成的 [OpenAPI 文件](openapi-v1.json) 和在线 `/api/v1/capabilities` 为准。

| 模块 | 对外能力 | 权限 |
|---|---|---|
| 资讯 | 总览、搜索、筛选、来源状态、收藏、同步来源 | `news:read` / `news:write` |
| 品牌竞品 | 品牌、型号、链接、价格观察、官方动态的读取与维护 | `competitors:read` / `competitors:write` |
| 搜索词 | 新建与更新监控、采集、快照、截图、排名、广告与品牌汇总、HOMA 身份映射、销量、固定集合、异常处理、CSV 导出 | `search:read` / `search:write` |
| ASIN 商品 | 配置与批量导入、采集、快照、差异、证据、事件处理、日报、采集额度、导出 | `asin:read` / `asin:write` |
| 采集任务 | 按任务 ID 查询搜索或商品采集进展 | 对应模块的 `read` |
| 外部事件 | 按游标读取、发布自定义内容、预览通知 | `events:read` / `events:write` |
| 通知投递 | 查询队列、重试明确失败、人工核查、取消排队 | 读取用 `events:read`，操作用 `notify:write` |
| 系统发现 | 健康检查、能力清单、OpenAPI、通道状态 | 任意有效凭证 |

写权限不隐含读权限。一个会读取并处理异常的 Agent，需要同时持有相关的 `read` 和 `write`。权限按模块划分，当前没有按品牌、监控对象或团队隔离的多租户权限。

### 4.1 关键业务调用

| 方法与路径（均在 `/api/v1` 下） | 用途 |
|---|---|
| `GET /search/overview` | 监控词、最新快照、任务、提醒、身份映射 |
| `GET /search/monitors/{id}?days=30` | 单词历史及快照 |
| `GET /search/ranks?monitor={id}&asin={asin}&days=30` | 指定产品自然位变化 |
| `POST /search/monitors/{id}/run` | 当前时点采集，返回 202 与任务 ID |
| `GET /jobs/search/{id}` | 检查采集是否完成、失败或受阻 |
| `GET /search/sales?period={key}&snapshot={id}` | 明确来源与周期的样本商品销量 |
| `POST /search/identities` | 经核实后标记 HOMA 与自有产品 |
| `POST /search/sales-preview` | 校验 CSV 并生成预览批次 |
| `POST /search/sales-batches/{id}/commit` | 提交已核实批次 |
| `POST /search/alerts/{id}` | 处理异常并记录负责人、说明、复查日 |
| `GET /asin-monitors/{id}` | 商品状态、观察历史与变化 |
| `POST /asin-monitors/{id}/check` | 商品采集排队，返回 202 |
| `GET /jobs/asin/{id}` | 商品采集任务状态 |
| `GET /events?after=0&limit=50` | 读取可供飞书或其他 Agent 消费的事件 |
| `POST /events` | 发布自定义内容，可选通知 |
| `POST /notifications/preview` | 预览将要发送的纯文本 |
| `GET /notifications?state=uncertain` | 查找需要核查的投递 |

搜索监控更新是完整配置更新：先读取当前 `monitor`，只修改需要调整的字段，再提交完整配置。关键词或采样环境改变时需新建监控，避免改写原历史口径。ASIN 更新支持已有接口的局部配置更新。

### 4.2 数据与错误约定

- JSON 成功响应保留业务结构；截图与导出保持文件媒体类型。CLI 下载文件时必须指定 `--output`。
- 每个 v1 请求带 `X-Request-Id` 与 `X-North-API-Version: v1`。
- 失败统一为 `{error:{code,message,request_id},request_id}`，使用实际 HTTP 状态码。
- 401 为凭证问题；403 为权限不足；400 为业务校验；409 为状态或幂等冲突；415 为媒体类型问题；429 为限流；500 为内部异常。
- 写请求使用 `Content-Type: application/json`。搜索领域请求最多 4 MiB；ASIN 请求最多 2,000,000 字节；自定义事件请求最多 65,536 字节；其余现有业务请求最多 16,000 字节。
- 每枚凭证每分钟允许 120 次读取、30 次写入。当前为单进程计数；重启后重新计数。
- 202 只表示任务排队。Agent 应读取任务状态，确认采集成功与质量标记后再分析。
- 未观察到、采集失败、身份未知和销量缺失沿用原业务状态，不能转成 0 或负面经营结论。
- 时间以带时区时间戳传递，业务日期仍为 `YYYY-MM-DD`；自然位比较仍受采样环境、时段和口径限制。

## 5. 身份、权限与部署边界

每个 Agent 使用独立 Bearer Token。数据库只保存 SHA-256 摘要，原始随机凭证写入权限为 `0600` 的本机文件，CLI 不打印凭证内容。默认有效期 90 天，可指定 1–365 天；可随时按凭证 ID 撤销。

凭证的创建、列表与撤销使用本机管理员 CLI，需要数据库访问权限；这些管理操作没有远程 HTTP 接口。业务请求的凭证 ID、路由模板、方法、状态与请求标识写入审计表，不保存授权头、完整请求正文或查询词。

服务继续监听 `127.0.0.1:4317`。这是已经实现的本机接口，不是已部署的公网服务。远程 Agent 可以使用 SSH 隧道；如未来发布 HTTPS 入口，反向代理仅转发 `/api/v1/`，并将上游 Host 设置为 `127.0.0.1:4317`。旧 `/api/` 网页接口属于可信本机边界，不能整体代理到公网。

不支持浏览器跨域 CORS。外部接入定位为服务器或 CLI。CLI 只接受本机 HTTP 或远程 HTTPS，拒绝重定向，避免携带凭证跳转到其他站点。

## 6. 事件协议

### 6.1 发布内容

`POST /api/v1/events` 必须带稳定的 `Idempotency-Key`。示例为协议说明，不会自动发送：

```json
{
  "type": "agent.report.ready",
  "severity": "important",
  "title": "HOMA 搜索监控分析已完成",
  "body": "填写已核实的结论、数据截至时间和需要处理的事项。",
  "object_ref": {"kind": "report", "id": "report-20261025"},
  "notify": false
}
```

外部类型限定为 `agent.*` 或 `external.*`，避免冒充 `search.*`、`asin.*` 系统事件。事件读取结果携带 `origin: system | agent`。内容属于数据，接收它的 Agent 不应将事件正文当成新的工具授权或系统指令。

| 字段 | 约束与用途 |
|---|---|
| `type` | 100 字符内，点分的业务类型 |
| `severity` | `info`、`important`、`critical`，默认 `info` |
| `title` | 必填，最多 120 字符 |
| `body` | 必填，最多 3,000 字符；首版发送纯文本摘要 |
| `object_ref` | 可选，只允许 `kind` 与 `id`，方便回查 |
| `occurred_at` | 可选，含时区的实际发生时间；省略时使用首次入库时间 |
| `notify` | 默认 false；true 还需 `notify:write` 且本机飞书通道已配置 |

同一凭证、同一幂等键、同一内容重复提交会返回同一事件，首次为 201，重试为 200。更改内容却复用键返回 409。省略发生时间的重试不会因服务器当前时间变化而产生冲突。跨 Agent 凭证不会共享幂等键；换 Agent 时需核对是否已发布，不能依靠相同文字自动去重。

如果 `notify=true` 而飞书通道关闭或 CLI 不可执行，返回 409，事件和投递均不入库。需要先保存内容时使用 `notify=false`。现有事件不会因重复提交而新增投递；后续新通知使用新的业务事件键。

### 6.2 游标读取与恢复

`GET /events?after=0&limit=50` 返回 `items`、`next_cursor`、`has_more`。游标是十进制字符串，应原样保存，不转成 JavaScript 浮点数。

消费者处理成功后才保存 `next_cursor`；失败时保留旧游标，再次读取可能得到相同事件，应以事件 ID 去重。多个消费者分别保存游标，彼此不影响。使用 `type` 过滤时，每一种过滤条件维护独立游标；不要更换过滤条件后继续沿用旧游标。

事件入库在分配序号之前获取事务锁，避免较大序号先提交导致消费者跳过稍后才提交的小序号。该实现适用于当前个人工作台规模；并非高吞吐消息系统。

首版没有服务端消费者确认 API，也没有 WebSocket/SSE/Webhook。外部 CLI 定期拉取即可。事件当前持续保留，尚未设置自动删除策略；增加清理策略时必须明确最早可用游标与归档规则。

## 7. 自动事件与通知策略

通知偏好尚待确认，当前建议默认 `important`：重要异常与任务失败；可切换 `manual`，只发送明确发布且 `notify=true` 的内容。

| 来源 | 事件类型 | 自动通知条件 |
|---|---|---|
| 搜索规则提醒 | `search.alert` | 新提醒生命周期；包含排名下降、未观察到、Top20 变化、广告份额变化、数据覆盖问题 |
| 搜索采集 | `search.job.failed` | 任务最终 `failed` 或 `blocked`；处理中重试不发送 |
| ASIN 已形成的本地通知 | `asin.change` | 原业务已经生成可通知事件，且级别为 `important` |
| ASIN 采集 | `asin.job.failed` | 任务最终 `failed` 或 `blocked` |
| 任意 Agent 内容 | `agent.*`、`external.*` | 发送者明确选择 `notify=true`，不受自动策略过滤 |

搜索采集失败只从最终失败任务形成外部通知，避免与同一问题的 `data_failure` 提醒重复。搜索提醒在同一个生命周期内只汇集一次，持续更新 `last_seen` 不反复推送；关闭后重新形成的提醒遵循现有业务冷却规则。

首次接入时只汇集集成启用时间之后的监控事件，不批量发送历史积压。飞书关闭期间，事件仍可读取，但系统不会为这些自动事件补建投递；再次启用后只通知新汇集事件。手动排队的内容则按其已授权的投递状态继续处理。

事件汇集与投递每 10 秒运行一次，每次至多投递一条；飞书调用上限 40 秒，有队列积压时延迟增加。电脑休眠或服务关闭时停止工作，恢复后读取持久化状态。当前未实现每日摘要、资讯自动摘要通知、附件上传、互动卡片与飞书消息反向控制系统。

## 8. 飞书 CLI 适配

首版适配官方 `lark-cli im +messages-send`，身份固定为 `bot`，目标为本机配置的群 `chat_id`。命令规范和短时幂等能力参考 [官方 CLI](https://github.com/larksuite/cli) 与 [发送命令说明](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-send.md)。

配置位于本机 `.env`：

```dotenv
NORTH_FEISHU_ENABLED=0
NORTH_NOTIFY_POLICY=important
# 配置、登录并确认接收群之后再改成 1
# NORTH_FEISHU_CLI=/absolute/path/to/lark-cli
# NORTH_FEISHU_CHAT_ID=oc_实际群ID
```

实施顺序：准备 CLI → 完成飞书应用认证 → 将机器人加入指定群 → 配置绝对可执行文件路径和群 ID → 检查发送预览 → 启用通道并重启服务 → 用有明确内容与接收目标的一条消息验收。

当前机器未发现可用的飞书 CLI；本次没有安装客户端、登录账号或向任何群发消息。状态接口只能验证本机配置与可执行文件是否存在，不能把它当成飞书认证成功证明。最终联调需要真实飞书配置。

实现使用固定参数数组启动子进程，`shell:false`。外部 API 不能修改可执行路径、接收群、身份或附加参数。消息按纯文本处理，附带事件编号、实际发生时间与对象引用。首版不发送本地文件、截图或整个数据库内容。

### 8.1 投递状态机

```mermaid
stateDiagram-v2
    [*] --> queued
    queued --> sending: worker 独占认领
    sending --> sent: 成功 JSON 与消息 ID
    sending --> failed: 明确未启动 / 配置无效
    sending --> uncertain: 超时 / 异常输出 / 进程中断
    failed --> queued: 明确重试
    uncertain --> sent: 核实已送达并填写消息 ID
    uncertain --> queued: 核实未送达
    uncertain --> cancelled: 取消
    queued --> cancelled: 取消
    failed --> cancelled: 取消
```

投递目标在入队时固定；更改 `.env` 接收群不会把旧队列悄悄发到新群。目标变化的投递会标记 `DESTINATION_CHANGED`，应取消旧投递并明确重新发布。

只有 CLI 返回退出码 0、`ok:true` 与消息 ID 时才记为 `sent`。超时、非标准输出、需要 CLI 确认或不能确定是否送达的结果进入 `uncertain`。进程中断后租约过期的 `sending` 同样进入 `uncertain`。普通重试接口不接受该状态，需先核查。

投递 ID 同时用作飞书幂等键，但飞书的去重时间有限。系统不宣称跨任意时长“严格只发一次”，也不会无限自动重试。原始 CLI 输出和认证材料不写入数据库，只保存受控错误代码与消息 ID。

## 9. CLI 与 Agent 交接

入口为 `bin/north.mjs`，支持 `npm run north -- ...`，不需要全局安装。可从任意目录使用绝对路径调用。默认凭证配置为项目内 `.runtime/integrations/north.json`；也可通过 `--config` 或 `NORTH_CONFIG` 指定自己的配置。

CLI 提供高频快捷命令和通用 `request`，因此新增业务路由时不必为每个端点编写专用命令。标准输出为 JSON；错误输出到 stderr 并退出 1；文件输出显式指定路径，避免覆盖已有文件。HTTP 写请求不会自动重试。

给下一个 Agent 的最小交接材料为：

1. [Agent 接入手册](AGENT_API.md)。
2. API 地址、分配给它的凭证文件路径和权限范围。
3. 当前任务目标及业务对象 ID。
4. 如果是事件消费者，提供其已成功处理的游标。

不需要依赖当前聊天上下文、当前模型或浏览器会话。

## 10. 数据表、代码位置与运行维护

| 资产 | 职责 |
|---|---|
| `north_api_tokens` | 凭证摘要、权限、有效期、撤销状态 |
| `north_api_audit` | API 调用追溯 |
| `north_integration_state` | 首次启用时间、worker 心跳与错误 |
| `north_events` | 不可变事件正文、来源键与内容摘要 |
| `north_deliveries` | 接收目标、投递状态、租约、尝试次数、消息 ID |
| `lib/external/contract.mjs` | 精确路由、权限清单、OpenAPI 生成 |
| `lib/external/schemas.mjs` | 请求字段说明 |
| `lib/external/api.mjs` | 对外网关、查询和处理接口 |
| `lib/external/events.mjs` | 事件去重与业务事件汇集 |
| `lib/external/feishu.mjs` | 飞书命令适配与结果判断 |
| `lib/external/worker.mjs` | 事件与投递后台处理 |
| `bin/north.mjs` | CLI |

新增表由服务启动时幂等创建，既有业务表无需迁移。数据库备份保存在 `.runtime/before-external-api.dump`，修改前入口文件备份位于 `.runtime/before-external-api/`。凭证、日志与运行状态均位于已忽略的 `.runtime/`。

验证命令为 `npm test`，需要本地服务运行。新增专项覆盖认证与撤销、模块权限、路由限制、业务校验一致性、文件导出、并发幂等、游标提交顺序、提醒去重、独占投递、发送预览无副作用、结果不确定处理及命令参数安全。测试只使用模拟飞书传输，真实发送验收单独执行。

## 11. 后续扩展顺序

1. 确认本机发送或外部飞书 Agent 拉取模式，完成一条真实通知联调。
2. 根据实际使用选择日报、规则订阅、静默时段与通知频率；当前规则不自动扩展到每日摘要。
3. 如需公网接入，部署仅开放 v1 的 HTTPS 网关，并补充集中限流与运行监测。
4. 如事件规模扩大，再增加服务端消费者检查点、保留期和归档；如确需飞书反向指令，再单独设计身份映射与写操作授权。
