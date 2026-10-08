# Agent Note: 原生 Sidebar Session 工厂的归属

Status: implemented

[English](2026-10-09-native-sidebar-session-factory.md) | 中文

## Problem

部署可在 frame 中放置多个 Session 侧栏，同时保留原生停靠、导航与资源。通过拦截原生插件注册来提取组件和 Store，会使部署依赖私有装配细节。

## Decision

[Sidebar](../../../../packages/client/ui-sidebar-right/README.zh.md#extension-seats)暴露 `applyWithSessionFactory` 和 `sidebarSessionFactoryVersion`。该函数保留原生控制器、持久化、资源保持、焦点、引导页类型及 Session 生命周期。它使用默认或部署自有工厂名注册原生 Session 组件、子 Slot 与 Store，并返回同一 handle。

部署提供 `sessionProvider(renderFactorySlot)`。工厂根没有声明随包 Session 子 Slot，因此框架不会自动为它生成该边界。要求实际经过授权的 provider，能保留共享 Session 绑定而不声明空占位。普通 `apply` 保留随包装配。

工厂元数据依据原生声明检查。自定义字符串名称通过公开注册表的 Runtime 注册边界发布，部署拥有其对应声明。不引入私有注册表或第二套 Dock Store。

## Alternatives considered

**拦截原生注册。** 只能通过识别实现特定的注册调用取得组件和 handle。

**复制 Dock 或发布通用注册表。** 选择一个原生装配边界不需要这些，两者都会扩大生命周期归属。

**为工厂根伪造默认 provider。** 缺少 Session 边界属于授权和绑定错误。部署提供实际使用的 provider。

## Consequences

自定义 frame 和独立 pane 可复用原生 tab 与资源行为，不替换控制器。工厂名可保留部署自有身份。测试通过自定义 Session 边界挂载真实生产工厂，覆盖共享 Store 身份、后台保持、Session 切换和关闭清理。
