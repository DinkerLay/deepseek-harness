/** React-scoped Markdown punctuation preferences, shared by live and settled rendering. */
import { createContext, useContext, useMemo, type ReactNode } from 'react'

/** Syntax preferences independent from navigation and typography. */
export interface MarkdownSyntaxOptions {
  /** Interpret `$...$` as inline TeX; explicit math delimiters remain enabled when false. */
  readonly singleDollarTextMath: boolean
  /** Interpret `~...~` as deletion; `~~...~~` remains enabled when false. */
  readonly singleTildeStrikethrough: boolean
}

const MarkdownSyntaxContext = createContext<MarkdownSyntaxOptions>({
  singleDollarTextMath: true,
  singleTildeStrikethrough: true,
})

/** Public support for scoped dollar and tilde syntax preferences. */
export const markdownSyntaxOptionsVersion = 1

/** Props for one explicit Markdown syntax scope. */
export interface MarkdownSyntaxProviderProps extends MarkdownSyntaxOptions {
  readonly children: ReactNode
}

/**
 * Select Markdown punctuation for descendant renderers without rewriting their source.
 * The nearest provider wins; renderers outside a provider retain native dollar and tilde defaults.
 * @param props - Both syntax preferences and the scoped child tree.
 * @returns the child tree with isolated syntax preferences.
 */
export function MarkdownSyntaxProvider({
  children, singleDollarTextMath, singleTildeStrikethrough,
}: MarkdownSyntaxProviderProps): ReactNode {
  const options = useMemo(() => ({ singleDollarTextMath, singleTildeStrikethrough }),
    [singleDollarTextMath, singleTildeStrikethrough])
  return <MarkdownSyntaxContext.Provider value={options}>{children}</MarkdownSyntaxContext.Provider>
}

/** @returns the nearest syntax preferences, defaulting to native dollar and tilde support. */
export function useMarkdownSyntax(): MarkdownSyntaxOptions {
  return useContext(MarkdownSyntaxContext)
}
