---
description: "供隔离代码目录的消费方使用的本地Git工作副本基线、持久创建与保全、独占Host使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-git-resources

[English](README.md) | 中文

## 概述

从明确提交或选定的暂存/工作文件创建隔离本地副本，不改变项目HEAD、index或文件。Host重启后仍保留创建身份与保全版本。准备独立集成和反向候选；只通过显式认证Host占用应用精确差异。删除已不用的受管副本前先保全完整文件内容。本包要求已登记Git项目与持久存储，不提供模型工具。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与推迟工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在Workspace登记、storage-domain与本地subprocess提供者旁挂载本插件，然后向`ctx.gitResources.preview`传入已登记项目的Workspace身份。

### 配置与基线

`home`使用公开Harness home路径助手解析。受管副本与稳定内核锁文件位于其`git-resources`子目录；打开可写domain前先租用整个资源home。第二个拥有者会被拒绝，不猜测另一个进程是否活着。

`timeoutMs`、`graceMs`、`maxOutputBytes`、`maxFiles`、`maxFileBytes`、`maxTotalBytes`、`maxConsumerRequestBytes`与`closeTimeoutMs`限制命令、观察、原始消费方JSON及关闭。文件同时受单文件上界和Git字节通道上界约束；不可物化的基线在预留前由预览拒绝。[Config声明](src/index.ts)拥有接受的默认值。首次需要时解析`gitExecutable`或`git`；Git缺失只拒绝隔离模式，数据查询和文本服务仍可用。

提交基线也会报告全部暂存、未暂存、未跟踪和未合并路径。选定基线要求`baseCommit`，每个路径明确选`index`、`worktree`或`untracked`来源；保留index删除。预览不写Git对象或项目数据。工作文件的原始字节绕过Git过滤器，保留二进制内容与执行位。

### 持久操作与观察

`create`要求未变化的预览指纹、原操作id、不透明`consumerScope`和有界合法`originalRequestJson`。拥有者不解释消费方业务字段，也不把它们当授权。重试不可改变scope或原JSON；`listOperations(scope)`精确比较已保存scope，不按操作名的前缀分组。

创建在外部效果前记录预留路径不存在及意图。显式相同`create`重试可继续安全的原步骤；`reconcile`只观察已登记ref、目录身份和已完成物化，并可确认已有事实，不创建对象、ref、目录或缺失文件。缺失、移动、未知或冲突的证据保留为需处理，不删除或重建副本。`read`、`status`与`listOperations`是纯domain观察。

`abandonOperation`只在持久的外部写入未开始见证和完整无效果检查下终结原请求。未启动应用还要求完整目标精确保持before状态；解决确认不得已有完成效果。见证缺失、部分写入和已有效果拒绝。放弃不回滚、不删除任何内容，原操作id之后不能创建新效果。

`preserve`先记录自身意图。默认`content: 'versioned'`将已跟踪和未忽略的新文件的工作字节封存在不可变私有ref下，保留已跟踪文件的删除。忽略文件与目录不读取、不hash：`unpreservedPaths`只记录其剩余名称，不证明它们可被删除。显式`content: 'all'`保全有界常规目录内容，仍拒绝受保护路径，不能作为代码成果封存。每条操作独立保留自身`effectContent`与剩余路径，不被后来资源版本替换。回执包含真实tree、commit、manifest hash与保全ref，不改变用户分支、index或文件。

创建只从精确基线初始化受管副本自身的index；重试不重置未知index内容。后续合法detached提交可以保留：保全记录实际detached HEAD作为其提交的parent，不改不可变基线。attached分支明确诊断拒绝，不自动checkout或reset。

### 独立集成与精确解决确认

`previewIntegration`观察同一仓库和不透明消费方scope内有序的不可变代码版本。`integrate`在计算Git合并对象前记录意图，并创建独立工作副本；两者都不向项目应用修改。冲突结果停止在剩余输入之前，保留其身份、实际Git索引阶段和结构化冲突类型。`attemptedInputCount`包含发生冲突的输入，不表示已成功应用。

冲突合并可能没有高阶段索引。stage-zero索引、冲突文本消失或模型摘要都不能证明已解决。新封存仍保留原集成的已知冲突身份。`previewResolution`核对精确静止封存版本、当前工作字节与索引。`resolveIntegration`要求可信Host证明普通验证与权限，之后独立记录覆盖该版本全部已知冲突的回执。原集成和封存记录不可变，后来版本需要新确认。集成输入显式选择精确`resolutionOperationIds`，不跟随资源最新状态。

### 显式目标变化与清理

`previewApplication`展示完整有界普通/二进制patch及目标HEAD、index、受影响字节、模式和父目录见证。`apply`要求认证Host权限和已知写入者占用；请求JSON不能替代证明。写入前的精确新切面必须仍一致，HEAD/index保持不变。纯对账报告before、after、partial或unknown；只在已派发效果精确after时确认，不盲重放部分或未知内容。

`previewInverse`和`prepareInverse`从当前目标和原差异出发，不再应用旧来源输入，也不碰项目文件。独立候选必须经过普通验证和新的显式应用。

`inspectWorkCopy`即使在held写入回调内，也只观察工作版本hash与真实索引冲突，不竞争资源通道、不写Git或domain事实。该切面不证明静止或测试成功。

`previewCleanup`要求精确all文件内容保全、无当前/不确定使用、无未保全空目录或未解决索引阶段，每个暂存对象都由固定文件版本覆盖。all文件保全不是原始index或目录状态备份。`cleanup`还要求Host证明没有执行仍以它为cwd。只有新的完整切面仍一致才移除原受管身份，保留ref和历史。派发删除后，纯观察可确认目录和元数据都缺席；部分或被替换的路径不再删除。已移除副本不能作为可写base，但其不可变保全版本仍可作为显式选定来源。

### 独占使用与静止交还

`withWriteUse`将使用取得、创建完成和保全放在同一资源串行通道。回调获得同步`assertCurrent`供其他拥有者的锁内CAS使用，不必持其他锁等待Git。Host应保持回调，直到执行与后台工作真正结算。

成功回调才持久确认交还。失败或取消保留精确owner、epoch与use id，标为需处理。冷held使用不会因为进程消失就变成静止。`confirmQuietUse`在可信Host同步证据下核对原身份与revision，不可释放仍活跃的回调。排队使用可在进入前取消而不运行回调。关闭中止并排空已准入工作；超时报告失败并保留内核租约，直到该工作结算。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

每个仓库的一条storage-domain记录拥有其资源、使用和操作回执。后端持久确认后变化才可见。Git与存储有不同提交点：回执缺失时，私有ref和相互指向的worktree元数据识别外部效果。稳定的整个home内核租约阻止另一个Host打开竞争的可写资源状态。

仓库检查在运行普通Git命令前，只读取配置键名而不展开local include。子进程环境隔离HOME/全局配置，将外部ignore文件覆盖为拥有者的空文件，并禁用hooks、replace对象、monitor及惰性联网fetch。local ignore规则链接在求值前拒绝，忽略目录不遍历。不安全include、可执行转换、嵌套仓库及不支持的链接明确拒绝。创建使用私有index与原始blob，再物化已核对tree，不经过checkout过滤器。

不发布运行时不变量伴随包：意图活跃期间，Git/文件系统证据可合法先于其持久回执。创建、对账、使用与保全操作在明确准入和确认点核对该关系；同步定期断言会把已准入中间状态误判为分歧。

精确合同见[服务](src/index.ts)、[仓库观察](src/preview.ts)、[持久schema](src/records.ts)与[受管Git执行](src/git.ts)。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [Workspace登记](../workspace/README.zh.md)——已有项目目录与Session关联。
- [Domain存储](../../storage/storage-domain/README.zh.md)——先持久、后发布的记录变化。
- [Subprocess服务](../../subprocess/subprocess/README.zh.md)——精确argv、字节通道与进程范围结算。
- [文件租约](../../util/file-lease/README.zh.md)——稳定的跨进程内核互斥。

-----

<a id="model-experience"></a>
## Model Experience

### Host资源操作

#### What the model sees

`ctx.gitResources`不登记模型工具、提示或模型可见Session事件。消费方自行决定是否展示分离的资源事实。

#### Token effect

本包不增加请求token，也不发起模型请求。消费方展示决定任何间接上下文成本。

#### KV Cache effect

资源观察与变化不改变模型历史或已可复用的提示前缀。消费方展示和提供者缓存可用性不在本包合同内。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

本拥有者管理本地常规文件副本，不是沙箱，也不是万能文件回滚服务。

- 符号链接、submodule tree、不安全仓库配置、外部对象库、非UTF-8路径、drive-qualified选择器及凭据形路径明确拒绝，不静默省略。POSIX上的drive-looking名称也拒绝，避免在Windows取得不同含义。远程仓库、sparse/index扩展与任意自定义过滤器不能替代可核验的本地基线。
- 保全与集成不是业务结果验收。代码封存后仍有忽略内容，不代表可清理。all文件保全不备份未固定的独立index对象或空目录状态，因此这些情况明确拒绝清理。
- 调用方必须在交还或保全前建立执行/后台静止事实。Host必须挂载与Node文件系统相同的本机subprocess提供者；不支持远程执行world。全盘权限下的外部进程仍可在本拥有者协调之外修改目录；观察到变化时拒绝，不证明全局隔离。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护工作上下文——点击展开</summary>

无。

</details>
