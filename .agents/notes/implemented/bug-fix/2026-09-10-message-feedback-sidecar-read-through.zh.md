# Agent Note: 消息反馈 sidecar 透读

Status: implemented

[English](2026-09-10-message-feedback-sidecar-read-through.md) | 中文

## 问题

已发布的 DSH Runtime 将逐消息评分和备注持久化到 `message_feedback` 零版本存储域。权威 Session 事件实现不包含这些记录，因此打开同一存储根目录时可能隐藏历史反馈。在启动时把记录复制到 Session 日志会修改用户历史，需要跨存储恢复机制，并且可能恢复被后续权威 delete 有意移除的反馈。

## 决策

`dsh-message-feedback` 以只读方式打开已发布的存储域，并将有效行作为当前状态折叠的初始值。随后按日志顺序应用权威 `feedback/message-put` 与 `feedback/message-delete` 事件。因此，权威值覆盖其 sidecar 值，权威 delete 在重启后仍会压制该条目。

兼容行必须与被检查 Session 的 `{createdAt, cwd}` 身份一致。其封闭 schema 拒绝未知字段、重复消息 id、重复版本、无效时间戳及格式错误的条目。每个保留的消息 id 都必须指向所属日志中已完成且来源为 append 的 assistant 消息。`maxLegacyItemsPerSession` 默认为 1000，在超大行进入服务结果之前拒绝它。

服务绝不写入、改写、删除或截断 sidecar。新的修改仍是权威 Session 事件，因此 sidecar 原始字节继续供旧 Runtime 和恢复工具使用，而 Session 日志仍是当前唯一的写入权威。

## 已考虑的替代方案

**将行导入权威事件。**自动导入会在读取或启动期间修改 Session 历史，需要持久化的跨存储完成标记，并使中断恢复成为反馈写入协议的一部分。如果导入方没有先重建两段历史，还可能在权威 delete 后追加已发布的评分。

**忽略已发布存储域。**这会使权威实现更小，但当前 Runtime 打开存储根目录时，有效评分和备注会消失。

**继续同时写入两个存储。**只有每次修改都在两个独立持久化系统中成功，双写才能让旧 Runtime 保持最新。两者之间没有原子事务，sidecar 还会继续成为竞争权威。

## 结果

历史反馈保持可见，同时其来源字节不变。权威编辑和撤回在重启后具有确定的优先级。挂载本包需要 `storageDomain`，对带兼容行的 Session 执行操作时会进行严格的行与消息目标校验。格式错误或超大的已发布数据会明确失败，而不会被部分接受。

[服务测试](../../../../packages/feedback/message-feedback/tests/message-feedback.spec.ts)复制已发布格式的文档，验证字节保留，固定权威 put/delete 跨重启的优先级，并覆盖陈旧 Session 身份、未知消息、封闭 schema 拒绝及条目上限。[包参考](../../../../packages/feedback/message-feedback/README.zh.md#released-sidecar-read-through)定义运维合同。
