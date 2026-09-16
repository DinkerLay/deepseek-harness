# Agent Note: 部署身份配置

Status: implemented

[English](2026-09-16-deployment-identity-controls.md) | 中文

## 问题

下游产品需要自己的指令路径标签、MCP 客户端身份和 Shell 环境信息，同时保留 Harness 存储身份并复用服务实现。

## 决策

指令加载器接受 `userGlobalDisplayPath`，发现阶段为全局文件保留明确的逻辑目录。基线状态与后续协调继续使用既有 `user-global` 作用域。显示配置参与基线身份，恢复的会话通过正常记录的上下文更新替换过期标签。

MCP 客户端的两种传输与每次重连均接受 `clientInfo`，省略时保留 Harness 客户端身份。Shell 环境注册表接受默认值为 true 的 `includeBuiltins`；关闭时仅省略注册表内置变量。显式贡献方保留所有权和释放行为。Shell 工具说明不指定部署命名空间。

[统一 Home 解析器](../architecture/2026-07-24-single-harness-home-resolver.zh.md)和 [MCP 客户端设计](2026-07-07-mcp-client-plugin.zh.md)继续分别约束路径解析与传输生命周期。产品通过配置及既有环境贡献机制选择品牌。

## 考虑过的替代方案

全局重命名包、环境常量或 Home 解析器会改变无关消费者与历史身份。独立品牌服务会为三个可分别配置的消费者增加跨包依赖。当前部署需求均不需要这些方案。

## 后果

默认行为保持兼容，不引入 Session 格式或持久作用域键迁移。测试覆盖自定义全局标签、稳定作用域身份、关闭内置变量、贡献方释放和重连时的 MCP 自定义身份。
