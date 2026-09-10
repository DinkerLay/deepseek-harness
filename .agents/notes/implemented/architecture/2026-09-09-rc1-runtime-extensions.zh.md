# Agent Note: 官方 rc1 上的运行时扩展

Status: implemented

[English](2026-09-09-rc1-runtime-extensions.md) | 中文

## 问题

审阅过的 Product 运行时需要永久删除、精确 fork 位置、记录的执行目录、限定范围的策略和分支命名，同时采用 rc1 的 Session 元数据、控制器和 Subagent 消息。旧的异步观测不能在其源生命周期被删除后继续发布分支或缓存行。上游移除 SQLite 提供方后，历史日志也需要可执行的转换路径。

## 决策

fork 使用官方 `dsh-v0.1.5-rc.1`，提交为 `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`。[维护指南](../../../../FORK.md)和 [manifest](../../../../fork-manifest.json)绑定完整差异。[删除决策](2026-08-20-dsh-session-deletion-plugin.zh.md)、[可信环境决策](2026-08-31-trusted-shell-execution-environment.zh.md)、[执行目录决策](2026-09-07-session-execution-directory.zh.md)以及[资源准备/归属决策](2026-09-07-session-provisioning-and-delivery-attribution.zh.md)继续规定各自独立的行为与归属。

`SessionStorageMetadata` 在 Header 之外携带精确继承截断位置。后端删除返回这些坐标；公开持久化服务仍返回被移除的 Header，并在提交后事件中附带截断位置。投影缓存等待写入结束并保留已删除生命周期标识，使延迟的冷观测无法重新创建同一检查点。同一 id 被不同生命周期元数据复用时保持独立。

`SessionStore.capturePublicationCheck()` 在异步观测前捕获源的删除代次。控制器的精确 fork 将该检查与调用方 setup 一起组合到官方 Agent setup 提交中；已完成删除的预留即使释放，也不会让旧源重新有效。预留目的地核对精确前缀、preset 和创建目录。控制器拥有公开 fork 端点与移除通知；不再存在 APIProxy。

官方 `send_message` 路径拥有相邻 Agent 投递。fork 增加逐消息的父轮次归属，以及由 effect 拥有的父投递限制。安静投递保留内容但不唤醒，不屏蔽内容，也不恢复已移除的 report 工具。标题输入和生成投影携带继承截断位置，使分支排除继承的输入及尝试状态，同时让继承标题保持临时作用。

JSONL 包公开的 `./legacy-sqlite` 辅助模块创建一致的只读备份，并在独立进程中让记录的 rc2 fork Runtime 只打开该副本。旧读取器和 JSONL writer 使用公开 package API，输出可移植的未压缩 V0 JSONL。当 rc2 最终 Assistant 消息紧跟一个精确、连续、属于同一 Turn 与 step 的 chunk attempt 时，export 会在新 artifact 中补充缺失的 `sourceEventSeqs`。它校验最终模型来源、组装内容、usage 与 replay state，并拒绝 gap、跨 step chunk 或冲突 provenance。JSONL 显式写出零 delegation depth，保留旧可选字段的含义。原始数据库逐字节不变。

`migrationCoordinates(id).source.revision` 是 `content-v1` SHA-256 身份，覆盖保留的前代字节、源格式 generation 与 Session id。逐字节相同的数据 home 副本会保留该身份，其中任一输入变化都会改变它。`stat()` 与 `list()` 保留原生 device/inode/size/time revision，target revision 仍是物理 token。已有 current 后继必须保留迁移后的前代前缀；合法的后续 V3 append 不会使映射失效。

Session Query 每个持久化 revision 与不可变 header 身份只解析一次 cold 执行目录。Corpus cache 只保留派生字符串与共享的 in-flight Promise，因此重复或并发的 `listSessions()` 调用不会回放未变化的长历史，也不会保留其事件。Session 移除、revision 变化与持久化替换会使对应观察失效。

权威 message-feedback 事件保留写入权威，服务在该事件 fold 下读取匹配的已发布零版本 sidecar 行。严格 schema、Session 身份、消息目标与条目数检查会拒绝畸形行；权威 delete 防止旧 sidecar 评分在重启后返回。[sidecar 透读决策](../bug-fix/2026-09-10-message-feedback-sidecar-read-through.zh.md)归属该兼容边界。

Gateway 调用策略将 Product 准入覆盖到完整的一元查找与操作，用来替代只读历史 Agent revision 的 APIProxy 方法替换。Connection RPC 通道来源限制仍是 rc1 浏览器认证之外的显式可选限制，使 Product 管理通道保留仅环回访问。两项能力都报告版本 1，缺失时 Product 激活失败。

Client 模块注册表提供显式配置的仅模块 factory，而不激活其默认 UI 插件。这样 Product 可以通过同一模块身份消费公开 UI 类，同时只选择一个展示与服务提供方。仅模块行保留产物来源与 HMR；普通活跃行继续按原有方式激活。Host 和 Client 两侧必须一起更新。

## 考虑过的替代方案

**让旧 APIProxy 或 Client Runtime 与控制器并存。** 多个归属方会重复状态，并要求旧协议适配器继续执行。保留的行为应归属新的公开实现。

**只按 Header 匹配缓存删除。** rc1 的日志身份还包含继承截断位置。省略它可能在 id 复用时删除或复活错误的生命周期。

**只在 fork 请求开始时检查源删除。** 等待组合完成可能跨过整个删除预留周期。捕获的代次必须在发布时检查。

**复制旧 SQLite 编解码器或保留可写运行时提供方。** 旧公开读取器已经拥有压缩 schema 及其校验。在备份上隔离执行，既保留解释方式，也不增加另一套活跃持久化归属或修改原数据库。

**对持久迁移标记使用文件系统 stat 身份。** Device、inode 与 timestamp 可以标识一次物理观测，但在逐字节相同的副本中也会变化。它们继续适合本地 `stat()` 与 `list()` snapshot；持久迁移标记需要内容身份。

## 影响

运行时保留 Product 所需扩展点，同时采用 rc1 元数据、公开控制器和消息机制。精确覆盖包由源码差异决定，不追求指定包数量。新的类型声明与公开子路径消费方必须使用匹配的 fork 产物编译，不能将 Product 实现导入 DSH。

Package 回归覆盖生命周期预留、迟到缓存写入、精确 fork、执行消费方、标题归属、parent 投递、反馈 sidecar 与跨副本稳定的迁移标记。旧 artifact 集成使用真实记录的 Runtime，检查压缩 SQLite 事件、精确重建的 chunk 坐标、源字节不变、元数据规范化、空 corpus、输出冲突、取消、恢复执行和后续 fork。该集成需要 `DSH_LEGACY_RUNTIME_ROOT`；缺少该前置条件表示跳过，不能作为兼容性通过证据。Headless 回放 corpus 要求根测试依赖声明其可选 patch package，使物化后的 profile 能解析这些 package；Python 场景需要 CPython 3.10 或更新版本。跨平台执行和 Product Web 组合仍是独立的验收证据。
