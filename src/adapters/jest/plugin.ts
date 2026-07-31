import { expect } from '@jest/globals'

import { archerMatchers } from '../../testing/matchers.js'

expect.extend(archerMatchers)

export { archerMatchers }

declare module 'expect' {
  interface Matchers<R extends Promise<void> | void, T = unknown> {
    toRespectArchitecture(): Promise<void>
  }
}
