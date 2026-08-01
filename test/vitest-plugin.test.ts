import path from 'node:path'

import { describe, expect, test, vi } from 'vitest'

import { archer } from '../src/adapters/vitest/index.js'

describe('Vitest config plugin', () => {
  test('checks the project once during config resolution', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const plugin = archer({ config: 'test/fixtures/cli/archer.config.mjs' })
    const config = { root: path.resolve('.') }

    await plugin.configResolved(config)
    await plugin.configResolved(config)

    expect(output).toHaveBeenCalledOnce()
    expect(output).toHaveBeenCalledWith(expect.stringContaining('Archer checked'))
    output.mockRestore()
  })

  test('fails Vitest config resolution when architecture is violated', async () => {
    const plugin = archer({
      config: 'test/fixtures/cli/archer.failing.config.mjs',
      reporter: 'agent',
    })

    await expect(plugin.configResolved({ root: path.resolve('.') })).rejects.toThrow(
      /archer: fail.*src\/application\/create-order\.ts/su,
    )
  })
})
