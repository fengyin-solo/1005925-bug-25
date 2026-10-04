// 冒烟测试入口：把 scripts 下的用例分别打包成独立进程跑，互不共享内存数据。
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const srcDir = fileURLToPath(new URL('../src', import.meta.url))
const tests = ['scripts/smoke-transfer.ts', 'scripts/smoke-rollback.ts']

for (const test of tests) {
  const outfile = join(tmpdir(), `${test.replaceAll('/', '-')}.mjs`)
  await build({
    entryPoints: [test],
    bundle: true,
    platform: 'node',
    format: 'esm',
    alias: { '@': srcDir },
    outfile,
    logLevel: 'silent',
  })
  const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
