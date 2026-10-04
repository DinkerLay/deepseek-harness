# 维护 SuperCode 内核 fork

[English](FORK.md) | 中文

本 fork 使用官方 [`dsh-v0.2.0-rc.2`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.0-rc.2)。Runtime 包版本仍为 `0.2.0-rc.2`；fork 提交和内容寻址产物标识修改后的字节。[fork-manifest.json](fork-manifest.json)拥有精确的基础提交，以及新增和修改的 Runtime 包清单。

## 能力归属

官方 DSH 拥有原生 V4 历史、Agent 执行、continuation、工具、提供方、投影、transport 与持久化。本 fork 增加公开的创建与删除 reservation、有效执行目录、可恢复 fork 目标、标题策略与生成状态、可等待的提示词准备、部署访问约束、可信执行环境、准入策略、作用域父级投递和有界 DNS 恢复。Product 策略与业务行为仍由外部插件提供。

公开浏览器库可加载而不激活默认插件。Conversation builder decorator 转发分组与发布；Chat 展示可将被替换轮次排除在逻辑导航与统计之外。Markdown 本地链接保持调用方解析。管理通道保持经过身份验证的回环权限。浏览器 index 认证错误接受部署自有纯文本指引，保留状态、响应头与令牌交换。模型目录区分已注册执行提供方和存在可用模型的提供方。

Subagent Sidebar 注册声明全部嵌套资源依赖，公开 Client 入口暴露只读资源类型及相应 Slot、协议和保持来源声明。下游呈现复用原生保持、恢复和释放。

PiAi bridge 通过 pi-ai transcript system 消息承载增量 developer Tool 变化。路由能力显式声明并绑定准备好的模型快照；不支持的路由使用原生 DSH 兼容投影。启用提供方专用协议支持前，必须取得真实传输证据。

Workspace Project 清单保持共享，部署可选择独立归档/置顶元数据域。所选单元初始为空，保留旧共享 Session 数组，并记录可恢复跨单元变更。原生 Workspace 流投影所选元数据及当前通过 Header 校验的成员关系。

Conversation 消费者可围绕规范 Session 绑定注册由 Effect 管理的 UI 事件源适配器。适配器保留来源身份和单调修订，不克隆绑定、不改变原生传输，也不改变持久或模型可见历史。

## 原生 V4 范围

下游发布使用独立 V4 Session generation，不导入或恢复升级前 Session 数据。旧文件与自有目录保留在活动分配和删除范围之外。本 fork 不保留自定义旧 reader、迁移坐标 API、SQLite Session 转换或 feedback 伴随记录导入。原生 V4 codec 与投影理解 required 执行目录和标题事件。

## 开发与绑定

在独立 fork 检出中修改和测试。保留官方基线祖先关系，导出完整 Runtime 差异，再发布已审阅 fork 提交供下游采用。下游以只读 Submodule 绑定该提交，安装官方包与对应 fork tarball，并原子更新依赖 family、UI 组合与声明快照。保持哪些行为不由包数量目标决定。

## 验证

focused source 测试覆盖创建与删除竞态、原生 V4 持久化、精确 fork 截点与目标、目录消费方、标题状态、策略 dispose、作用域执行和浏览器库激活。原生系统锁已构建并实际使用。PiAi 请求测试检查本地 Responses 与 Completions 的实际 payload，不代表远程网关兼容。Host 编译与 Runtime bundle 检查独立于下游 Product 验收。
