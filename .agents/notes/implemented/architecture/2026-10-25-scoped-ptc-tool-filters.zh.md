# Agent Note: 作用域 PTC 工具筛选

Status: implemented

[English](2026-10-25-scoped-ptc-tool-filters.md) | 中文

## Problem

消费方可以保留原生工具，同时向程序开放较小集合。限制整个 agent 工具视图会移除合法的原生能力；只在生成 SDK 文本中隐藏名称，则内部执行仍宽于公开接口。

## Decision

`tools.presentAs(mode, { ptcFilter })` 拥有随 effect 释放的作用域筛选器。SDK 生成、绑定枚举和活跃 PTC 父 token 下的执行，共用可见工具与继承筛选器的交集。原生调用和其他组合传输保留原有工具视图。子作用域不能扩大父筛选器；释放父声明会移除该父贡献。

显式 PTC 子集为空时隐藏传输且不要求后端。未筛选组合保留纯计算传输。掩码不包含产品词汇，不改变 Session 事件或持久化类型。

[作用域解析器](2026-07-12-agent-scope-runtime-design.zh.md)与[执行器塌缩](../bug-fix/2026-08-07-ptc-executor-collapse.zh.md)保留原有所有权。[PTC 基础](../feature/2026-06-15-ptc.zh.md)继续有效；本决策增加单独的 PTC 子集，不取代原有呈现与结算规则。

## Alternatives considered

agent 级限制也会移除原生工具。只限制呈现留下执行绕过。把 PTC 掩码用于所有内部调用会改变其他组合传输，因此注册表跟踪活跃 PTC 父 token，直到桥接完成排空。

## Consequences

消费方在注册表之外声明资格与策略。注册、输出合同、调度、守卫和结算继续共享。测试覆盖 SDK/绑定一致性、原生调用、未知/保留声明、空子集、继承限制、释放和内部调用绕过。下游通过已有 pin 流程采用经过评审的 fork。
