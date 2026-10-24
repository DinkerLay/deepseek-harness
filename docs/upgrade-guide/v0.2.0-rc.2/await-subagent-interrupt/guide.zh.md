---
kind: upgrade-guide
description: "直接 Host 调用 interruptByParent 现在返回异步确认。"
---

# 等待直接子会话 UI 中断

[English](guide.md) | 中文

## 变更

`SubagentRuntime.interruptByParent()` 返回 `Promise<SubagentInterruptReceipt>`，使可选认证 Host 所有者能在取消之前持久化停止。这影响直接 TypeScript 调用方。浏览器 Remote 客户端已经等待结果；端点、参数和 `{ accepted: true }` 线上返回不变。模型或祖先的 `interrupt()` 仍同步执行。

## 迁移

1. 读取回执前等待直接 `interruptByParent()` 调用，并捕获 Promise 拒绝而非同步异常。
2. 使用新的 `@deepseek-ai/dsh-subagent` 声明重新构建插件。成功调用解析为 `{ accepted: true }`，不保证取消已经达到静止状态。
