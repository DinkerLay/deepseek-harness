# Agent Note: Submodule 启动与历史恢复

Status: implemented

[English](2026-09-10-submodule-startup-and-restored-history.md) | 中文

## Problem

标准 Submodule 会把 `core.worktree` 放在公共 Git 配置中，原 hook 安装器拒绝这种布局。另外，Session Query 把继续对话后的 fork 当作新的构造种子校验，但种子不能包含其后续本地事件。不支持的历史正文还会阻止可读的头信息出现在目录列表中。

## Decision

启用 worktree 配置时，安装器将已有工作目录设置移动到主 worktree 配置，保留精确值并在失败时回滚。正常 hook 安装继续启用。临时 Git 测试覆盖普通、关联 worktree 和关联父项目中的 Submodule。

Session Query 对独立持有的完整日志使用原生 `Session.fromRestore`，保留父子关系、继承数量和本地事件。目录发现仅在明确的历史格式不支持错误下，回退到可读头信息中的创建目录；直接历史读取、一般 I/O 错误和冲突头信息仍正常报错，回退结果按版本缓存。

Connection RPC 注册通过自有注入作用域取得可选的 Web server。通道名同步预留，HTTP 路由随服务器可用性挂载；调用方释放时同时回收通道名与路由。消费者只需依赖 Connection 服务。

## Alternatives considered

**关闭安装脚本。** 这会掩盖不支持的 Git 布局，同时跳过其他必需准备。

**修改 fork 头信息或截断历史。** 这只是通过丢失父子关系或本地事件来隐藏构造错误。

**接受不支持的历史。** 可读列表不代表正文可用；原数据保持不变，直接读取仍会拒绝。

## Consequences

Submodule 依赖安装可以正常执行脚本；继续对话后的活跃及持久化 fork 能正常读取，同时保持创建校验。不支持的旧 Session 不再阻断其他 Session 的列表，但打开其历史仍要求格式受支持。针对性的安装器和 Session Query 测试覆盖这些行为。
