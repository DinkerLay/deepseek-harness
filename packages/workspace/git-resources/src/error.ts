/** Actionable local Git resource refusals never expose raw Git configuration values. */
export class GitResourceError extends Error {
  /** @param code - stable machine-readable refusal.
   * @param message - bounded diagnostic without file contents or configuration values.
   */
  constructor(readonly code: string, message: string) { super(message); this.name = 'GitResourceError' }
}
