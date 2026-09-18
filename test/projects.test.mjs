import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { projectStore } from '../server/projects.mjs'
import { disambiguateProjects } from '../server/scan.mjs'

async function fixture(t, run = async () => '') {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'crossing-projects-'))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const workspace = path.join(temp, 'workspace')
  const data = path.join(temp, 'data')
  await fs.mkdir(workspace)
  return { workspace, data, store: projectStore({ workspace, data, run }) }
}
test('new and existing projects persist without duplicate entries', async t => {
  const { store, workspace, data } = await fixture(t)
  const created = await store.add({ mode: 'new', name: 'My project' })
  assert.equal(created.project.path, path.join(workspace, 'My project'))
  await Promise.all([store.add({ mode: 'existing', folder: 'My project' }), store.add({ mode: 'existing', folder: 'My project' })])
  assert.equal((await projectStore({ workspace, data }).list()).length, 1)
  await assert.rejects(store.add({ mode: 'new', name: 'My project' }), /EEXIST/)
})
test('workspace browsing and add reject traversal, files and invalid names', async t => {
  const { store, workspace } = await fixture(t)
  await fs.mkdir(path.join(workspace, 'parent', 'child'), { recursive: true })
  await fs.writeFile(path.join(workspace, 'file'), '')
  assert.deepEqual((await store.options()).folders.map(f => f.name), ['parent'])
  assert.equal((await store.options('parent')).folders[0].path, path.join('parent', 'child'))
  for (const folder of ['..', '.', 'file', workspace]) await assert.rejects(store.add({ mode: 'existing', folder }))
  for (const name of ['../bad', 'bad/name', 'NUL', 'bad.', '']) await assert.rejects(store.add({ mode: 'new', name }))
})
test('GitHub uses argument arrays, private visibility and no automatic push', async t => {
  const calls = []
  const { store } = await fixture(t, async (cmd, args, cwd) => { calls.push({ cmd, args, cwd }); return '' })
  await store.add({ mode: 'new', name: 'space & folder', github: true, repository: 'my-project', visibility: 'private' })
  assert.ok(calls.some(c => c.cmd === 'git' && c.args[0] === 'init'))
  const gh = calls.find(c => c.args[0] === 'repo')
  assert.deepEqual(gh.args.slice(0, 4), ['repo', 'create', 'my-project', '--private'])
  assert.ok(!gh.args.includes('--push'))
})
test('missing authentication prevents folder creation; later failure preserves project and reports warning', async t => {
  let fail = 'auth'
  const { store, workspace } = await fixture(t, async (cmd, args) => { if (args[0] === fail) throw new Error('Test failure'); return '' })
  const input = { mode: 'new', name: 'example', github: true, repository: 'example', visibility: 'private' }
  await assert.rejects(store.add(input), /gh auth login/)
  await assert.rejects(fs.stat(path.join(workspace, 'example')), /ENOENT/)
  fail = 'repo'
  const result = await store.add(input)
  assert.match(result.warning, /Test failure/)
  assert.equal((await store.list()).length, 1)
})
test('existing origin is preserved and Git init is not repeated', async t => {
  const calls = []
  const { store, workspace } = await fixture(t, async (cmd, args) => { calls.push(args); return args[0] === 'remote' ? 'https://github.com/example/existing.git' : '' })
  await fs.mkdir(path.join(workspace, 'existing', '.git'), { recursive: true })
  const result = await store.add({ mode: 'existing', folder: 'existing', github: true, repository: 'new', visibility: 'public' })
  assert.match(result.warning, /already has an origin/)
  assert.ok(!calls.some(a => ['init', 'repo'].includes(a[0])))
})
test('saved projects and scanned threads share labels without merging distinct folders', () => {
  const result = disambiguateProjects([
    { project: 'app', projectPath: '/workspace/one/app' },
    { project: 'app', projectPath: '/workspace/two/app' },
    { project: 'app', projectPath: '/workspace/one/app' },
  ])
  assert.deepEqual(result.map(p => p.project), ['one/app', 'two/app', 'one/app'])
})
test('junctions and symlinks cannot escape the workspace', async t => {
  const { store, workspace, data } = await fixture(t)
  await fs.mkdir(data)
  await fs.symlink(data, path.join(workspace, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(store.add({ mode: 'existing', folder: 'outside' }), /inside the workspace/)
  assert.deepEqual((await store.options()).folders, [])
})
