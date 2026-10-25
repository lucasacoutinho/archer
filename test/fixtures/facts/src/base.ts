export class Base<T> {
  value?: T
}

export interface Contract {
  run(): void
}

export interface Other {
  other(): void
}

export function Tagged(): ClassDecorator {
  return () => undefined
}
