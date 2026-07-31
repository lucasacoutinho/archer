import type { Order } from '@domain/order'
import { saveOrder } from '../infrastructure/order-repository.js'

export function createOrder(order: Order): void {
  saveOrder(order)
}
