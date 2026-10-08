# Agent Note: 运行活动图标的归属

Status: implemented

[English](2026-10-08-running-activity-glyph.md) | 中文

## Problem

部署需要自己的运行图标，同时保留 Chat 分组、活动计时和状态播报的原生归属。只为修改图标而替换整个活动组件，会复制无关行为。

## Decision

[Chat 插件](../../../../packages/client/ui-chat/README.zh.md#grouped-rendering)拥有运行活动，并声明 Session 作用域下的嵌套 single Slot `conversation.chat.activity.icon`。其 owner 携带当前轮次的开始时间或 null。随包提供的贡献渲染原生鲸鱼，其他贡献仅替换这个装饰图标。移除该贡献会恢复原生贡献。

原生活动保留文字、计时间隔、布局和无障碍状态。图标不获得执行权限，也不创建 Conversation 节点。过程分组标题和 transcript 渲染器保持原样。

## Alternatives considered

**替换活动组件。** 现有外层 Slot 仍适用于整体活动展示重设计，但修改图标不需要复制其时钟和无障碍行为。

**覆盖内部 CSS 或资源文件。** 这些方式使部署依赖私有选择器或包文件，不能通过公开注册表表达有生命周期归属的替换。

## Consequences

部署可使用原生 timeline 渲染并保留自己的图标。该 Slot 只负责装饰，本地化运行状态和已用时间仍由原生组件拥有。注册替换与释放测试保留同一个已挂载状态行，时钟测试覆盖图标变化及计时间隔清理。
