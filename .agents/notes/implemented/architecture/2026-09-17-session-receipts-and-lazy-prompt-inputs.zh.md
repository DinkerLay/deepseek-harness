# Agent Note: Session 创建回执与延迟提示词准备

Status: implemented

[English](2026-09-17-session-receipts-and-lazy-prompt-inputs.md) | 中文

## Problem

外部控制器可能在协调自身元数据时创建 Host Session。其 Client 消费方需要寻址已确认的 Session，而不再次请求 Host 创建或读取整个列表。另外，延迟能力必须在提示词提供方读取 Tool schema 前准备完成；`agent/pre-step` 和组装 waterfall 都发生在收集之后。

## Decision

Session Client 提供第一版创建回执接收能力。经过校验的 Host 回执仅在身份尚不存在时创建本地空白摘要。管理器通过现有变更日志记录它并同步投影列表，使其跨越进行中的基线请求。重复回执保留已有的更丰富状态，接收回执不选择或创建 Host Session。

System Prompt 提供第一版按作用域分发的 `system-prompt/prepare` 串行事件，在读取任何提供方前执行。它等待准备完成，并在分发前后检查组装取消信号。提供方拥有资源和取消处理，后续组装 waterfall 保留其变换职责。这两项能力均不改变 Session 持久化，也不引入业务策略。

## Alternatives considered

**刷新整个列表或重复创建。** 两者都会给已确认的创建增加无关往返；修改私有列表则绕过管理器针对进行中基线的变更日志。

**在 Agent 创建期间初始化能力。** 这会让空 Session 创建等待网络就绪。改到 `agent/pre-step` 初始化，又晚于首次请求的 schema 收集。

## Consequences

公开回执接口信任有类型且已校验的 Host 响应，无法自行证明 Host 操作已经发生。延迟准备失败会阻止本次模型组装，空 Session 仍保持可用。聚焦 Client 和提示词测试覆盖同步寻址、重复回执、准备顺序、取消及监听器释放。现有 Session 生命周期和提示词组装约定继续有效；这些入口补充而非取代其职责。
