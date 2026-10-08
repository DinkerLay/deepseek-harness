# Agent Note: 原生静态活动与同行轮次摘要

Status: implemented

[English](2026-10-09-native-chat-turn-presentation.md) | 中文

## Problem

部署需要静态运行状态和紧凑完成摘要，同时保留原生分组、排序、展开及历史。失败和停止也需要已记录耗时；只显示失败标签会隐藏可用的时间证据。

## Decision

[Chat](../../../../packages/client/ui-chat/README.zh.md#grouped-rendering)拥有两项展示选项。`quietActivity` 显示静态运行文字与已用时间，不挂载图标或动画 Chat 标题。`inlineCompletedSummary` 将原生分组控件放到原生已结束轮次行。两者默认为 false，部署可通过 Host 偏好或公开注入展示策略选择。`turnPresentationVersion` 标识完整 Client 契约。

分组控件仍属于原生 React 容器，并渲染到当前视图的 DOM outlet。多个分组共享一份类别文字，各自控件保留来源顺序和展开状态。折叠轮次外的控件会先展开轮次，再打开分组。Outlet 只保存 DOM 目标，不建立第二套 Conversation 或展开 Store。历史更新和工作详情模式变化保留现有容器。

所有结束状态使用已记录的起止边界。边界缺失时省略时间，不用当前时钟估算不完整历史。运行时钟刷新保留单一稳定的状态播报。

## Alternatives considered

**替换 Chat View 或分组状态。** 为小范围布局选择把无关执行展示和回放行为转移给部署。

**渲染后移动 DOM 节点。** 绕过 React 归属，增加迟到历史更新的复杂度，并把控件与原生订阅分离。

**在状态行重复每份分组文字。** 长轮次会重复标签并挤满窄框。一份文字配合独立原生控件可保留信息和操作。

## Consequences

原生 Session 事件和模型请求保持原样。静态选项不激活自定义图标贡献。已知失败和停止时间可见，未知时间保持缺失。聚焦测试覆盖多分组、中间叙述、历史更新、模式变化、折叠轮次展开及计时清理。
