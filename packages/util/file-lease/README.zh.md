---
description: "为 Session 写入者和受管 Git 资源操作提供非阻塞的内核拥有权。"
kind: "package-library"
---

# @deepseek-ai/dsh-util-file-lease

[English](README.md) | 中文

## 概述

持有锁路径期间，调用方可用本库排除其他进程。`acquireFileLease` 返回租约或立即报告竞争；`release` 关闭内核描述符或句柄，不删除 POSIX 锁文件。Session 持久化和受管 Git 资源各自保留目录、身份、操作与恢复规则。拥有权不依赖 PID 记录、过期超时或对活跃持有者的抢占。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

调用方提供与数据分离的锁路径，并确保父目录存在且有合适的归属与权限。直接导入本库；它不是 Cordis 插件。

```text
import { acquireFileLease } from '@deepseek-ai/dsh-util-file-lease'

const lease = await acquireFileLease(lockPath)
try {
  await updateOwnedResource()
} finally {
  await lease.release()
}
```

`FileLeaseBusyError.path` 标识竞争或不稳定的锁 inode。其他文件系统或内核失败保留原诊断。释放是幂等的，绝不删除 POSIX 锁文件。读取方不取得租约。

Session 持久化创建私有产物目录，并将竞争转换为 Session 专属错误。Git 资源只在自身登记的操作路径上取得租约；两类消费者都不会因此获得删除或认领任意目录的权限。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

POSIX 使用非阻塞原生 `flock`，再比较描述符与锁路径的 inode 和设备。路径被替换或消失时，针对当前路径最多重试三次。Windows 使用零超时的命名内核信号量，不持有文件系统句柄。现有 `Local\\dsh-session-lock-` 路径哈希命名空间保持不变，因此已有 Session 持有者与共享实现竞争同一个对象。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 公开租约与竞争错误接口 |
| [`src/win32.ts`](src/win32.ts) | 内部信号量绑定和错误转换 |

不发布运行时不变量伴随包，因为本库不拥有事件流或独立运行时投影；获取时和进程测试核对内核竞争与路径身份。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Session 持久化](../../session/session-persistence-jsonl/README.zh.md) — 延迟物化与 Session 拥有权。
- [原生系统支持](../../../native/system/README.zh.md) — 异步 POSIX flock。

<a id="model-experience"></a>
## 模型体验

### 内核拥有权

#### 模型看到什么

`acquireFileLease` 和 `FileLease.release` 不注册工具、提示或模型可见消息；消费者拥有展示的诊断内容。

#### Token 影响

内核拥有权不增加请求内容或 Token。

#### KV 缓存影响

本库不进入请求前缀，因此不影响 Provider 缓存复用。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 租约是协作机制，不是沙箱。删除活跃 POSIX 锁路径会失去排他性；调用方必须保持其 inode 和归属稳定。
- Advisory flock 在某些网络文件系统上不可靠。Windows 信号量命名空间只覆盖同一登录会话。
- POSIX 需要匹配的系统附加模块。原生 Windows 行为需要 Windows 测试通道；其他主机上的注入绑定不构成原生平台证据。
- 活跃但卡住的持有者在释放或退出前仍是拥有者。本库不超时、不检查 PID、不清理资源，也不重试消费者的操作。

<a id="dev-note"></a>
### 开发备注

无。
