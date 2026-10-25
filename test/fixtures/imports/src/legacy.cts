import fs = require('node:fs')
import type Types = require('./types.js')
import local = require('./helper.cjs')

const helper = require('./helper.cjs')
const sibling = require('./types.js')
const chalk = require('effect')
const missing = require('./missing.cjs')
const computed = (name: string) => require(name)

export = { fs, helper, sibling, chalk, missing, computed, local }
