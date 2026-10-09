/** React-scoped TeX delimiter preferences, independent from navigation and presentation. */
import { createContext, useContext, type ReactNode } from 'react'

const SingleDollarMathContext = createContext(true)

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
 * The nearest provider wins; renderers outside a provider retain native single-dollar support.
 * Backslash delimiters, double-dollar math and math fences remain enabled.
 * @param props - Explicit single-dollar preference and the scoped child tree.
 * @returns the child tree with an isolated Markdown math preference.
 */
export function MarkdownMathProvider({ children, singleDollarTextMath }: MarkdownMathProviderProps): ReactNode {
  return <SingleDollarMathContext.Provider value={singleDollarTextMath}>{children}</SingleDollarMathContext.Provider>
}

/** @returns the nearest single-dollar preference, defaulting to native inline-math support. */
export function useSingleDollarTextMath(): boolean {
  return useContext(SingleDollarMathContext)
}
