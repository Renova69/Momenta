/**
 * jest-dom's matchers, typed for Vitest 5.
 *
 * Vitest 5 gave its assertion types a second parameter (`Assertion<R, T>`)
 * and reads custom matchers from `Matchers<R, T>`. jest-dom 7.0.1 still
 * augments the one-parameter `Assertion<T>` of Vitest 4, which no longer
 * merges, so every `toBeInTheDocument()` failed to type-check while running
 * fine: tests/setup.ts registers the matchers at runtime either way.
 *
 * Remove this file once jest-dom ships Vitest 5 types.
 */
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  // Declaration merging: the parameters must repeat Vitest's own exactly, `T`
  // included, and the members all come from the interface it extends.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown>
    extends TestingLibraryMatchers<unknown, R> {}
}
