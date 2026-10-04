import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const storeDir = readFileSync('node_modules/.modules.yaml', 'utf8').match(/^storeDir: (.+)$/m)?.[1]
const args = [...(storeDir ? [`--config.store-dir=${storeDir}`] : []), 'licenses', 'list', '--json']
const licenses = JSON.parse(execFileSync('pnpm', args, { encoding: 'utf8' }))
const allowed = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'CC0-1.0', 'Unlicense', 'OFL-1.1'])
// Every license identifier must be explicitly allowed, even on an OR branch.
// Accept only canonical identifiers, AND/OR, and balanced parentheses; no WITH,
// LicenseRef, later-version suffix, unknown identifier, or missing expression.
function approvedExpression(license) {
  if (!license || license.length > 1000 || /[^\x20-\x7E\t]/.test(license)) return false
  const tokens = license.match(/[()]|[^()\s]+/g) ?? []
  let at = 0
  function atom() {
    if (tokens[at] !== '(') return allowed.has(tokens[at++])
    at++
    return expression() && tokens[at++] === ')'
  }
  function expression() {
    if (!atom()) return false
    while (tokens[at] === 'AND' || tokens[at] === 'OR') {
      at++
      if (!atom()) return false
    }
    return true
  }
  return expression() && at === tokens.length
}
const forbidden = []
for (const [license, packages] of Object.entries(licenses)) {
  for (const pkg of packages) {
    if (!approvedExpression(license) || /^(?:@tldraw\/|tldraw$|@y\/hub$)/.test(pkg.name)) {
      forbidden.push(`${pkg.name}@${pkg.versions.join(',')}: ${license}`)
    }
  }
}
if (forbidden.length) {
  console.error(`Dependency licenses need review:\n${forbidden.join('\n')}`)
  process.exit(1)
}
console.log('Dependency license audit passed: every package matches the explicit SPDX allowlist and package exclusions.')
