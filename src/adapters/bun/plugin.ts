import { expect } from 'bun:test'

import { archerMatchers } from '../../testing/matchers.js'

expect.extend(archerMatchers)

export { archerMatchers }

declare module 'bun:test' {
  interface Matchers<T = unknown> {
    toRespectArchitecture(): Promise<void>
  }
}
