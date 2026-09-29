import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const storeDir = readFileSync('node_modules/.modules.yaml', 'utf8').match(/^storeDir: (.+)$/m)?.[1]
const args = [...(storeDir ? [`--config.store-dir=${storeDir}`] : []), 'licenses', 'list', '--json']
const licenses = JSON.parse(execFileSync('pnpm', args, { encoding: 'utf8' }))
const forbidden = []
for (const [license, packages] of Object.entries(licenses)) {
  for (const pkg of packages) {
    if (/AGPL|UNLICENSED|SEE LICENSE/i.test(license) || /^(?:@tldraw\/|tldraw$|@y\/hub$)/.test(pkg.name)) {
      forbidden.push(`${pkg.name}@${pkg.versions.join(',')}: ${license}`)
    }
  }
}
if (forbidden.length) {
  console.error(`Dependency licenses need review:\n${forbidden.join('\n')}`)
  process.exit(1)
}
console.log('Dependency license audit passed: no tldraw, @y/hub, AGPL, or unlicensed packages.')
