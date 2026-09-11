# 维护 fork 差异

[English](FORK.md) | 中文

此分支是 SuperCode 使用的 DSH Runtime fork，基于官方 `dsh-v0.1.5-rc.2`，对应提交 `fb2c4b9e698e30edb738bca4cf0618587db7d203`。本候选中的所有 Runtime package（包括 fork 专有 package）版本均为 `0.1.5-rc.2`。

[`fork-manifest.json`](fork-manifest.json) 是相对该官方提交存在生产源码或 package manifest 差异的机器可读 package 清单。其 `runtimePatchPackages` 数组是下游 Runtime 必须整体安装的精确覆盖集合。

## Package 与 bundle 清单

此 fork 不新增 DSH bundle，也不修改 `packages/bundle/` 下的 package。Product 组合位于本仓库之外。

它新增两个通用 DSH package：

| Package | 职责 |
|---|---|
| [`@deepseek-ai/dsh-session-deletion`](packages/session/session-deletion/README.zh.md) | 仅供 Host 使用，在 live 状态、持久化、projection、索引、workspace 与已注册派生状态中递归删除 Session 家族。 |
| [`@deepseek-ai/dsh-shell-exec-env`](packages/shell/shell-exec-env/README.zh.md) | 可选可信环境 registry，在创建 Bash 或 PowerShell 进程前立即收集。 |

Manifest 包含 50 个修改 package 和这 2 个新增 package。生成文档、测试、翻译记录、仓库脚本与构建输出属于受审查的 Git 差异，但不是 Runtime package 覆盖。

## 原生基础

Fork 以官方 0.1.5 机制作为各自领域的权威：

| 领域 | 原生机制 |
|---|---|
| Session 恢复 | 第三版日志、`SessionFormatRestore`、迁移坐标、持久化 handle 与发布检查。 |
| Agent 生命周期 | 异步 `ctx.agents.create`、继承前缀、原生 Activation 所有权与原生 continuation 调度。 |
| Session 发现 | `SessionQuery`、live 与 cold Session 记录、SQLite 索引和原生 API workspace-file 服务。 |
| 浏览器模块 | 公共 Client module registry 与生成的 Remote 产物。只有组合声明 `libraryPackages` 时才加载 library 导出；声明 library 不会激活其默认插件。 |
| 网络路由 | 原生出站代理选择与 dispatcher。DNS fallback 对自身 HTTPS resolver 请求独立应用同一策略。 |

此分支通过公共 package API 扩展这些机制，不会在 adapter 中复制其内部实现。

## 保留的通用能力

Fork 仅保留官方版本尚未提供的可复用 Runtime 能力：

- Session 删除会预留 live 所有权，发现完整后代家族，删除 provider 记录，并在持久化提交后使派生状态失效。
- 记录式执行目录保留 `SessionHeader.cwd` 作为不可变创建与存储身份。公共解析器和查询记录向文件、hook、skill、LSP、subagent、workspace-file、摘要与 open-in-app 消费方提供有效目录。
- 精确可恢复 fork 保留请求的目标。Subagent continuation 使用原生生命周期所有权，同时保留逐消息父 Turn 归属与部署方控制的静默父会话投递。
- Gateway 调用策略与逐通道 loopback 权限提供通用准入边界。Client 公共 library 只有在组合显式声明时才加载。
- Sandbox policy 对解析后的执行策略施加部署访问上限。Bash 与 PowerShell 可选地收集模型可见工具输入之外的可信环境值。
- 历史 Session 恢复会保留允许的 delegation 字段与精确迁移坐标。坐标的 source revision 使用跨副本稳定的前代内容身份。JSONL exporter 可读取已发布的 SQLite Session 而不修改源数据库，并且只在新 artifact 中重建可证明的 rc2 chunk provenance。
- 消息反馈把新修改写入权威 Session 事件，并通过严格、有界、只读的兼容层读取已发布的零版本 sidecar 行。权威 put 与 delete 优先，重启后亦如此。[sidecar 透读决策](.agents/notes/implemented/bug-fix/2026-09-10-message-feedback-sidecar-read-through.zh.md)归属该合同。
- DIRECT HTTP fetch 可在 DNS 返回保留 Fake-IP 时通过已配置的 HTTPS DNS 恢复。Resolver 流量遵循原生路由策略；直接解析使用固定的公共 bootstrap，代理解析使用原生 dispatcher，源站连接只接受经过校验的公共地址。
- Session 自动标题保留分支所有权与持久化生成状态，LLM 标题 provider 保留精确摘录与 token 上限。

[执行目录决策](.agents/notes/implemented/architecture/2026-09-07-session-execution-directory.zh.md)归属物理目录合同。其他保留合同由各 package 参考与活跃 Agent Note 链接。

## 所有权边界

此 fork 包含通用 DSH 能力与公共扩展点，不包含 SuperCode UI、鉴权、Product 策略、Product bundle 或 `@ainvest-team/*` import。外部 Product 插件消费已发布 DSH API；DSH 不导入它们。

SuperCode 检出的 Submodule 是只读的。应在独立 fork checkout 中开发 DSH 改动并运行检查，发布通过审查的 fork 提交后，再同时移动 SuperCode 的 Submodule 绑定、Runtime 覆盖列表、package 版本与架构记录。

## 更新 fork

1. 有意识地移动官方基线，并将候选与精确官方提交比较。
2. 将每项保留能力与新的原生实现核对。原生行为满足完整合同时，删除对应 fork 差异。
3. 根据生产 `src/**` 与 `package.json` 差异重新计算 `fork-manifest.json`。`runtimePatchPackages` 是新增和修改 Runtime package 的排序并集。
4. 保持 package 参考、子系统参考、中英文 Agent Note、测试与生成目录和生产源码一致。
5. 接受 fork 提交前，要求下游 Runtime 覆盖集合与 manifest 一致。

Git 是完整的文件级记录。Manifest 对下游组装中必须保持原子性的 Runtime package 进行分类。
