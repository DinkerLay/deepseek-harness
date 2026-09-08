# Agent Note: Provide permanent Session deletion as a DSH plugin

Status: implemented

[English](2026-08-20-dsh-session-deletion-plugin.md) | 中文

## Problem

永久删除操作必须从 live Agent ownership、durable persistence、Workspace accounting、query index、持久 projection checkpoint、Host projection 与 lifecycle-bound sidecar 中移除一条 Session lineage。只删除文件或一条 catalog row 会遗留 live Agent、descendant、搜索结果或 reload 后仍可见的状态。Product authorization 也不能持有通用 lifecycle operation，否则可复用 DSH behavior 会与单一 UI 耦合。

## Decision

`@deepseek-ai/dsh-session-deletion` 是可选的 Host-only service，提供 `ctx.sessionDeletion`。它向获得授权的 same-process Consumer 暴露 `preview(rootSessionId)` 与 `deleteTree(rootSessionId)`，不注册通用 browser Remote、command、model tool、prompt section 或 Session event。Stock bundle 不挂载该 package。

`SessionPersistence` 发布 `supportsDeletion`、`delete(id)` 与 `listDeletionHeaders()`。调用方在 mutation 前检查显式 capability。Coordinator-backed provider 会把 deletion 与 append、preparation、lazy materialization 和 retirement 串行化。`delete()` 移除 materialized 或 lazy identity 时返回其 header，并发布 awaited `session-persistence/deleted` event；identity 已不存在时返回 `undefined`。JSONL unlink 精确 artifact，并且只移除已经为空的 backend-owned directory。旧 SQLite 记录在切换运行时前通过 JSONL 提供方的公开导出器转换。

`SessionStore.reserveForDeletion()` 会阻止一组只增不减的 Session id 及其新 descendant 发布。Commit 会推进 per-id deletion epoch，使删除之前 prepare 的 Session object 无法在 fence 释放后发布；fresh same-id lifecycle 仍然有效。重叠 reservation 会被拒绝。

`AgentRegistry` 会保留 `create()` 与 `resume()` 返回的精确 `AgentHandle`，但不会暴露它。`reserveIdleDisposal(id)` 只 claim 处于精确 idle phase、inbox 为空且没有 maintenance operation 的 AgentLoop instance。Claim 会阻止新输入与 maintenance，然后要么沿普通 quiescent handle disposal 执行，要么在未使用时释放。直接注册或由 configuration 持有的 Agent 不可 claim，并且在 live 时会阻止 deletion 开始。

## Deletion lifecycle

`preview()` 合并 durable 与 live header，拒绝冲突或循环 lineage，并按 descendant 在 root 之前的顺序返回。`deleteTree()` 首先拒绝不支持 deletion 的 persistence provider，再 reserve 当前 closure，反复扩展直到 discovery 收敛，并在 dispose 任何 live member 之前 claim 全部成员。一个 busy 或 unowned member 会释放此前所有 claim，并且不触碰 persistence。

Agent disposal 之后，即使 persistence retirement 正在把 lazy header 从 live state 移到 cold state，原始 reserved plan 仍是 authority；reservation 只能扩展，不能缩小。Persistence deletion 按 child-first 执行，并在每个 id 成功结算后推进 SessionStore epoch，已经 absent 的零事件 identity 也不例外。`deletedSessionIds` 只包含 persistence 返回 removed header 的 id。Partial failure 最多留下已经删除的 child 与仍存在的 ancestor；retry 会重新发现剩余 tree，并最终收敛到 root removal。

## Derived cleanup

`session-persistence/deleted` 是 durable Consumer 的 commit notification。Workspace 会从每个 account 与 archive set 移除 id。Session Query 会移除 persisted 与 live index row。Session Projection Cache 会等待包含冷读取回写的在途写入，并保留已删除的 Header 与继承截断位置标识，阻止延迟观测重新创建该生命周期的检查点。Message Feedback 会进入其 per-Session mutation queue，并移除匹配 lifecycle sidecar。Session Controller 会发送一条 `api-session/removed` frame，并与普通 live disposal 去重。

Listener failure 无法回滚已经 committed 的 storage deletion。Parallel event 仍会调用每个 Consumer，记录 aggregate failure，之后 startup 或 catalog reconciliation 会根据剩余 persistence state 收敛。

## Alternatives considered

**直接从 Product Catalog 删除。** Product package 无法同时持有两个 persistence provider、Agent handle、Session publication 与每个 derived Consumer，而不复制 DSH lifecycle behavior。

**根据 `delete()` 方法是否存在推断 backend 支持。** Service Definition 为第三方 provider 提供 rejecting default，因此方法存在不能证明 capability。`supportsDeletion` 会在 reserve 或 dispose 任何 Agent 之前 fail loud。

**公开通用 browser `session.delete` endpoint。** Ambient browser deletion 会绕过 product ownership 与 confirmation。获得授权的 Product Remote 继续作为 Host service 的 Consumer。

**只删除 leaf Session。** Root conversation 可以持有 subagent 与其他 descendant。Bottom-up subtree deletion 能保持 lineage consistency，并提供可用的 product operation。

**自动 cancel running Agent。** Cancellation 可能丢弃 queued work 或掩盖 tool side effect。除非 subtree 中每个 live member 都真正 idle 且可 claim，否则 deletion 会在 persistence mutation 前拒绝。

**删除 Project Chat 时删除 Project directory。** Session 不拥有 Project directory。Session deletion 会移除 Workspace accounting，但绝不删除 source file 或 Workspace registration。

## Consequences

永久删除跨越多个 durable owner，而不是一个 storage transaction。Reservation、non-shrinking plan、child-first ordering、显式 provider capability、幂等 persistence return 与 product-owned journal 都是收敛所必需的。Persistence 与 product allocation cleanup 提交后，操作不可逆。

通用 package 刻意不持有 browser authorization、archive policy、Project file deletion 或 Product allocation cleanup。这些决策仍属于 Consumer。聚焦 contract 覆盖 JSONL、旧 SQLite 导出、lazy identity、preparation refusal、true-idle AgentLoop disposal、all-or-nothing live claim、lineage cycle、partial-failure retry、Loader composition 与 derived cleanup Consumer。
