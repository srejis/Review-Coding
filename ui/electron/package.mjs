import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { packager } from '@electron/packager'

const ui = fileURLToPath(new URL('../', import.meta.url))
const root = path.resolve(ui, '..')
const tempRoot = path.resolve(os.tmpdir())
const staging = await mkdtemp(path.join(tempRoot, 'review-coding-package-'))
const appDir = path.join(staging, 'app')
const backend = path.join(staging, 'backend')
const dependencies = JSON.parse(await readFile(path.join(ui, 'package.json'), 'utf8'))

try {
  await mkdir(appDir)
  await cp(path.join(ui, 'electron'), path.join(appDir, 'electron'), { recursive: true,
    filter: filename => !filename.endsWith('package.mjs') && !filename.endsWith('desktop.test.cjs') })
  await writeFile(path.join(appDir, 'package.json'), JSON.stringify({
    name: 'review-coding', version: dependencies.version, main: 'electron/main.cjs'
  }))
  await mkdir(path.join(backend, 'ui'), { recursive: true })
  const backendFiles = ['main.py', 'review_server.py', 'graph_view.py', 'source.py', 'source_relations.py', 'agent.py', 'mcp_tools.py',
    'dependency_scheduler.py', 'dependency_store.py', 'chatgpt_auth.py', 'responses.py', 'requirements.txt']
  for (const file of backendFiles) await cp(path.join(root, file), path.join(backend, file))
  await cp(path.join(ui, 'dist'), path.join(backend, 'ui', 'dist'), { recursive: true })
  const output = await packager({
    dir: appDir, out: path.join(ui, 'release'), name: 'Review-Coding',
    platform: 'win32', arch: process.arch, electronVersion: dependencies.devDependencies.electron,
    extraResource: [backend], asar: true, prune: false
  })
  console.log(output.join('\n'))
} finally {
  if (path.dirname(staging) === tempRoot && path.basename(staging).startsWith('review-coding-package-')) {
    await rm(staging, { recursive: true, force: true })
  }
}
