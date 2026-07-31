import { BaseController, type Runnable } from './base.js'
import { Controller } from './decorator.js'

@Controller()
export class UserController extends BaseController implements Runnable {
  public readonly name = 'users'

  public run(): void {}

  protected reset(): void {}
}
