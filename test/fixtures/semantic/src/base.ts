export abstract class BaseController {
  public handle(): void {}
}

export interface Runnable {
  run(): void
}
