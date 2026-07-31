import { readFile } from 'node:fs/promises'

export type StoredOrder = import('../domain/order.js').Order

export const loadParser = async () => import('picomatch')
export const read = readFile
export const missing = require('./missing.cjs')
