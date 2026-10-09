# Agent Note: 作用域 Markdown 数学定界符

Status: implemented

[English](2026-10-09-scoped-markdown-math-delimiters.md) | 中文

## Problem

单美元 TeX 会把两个美元符号之间的金额正文识别为公式，包括中文文字与 Markdown 强调。流式渲染使用不含数学扩展的 GFM，因此可读的金融段落可能只在落定时变为公式。其他 Markdown owner 仍依赖原生 `$x$` 语法。

## Decision

[UI primitives](../../../../packages/client/ui-primitives/README.zh.md#component-catalog)拥有 `MarkdownMathProvider`，它是带显式 `singleDollarTextMath` 布尔值的纯 React 作用域。Provider 外继续启用单美元公式。每个渲染器读取最近的 Provider，独立于并行视图及导航回调。`markdownMathOptionsVersion` 标识这项公开能力。

落定 Markdown 将偏好传给既有 micromark 数学扩展。False 让单美元序列保留为普通 Markdown，同时保留反斜线定界符、双美元公式及数学围栏。偏好变化会让同一源文字的落定渲染重新计算。流式渲染保留既有 GFM 解析器及冻结块缓存，公式仍在落定后渲染。

浏览器壳静态预加载 UI-primitives namespace。因此，[fork 元数据清单](../../../../fork-manifest.json)将 `apps/web` 的 `@deepseek-ai/dsh-web-frontend` 记录为重建产物，以 UI primitives 为输入。打包先执行 `build:web`，再收集前端 `dist`。源码修改与生成产物依赖分开记录，Provider 与原生 Markdown 渲染器使用完全相同的实例。

## Alternatives considered

**全局禁用单美元公式。** 改变依赖原生默认语法的数学文档。

**猜测每个美元符号是否表示金额。** 金融写法与数学表达式存在重叠。显式 owner 策略无需推断模型措辞。

**转义已存消息中的美元符号。** 为展示偏好改变源内容及回放可见文字。

**运行时加载第二份 primitives 库。** 它的 React Context 无法控制使用壳中预加载实例的 Markdown 渲染器。重建静态壳可保留单一共享 namespace。

## Consequences

金额内容的 owner 选择 false，公式使用明确的 TeX 定界符。Provider 不改写 Session 文字，不改变字体或导航，也不启用受信任 TeX 命令。聚焦测试覆盖精确金额文字、强调、显式公式、Provider 隔离、相同文字的策略变化、冻结流式块及落定。安装后的浏览器验收还检查公开版本与实际金额渲染；只有源码测试，不能证明浏览器收到重建后的 namespace。
