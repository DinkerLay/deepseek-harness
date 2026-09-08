# Agent Note: 记录 Session 执行目录

Status: implemented

[English](2026-09-07-session-execution-directory.md) | 中文

## Problem

Host 可以保留同一段对话，同时将执行转移到托管目录。创建 cwd 也标识持久化日志，改写 header 会移动历史或与既有身份冲突。若只让文件修改使用另一个根目录，读取、搜索、Shell 和指令仍会访问其他文件树。

## Decision

必须识别的仅日志事件 `session/execution-directory` 记录绝对物理 cwd 及其所属 Session ID。`Session.executionDirectory` 增量折叠自身绑定，`resolveSessionCwd()` 回退到不可变的创建 cwd；`executionDirectoryFromEvents()` 解析脱离实例和历史前缀。fork 种子中的绑定仍属于原 Session，子会话初始目录由明确的 fork 目标或选定前缀决定。

文件和搜索工具、Shell 及持久 Shell 创建、LSP、Skill、指令、文件引用、Hook 进程和外部子代理的目录继承都使用该解析值。沙箱在施加限制前规范化实际目录，因此 Host 绑定提供执行边界，限制只能进一步收窄。持久化位置、Session 身份、分组和谱系继续使用创建元数据。

受信任 Host 负责目录分配、活跃使用者协调、输入版本选择和清理，启动文件效果前追加并刷写绑定。既有进程在停止前保持已捕获目录，本能力不会迁移正在运行的 Shell。工具的工作区相对路径随绑定变化，明确路径继续遵循各工具原有的路径和沙箱规则。目录变化时重建文件引用缓存。

这扩展了[逐 Session 文件系统解析](2026-07-02-fs-per-session-cwd.zh.md)，保留调用方拥有路径解析、Provider 独立以及规范文件系统身份的规则，不向 DSH 引入 Git 或 Product 策略。公共用法由 [Session 契约](../../../../packages/core/session/README.zh.md)负责。

## Alternatives considered

**改写 SessionHeader.cwd。** 持久化日志位置和不可变创建身份将随执行变化，回放和相同 ID 核验会产生分歧。

**只改某个工具的写入路径。** 读取、搜索、Shell、指令和权限限制会解析不同文件树。

**只维护内存目录表。** 重启会在缺少持久绑定证据的情况下恢复到另一个执行目录。

**采用全部继承目录事件。** fork 的历史会用父会话执行绑定覆盖子会话选定目录。

## Consequences

该绑定属于读取时必须理解的事件类型，不认识它的构建无法安全重建执行。Session 校验持久化格式和实时追加的所属身份。Host 必须保留被引用资源并协调活跃工作与目录切换；通用事件不创建目录，也不授权 Git 清理，还不会映射远端文件系统命名空间或改写任意绝对路径。

模型上下文通过普通的持久化提示和上下文组装派生当前 cwd 及沙箱策略，工具参数和结果保持原有输出格式。包含 cwd 的提示变化会改变缓存前缀，每次实际绑定变化只增加一条较小持久化事件。

核心测试覆盖恢复、自身 Session 归属、无效路径和提交后观察。真实文件系统与 AgentLoop Shell 测试验证读写一致且共享文件不变。[文件系统回归](../../../../packages/fs/tool-fs/tests/integration.spec.ts)验证一个 Session 读取共享输入，再在记录的执行目录编辑并恢复。profile 级快照覆盖由版本集成计划跟踪。
