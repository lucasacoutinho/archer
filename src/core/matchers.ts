import picomatch from 'picomatch'

import type { Selector } from './types.js'

const GLOB_CHARACTERS = /[*?{[(]/u

function normalize(value: string): string {
  if (value.startsWith('./')) {
    return value.slice(2).replaceAll('\\', '/')
  }

  return value.replaceAll('\\', '/')
}

function matchesOne(candidate: string, rawSelector: string): boolean {
  const selector = normalize(rawSelector)

  if (/^(?:dynamic|file|node|npm|unresolved):\*$/u.test(selector)) {
    return candidate.startsWith(selector.slice(0, -1))
  }

  if (!GLOB_CHARACTERS.test(selector)) {
    if (candidate === selector || candidate.startsWith(`${selector}/`)) {
      return true
    }

    if (selector.startsWith('npm:') && candidate.startsWith(`${selector}/`)) {
      return true
    }

    return false
  }

  return picomatch(selector, { dot: true })(candidate)
}

export function selectorValues(selector: Selector): readonly string[] {
  return typeof selector === 'string' ? [selector] : selector
}

export function matchesSelector(candidate: string, selector: Selector): boolean {
  return selectorValues(selector).some((value) => matchesOne(candidate, value))
}

export function formatSelector(selector: Selector): string {
  return selectorValues(selector)
    .map((value) => `'${value}'`)
    .join(', ')
}
