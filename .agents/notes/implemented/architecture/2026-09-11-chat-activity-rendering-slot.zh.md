# Agent Note: Chat activity rendering slot

Status: implemented

[English](2026-09-11-chat-activity-rendering-slot.md) | 中文

## Problem

产品需要自己的运行指示器，同时保留原生 Chat 对轮次计时、流式和生命周期的所有权。

## Decision

Session 作用域的 `conversation.chat.activity` 槽接收运行轮次的开始时间。原生 Chat 默认提供现有运行状态渲染器，Product 注册只替换该渲染器；原生视图决定其显示和消失。完成后的过程展开仍是独立的原生 Chat 节点。

## Alternatives considered

复制 ChatView 会重复流式与分页逻辑。改写 DOM 会破坏 React 所有权。选择散列私有类名会让 Product 行为依赖构建输出。

## Consequences

默认界面保留原有标签和计时行为。产品可以增加无障碍状态指示器，而不创建另一套执行状态投影。
