import { Base, type Contract } from './base.js'
import * as lib from './base.js'

export enum Color {
  Red,
  Green,
}

export type Pair = [string, string]

export const { first, rest: [second] } = { first: 1, rest: [2] }
export const answer = 42,
  other = 'x'

const hidden = 1
export { hidden as visible }

export abstract class Repository<T> extends Base<T> implements Contract, lib.Other {
  static create(): void {}

  run(): void {}

  other(): void {}

  protected abstract load(): T

  #cache(): void {}

  private secret(): void {}

  overloaded(a: string): void
  overloaded(a: number): void
  overloaded(_a: unknown): void {}
}

export class Service {
  readonly id = 1

  constructor(
    private readonly repository: Repository<unknown>,
    public name: string,
  ) {}
}

export class Frozen {
  readonly b = 2

  constructor(readonly a: number) {}
}

class Local {}

export { Local }

export interface Reader extends Contract {
  readonly id: string
  read(): void
}

export function overload(a: string): void
export function overload(a: number): void
export function overload(_a: unknown): void {}

function Injectable(): ClassDecorator {
  return () => undefined
}

@Injectable()
@lib.Tagged()
export class Decorated {}

export default class Named {}
