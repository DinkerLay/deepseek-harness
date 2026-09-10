# Agent Note: Retained memory and workspace interactions

Status: implemented

[English](2026-09-10-retained-memory-and-workspace-interactions.md) | 中文

## Problem

已发布的 Product Session 包含版本化的记忆与重试来源信息。冻结的源格式校验会拒绝这些普通对话。工作区消费者还需要明确的 Markdown 文件导航与终端尺寸调整，而无需替换原生渲染和子进程所有权。

## Decision

相邻迁移只接受已发布的本机记忆快照描述和第一版用户重试描述。记忆内容、消息标识和来源代际保持完整。本地重试端点跟随各阶段的坐标映射；对另一 Session 的捕获保持不变。未知描述版本和无关来源字段仍然失败。持久化保留前代文件，仅在校验通过后发布后继代际。

Markdown 调用方可以提供文件链接解析器。获准的目标渲染为回调按钮；普通链接保留 URL 校验，没有解析器就不提供本地文件导航。子进程终端句柄在本地 node-pty 和 E2B 提供方中均暴露尺寸调整。E2B 将尺寸调整纳入在途操作跟踪，使终止等待操作完全结束。

## Alternatives considered

**丢弃来源信息**会丢失重试标识和记忆撤销信息。**允许任意来源字段**会掩盖不支持的协议。**重写 DOM**与 React 所有权冲突。**只调整终端模拟器尺寸**会让 Shell 继续按旧尺寸换行。

## Consequences

Fork 保留范围明确的已发布数据兼容差异和两项可复用的 UI/进程能力。Product 仍负责文件授权、图标设计、面板位置和重试展示。这些改动不会启用实验编排，也不会重写前代数据。
