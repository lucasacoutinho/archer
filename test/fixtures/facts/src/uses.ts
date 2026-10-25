import { readFileSync as read } from 'node:fs'
import * as fs from 'node:fs'
import path from 'node:path'

export const run = (): void => {
  fs.readFileSync('a')
  read('b')
  path.join('a', 'b')
  eval('1')
  setTimeout(() => undefined, 0)
  console.log('not recorded')
  const local = (): number => 1
  local()
  const shadow = (read: () => void): void => read()
  shadow(() => undefined)
  if (1 == 1 || 2 != 3) {
    return
  }
  if (1 === 1 && 2 !== 3) {
    return
  }
}
