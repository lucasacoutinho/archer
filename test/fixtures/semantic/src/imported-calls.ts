import React, { useEffect as runEffect } from 'react'
import { inject as readInjection } from 'vue'
import { getContext } from 'svelte'

const { useContext: readContext } = require('react')

export function callFrameworkApis(): void {
  runEffect(() => {})
  React.useEffect(() => {})
  React['useContext']('session')
  readContext('session')
  readInjection('session')
  getContext('session')
}
