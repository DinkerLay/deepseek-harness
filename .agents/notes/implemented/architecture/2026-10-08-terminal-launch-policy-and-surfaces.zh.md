# Agent Note: Terminal launch policy and independent surfaces

Status: implemented

[English](2026-10-08-terminal-launch-policy-and-surfaces.md) | 中文

## Problem

部署可能需要在用户终端启动时准备工作区、限制进程权限或持有外部 writer 租约。为这些规则重写终端身份和输出传输，会重复原生屏幕与连接生命周期。多个 UI 界面也需要互不覆盖的窗口保留列表和可释放的视图实例。

## Decision

TerminalController 在选择 Shell 后、分配时调用可选的 `terminalSpawnPolicy(agent, request, spec)`。策略返回 subprocess handle 与实际 cwd；原生控制器继续负责身份、创建去重、限制、输入附着归属、屏幕序列化和清理。`terminalSpawnPolicyVersion: 1` 标识该接口。默认原生行为仍是无限制的用户 Shell；部署设置 `requireSpawnPolicy: true` 后，策略缺失则拒绝创建。

策略负责其 handle 对应的外部资源，仅在完整进程范围清理成功后释放。分配失败必须释放已取得的资源，清理失败允许重试。准备过程的 signal 负责取消分配；策略不替换原生写入、调整尺寸、follow 或关闭语义。

Client 的 `terminalSurfaceVersion: 1` 增加 `retainTabsFor(surface, tabs)` 与 `releaseView(sessionId, key)`。不同界面的保留列表合并，既有 `retainTabs` 调用负责 Sidebar 那一份。释放视图只销毁其流，不关闭 Host 进程，也不删除内容绑定；显式关闭仍是关闭进程的依据。

## Alternatives considered

**维护另一套部署终端服务。** 仅改变启动策略就必须重复进程身份、快照顺序、背压与重连处理。

**所有原生用户终端都应用 Agent 沙箱。** 现有人类 Shell 约定是有意设计，部署策略应当显式、可选。

**共用一个可被替换的窗口保留列表。** 第二个界面可能意外释放第一个界面的终端；具名贡献保持各自归属。

## Consequences

策略提供方须正确管理取消、启动失败和可重试清理。测试覆盖可选／默认行为、必需策略缺失拒绝、幂等创建、资源清理、独立保留列表和不结束进程的视图释放。Session 事件与终端 Remote 协议保持不变。
