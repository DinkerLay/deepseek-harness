---
description: "可信的逐次执行业务环境注册表。"
kind: "package-reference"
---

# @deepseek-ai/dsh-shell-exec-env

[English](README.md) | 中文

## 概述

这是一个可选的 Service Definition，用于在每次面向模型的 Bash 或 Pwsh 执行前解析可信环境变量。Provider（提供方）声明其拥有的精确键名，并通过 effect（副作用）管理的注册返回当前非空值。贡献者名称和环境键只能有一个所有者；键所有权按大小写不敏感处理，确保同一组合在 Windows 上也安全。重复所有权、未声明或大小写不一致的返回项、`DSH_*` 键以及空值都会在创建子进程前失败。

不发布 invariant companion：注册与收集在各自边界校验所拥有的键及返回值。

## 目录

- [使用本包](#package-section-1)
- [安全性](#package-section-2)
- [模型体验](#package-section-3)
- [已知限制与暂缓事项](#package-section-4)
- [开发备注](#package-section-5)

<a id="package-section-1"></a>
## 使用本包

包默认导出 `ShellExecEnvironmentRegistry`，并注册 `ctx.shellExecEnv`。面向模型的 shell Consumer（消费方）通过可选的 `ctx.get('shellExecEnv')` 发现它；未加载该服务的组合保留官方 shell 行为。

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-shell-exec-env'

declare function obtainShortLivedCapability(agentId: unknown): Promise<string | undefined>

export const inject = ['shellExecEnv']

export function apply(ctx: Context): void {
  ctx.shellExecEnv.register({
    name: 'short-lived-api-capability',
    keys: ['EXAMPLE_API_KEY'],
    async resolve(execution) {
      const value = await obtainShortLivedCapability(execution.agent?.id)
      return value === undefined ? {} : { EXAMPLE_API_KEY: value }
    },
  })
}
```

每次前台和后台 shell 调用都会收集新的快照。收集发生在工具校验、sandbox 策略解析及可能的审批提示之后，但在进程创建之前。提供方拒绝或取消时，工具调用失败且不会启动进程。在收集等待期间移除或替换贡献方，会拒绝其待处理值；卸载的账户不能投递陈旧环境快照。快照只合并到本次命令显式的 `ShellExecRequest.env`；`process.env` 永远不会被修改或缓存。

此注册表不会读取进程环境、持久化值、公开列表操作，也不会给面向模型的工具 schema 增加环境参数。它还拒绝受管理的 `DSH_*` 命名空间；该命名空间仍由 [`@deepseek-ai/dsh-shell-env`](../shell-env/README.zh.md) 拥有。本地子进程 Provider 会先删除环境中形似凭证的变量，再合并这份显式可信快照。

<a id="package-section-2"></a>
## 安全性

Provider 插件运行在可信 Host 进程中，并已具有执行该进程权限范围内代码的能力。即便如此，它仍必须只贡献作用域较窄、生命周期较短的能力，因为被调用的命令可以读取本次提供的所有值。值不得写入日志、会话事件、模型可见结果、配置或全局环境。

<a id="package-section-3"></a>
## 模型体验

### 受信命令环境

#### 模型看到什么

注册表不增加提示词文本、Tool schema 字段、结果字段或持久 Session 事件。受信 shell Consumer 通过 `ShellExecRequest.env` 提供收集到的值；该子进程可以读取它们，并可能把它们包含在自身输出中。

#### Token 影响

收集操作不增加模型输入。shell Consumer 管理记录的命令输出及其后续 token 成本。

#### KV Cache 影响

受信环境不进入请求前缀；收集本身不影响提供方缓存复用。

## 已知限制与暂缓事项

<a id="package-section-4"></a>

- 环境值对本次 shell 调用的完整子进程树可见；注册表无法限制由哪个可执行文件或后代进程读取。

<a id="package-section-5"></a>
### 开发备注

无。
