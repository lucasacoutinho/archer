import { readFile } from 'node:fs/promises'
import type { TestOptions } from 'node:test'

export type StoredOrder = import('../domain/order.js').Order
export type NodeTestOptions = TestOptions

export const loadEffect = async () => import('effect')
export const read = readFile
export const missing = require('./missing.cjs')
