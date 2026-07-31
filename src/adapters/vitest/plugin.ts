import { expect } from 'vitest'

import { archerMatchers } from '../../testing/matchers.js'

expect.extend(archerMatchers)

export { archerMatchers }

declare module 'vitest' {
  interface Matchers<T = any> {
    toRespectArchitecture(): Promise<T>
  }
}
