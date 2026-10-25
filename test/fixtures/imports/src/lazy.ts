export const literal = () => import('./types.js')
export const template = () => import(`./types.js`)
export const computed = (name: string) => import(name)
export const interpolated = (name: string) => import(`./${name}.js`)
export type Shape = import('./types.js').A
export type Module = typeof import('./types.js')
