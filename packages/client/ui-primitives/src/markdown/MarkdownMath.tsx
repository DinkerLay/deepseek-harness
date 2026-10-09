/** React-scoped TeX delimiter preferences, independent from navigation and presentation. */
import type { ReactNode } from 'react'
import { MarkdownSyntaxProvider, useMarkdownSyntax } from './MarkdownSyntax.tsx'

/** Public support for scoped single-dollar TeX preferences. */
export const markdownMathOptionsVersion = 1

/** Props for one Markdown math scope. */
export interface MarkdownMathProviderProps {
  /** Parse `$...$` as inline TeX; false preserves literal currency while explicit math remains available. */
  readonly singleDollarTextMath: boolean
  readonly children: ReactNode
}

/**
 * Select single-dollar inline math for descendant Markdown renderers.
 * The enclosing tilde preference is preserved; this provider changes only inline-math syntax.
 * Renderers outside a provider retain native single-dollar support.
 * Backslash delimiters, double-dollar math and math fences remain enabled.
 * @param props - Explicit single-dollar preference and the scoped child tree.
 * @returns the child tree with an isolated Markdown math preference.
 */
export function MarkdownMathProvider({ children, singleDollarTextMath }: MarkdownMathProviderProps): ReactNode {
  const { singleTildeStrikethrough } = useMarkdownSyntax()
  return <MarkdownSyntaxProvider singleDollarTextMath={singleDollarTextMath}
    singleTildeStrikethrough={singleTildeStrikethrough}>{children}</MarkdownSyntaxProvider>
}

/** @returns the nearest single-dollar preference, defaulting to native inline-math support. */
export function useSingleDollarTextMath(): boolean {
  return useMarkdownSyntax().singleDollarTextMath
}
