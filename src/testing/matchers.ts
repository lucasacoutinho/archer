import type { ArchitectureResult } from '../core/types.js'
import { formatResult } from '../reporting/format.js'

export interface ArchitectureCheck {
  check(): Promise<ArchitectureResult>
}

export interface ArcherMatcherResult {
  readonly message: () => string
  readonly pass: boolean
}

function isArchitectureCheck(value: unknown): value is ArchitectureCheck {
  return (
    typeof value === 'object' &&
    value !== null &&
    'check' in value &&
    typeof value.check === 'function'
  )
}

async function toRespectArchitecture(received: unknown): Promise<ArcherMatcherResult> {
  if (!isArchitectureCheck(received)) {
    throw new TypeError(
      'toRespectArchitecture() expects an Archer suite created by createArcher() or arch().',
    )
  }

  const result = await received.check()
  return {
    pass: result.ok,
    message: () =>
      result.ok
        ? 'Expected the architecture check to report at least one finding.'
        : formatResult(result),
  }
}

/** Matchers shared by the Vitest, Jest, and Bun test plugins. */
export const archerMatchers = { toRespectArchitecture }
