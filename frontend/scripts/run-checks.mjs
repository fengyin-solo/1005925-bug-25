// 转单逻辑校验入口：打包 scripts/ 下的检查脚本并在 node 里执行。
// 用法：npm run test:transfer
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import esbuild from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const checks = ['transfer-check', 'legacy-check']

for (const name of checks) {
  const outfile = join(here, `.${name}.bundle.mjs`)
  await esbuild.build({
    entryPoints: [join(here, `${name}.ts`)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    alias: { '@': join(here, '../src') },
    outfile,
    logLevel: 'warning',
  })
  console.log(`--- ${name} ---`)
  const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
