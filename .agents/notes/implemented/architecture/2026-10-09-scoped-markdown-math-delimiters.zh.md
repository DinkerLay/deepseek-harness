# Agent Note: 作用域 Markdown 语法偏好

Status: implemented

[English](2026-10-09-scoped-markdown-math-delimiters.md) | 中文

## Problem

单美元 TeX 会把两个美元符号之间的金额正文识别为公式，包括中文文字与 Markdown 强调。流式渲染使用不含数学扩展的 GFM，因此可读的金融段落可能只在落定时变为公式。单波浪线删除线还会在流式或落定阶段，把两个数字区间之间的文字与引用划掉。其他 Markdown owner 仍依赖原生 `$x$` 与 `~text~` 语法。

## Decision

[UI primitives](../../../../packages/client/ui-primitives/README.zh.md#component-catalog)拥有 `MarkdownSyntaxProvider`，它是带显式 `singleDollarTextMath` 与 `singleTildeStrikethrough` 布尔值的纯 React 作用域。Provider 外两者默认为 true。每个渲染器读取最近的 Provider，独立于并行视图及导航回调。`markdownSyntaxOptionsVersion` 标识这项公开能力。兼容的 Math provider 保留其版本，只改变美元语法，通过同一 React Context 继承外层波浪线偏好。

两条渲染路径都将波浪线偏好传给既有 GFM 扩展。False 保留数字区间，同时继续支持显式双波浪线删除线。落定 Markdown 还将美元偏好传给既有数学扩展；false 保留金额，同时继续支持反斜线定界符、双美元公式及数学围栏。偏好变化会让同一源文字的落定渲染重新计算。改变波浪线偏好时重建冻结流式语法，只改变美元偏好时继续保留它。公式仍在落定后渲染。

浏览器壳静态预加载 UI-primitives namespace。因此，[fork 元数据清单](../../../../fork-manifest.json)将 `apps/web` 的 `@deepseek-ai/dsh-web-frontend` 记录为重建产物，以 UI primitives 为输入。打包先执行 `build:web`，再收集前端 `dist`。源码修改与生成产物依赖分开记录，Provider 与原生 Markdown 渲染器使用完全相同的实例。

## Alternatives considered

**全局禁用单字符语法。** 改变依赖原生数学或删除线语法的文档。

**根据模型措辞推断标点。** 金融写法与数学、删除线语法存在重叠。显式 owner 偏好无需猜测哪个数字范围表示普通文字。

**转义已存消息中的标点。** 为展示偏好改变源内容及回放可见文字。

**运行时加载第二份 primitives 库。** 它的 React Context 无法控制使用壳中预加载实例的 Markdown 渲染器。重建静态壳可保留单一共享 namespace。

## Consequences

金融正文的 owner 将两项偏好设为 false，公式使用明确的 TeX 定界符，删除线使用双波浪线。Provider 不改写 Session 文字，不改变字体或导航，也不启用受信任 TeX 命令。测试覆盖金额、数字区间、引用、显式语法、旧 provider 兼容、并行视图、相同文字的策略变化及冻结流式语法。安装后的浏览器验收检查公开版本与实际渲染；只有源码测试，不能证明浏览器收到重建后的 namespace。
