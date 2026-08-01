import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export async function loadTiaPlugin() {
  const packageEntry = '@usescherie/tiacore/vitest'
  try {
    return await import(packageEntry)
  } catch (error) {
    if (
      error === null ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'ERR_MODULE_NOT_FOUND'
    ) {
      throw error
    }
  }

  const configured = process.env.TIACORE_VITEST_ENTRY?.trim()
  const candidates = [
    ...(configured === undefined || configured === '' ? [] : [path.resolve(configured)]),
    path.resolve('..', 'tiacore', 'dist', 'entries', 'vitest.js'),
  ]
  const entry = candidates.find((candidate) => existsSync(candidate))
  if (entry === undefined) {
    throw new Error(
      'tiacore is unavailable. Install @usescherie/tiacore, set TIACORE_VITEST_ENTRY, or build the adjacent ../tiacore checkout.',
    )
  }
  return import(pathToFileURL(entry).href)
}
