# Agent Note: Conversation builder decorators

Status: implemented

[English](2026-09-10-conversation-builder-decorators.md) | 中文

## Problem

下游聊天展示可能需要隐藏被替代的尝试，同时避免复制原生 Chat 投影或修改已渲染的 DOM。

## Decision

Conversation View Registry 提供由效果作用域管理的构建器装饰器，以目标及唯一注册 ID 定位。每个 Session 独立实例化包装；注册及撤回会重建活动目标。原有定义、节点身份、持久化与执行仍由原来的模块负责。

装饰后的 Chat 快照可以通过 `excludedTurns` 声明仅用于展示的轮次移除。即使完整日志大纲仍包含这些轮次，原生导航条也不会重新显示它们。轮次数量反映可见选择，已执行步骤和 token 统计保持不变。

## Alternatives considered

替换原生 Chat 目标会复制其投影和分页行为。修改 DOM 会破坏渲染器所有权。仅负责展示的策略不需要这两种方式。

## Consequences

下游策略可以在保留增量更新的同时改变原生节点可见性。注册表测试覆盖稍后注册的目标、独立构建器、稳定条目、重复 ID 和释放。
