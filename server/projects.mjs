import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const inside = (root, dir) => { const rel = path.relative(root, dir); return rel && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel) }

export function projectStore({ workspace = process.env.BOT_CROSSING_WORKSPACE || path.resolve(here, '../..'), data = process.env.BOT_CROSSING_DATA || path.resolve(here, '../data'), run = async (cmd, args, cwd) => (await exec(cmd, args, { cwd, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } })).stdout.trim() } = {}) {
  const file = path.join(data, 'projects.json')
  let queue = Promise.resolve()
  async function list() {
    try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return []; throw e }
  }
  async function folder(root, relative) {
    if (typeof relative !== 'string' || !relative.trim() || path.isAbsolute(relative)) throw new Error('Choose a folder inside the workspace.')
    const dir = await fs.realpath(path.resolve(root, relative))
    if (!inside(root, dir) || !(await fs.stat(dir)).isDirectory()) throw new Error('Choose a folder inside the workspace.')
    return dir
  }
  async function options(relative = '') {
    const root = await fs.realpath(workspace)
    const current = relative ? await folder(root, relative) : root
    const entries = await fs.readdir(current, { withFileTypes: true })
    const folders = []
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      try { const dir = await folder(root, path.relative(root, path.join(current, entry.name))); folders.push({ name: entry.name, path: path.relative(root, dir) }) } catch { /* files and links outside workspace */ }
    }
    folders.sort((a, b) => a.name.localeCompare(b.name))
    return { workspace: root, current: path.relative(root, current), parent: same(root, current) ? null : path.relative(root, path.dirname(current)), folders }
  }
  async function add(input) {
    const root = await fs.realpath(workspace)
    if (!['existing', 'new'].includes(input.mode)) throw new Error('Choose an existing folder or a new folder.')
    if (input.github && !['private', 'public'].includes(input.visibility)) throw new Error('Choose GitHub visibility.')
    const name = input.name?.trim()
    if (input.github && (!/^[A-Za-z0-9_.-]+$/.test(input.repository || '') || ['.', '..'].includes(input.repository))) throw new Error('Enter a valid GitHub repository name.')
    if (input.mode === 'new' && (!name || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || name.startsWith('.'))) throw new Error('Enter a valid new folder name.')
    // Check tools/auth before creating anything on disk.
    if (input.git || input.github) {
      try { await run('git', ['--version'], root) }
      catch { throw new Error('Git is unavailable. Install Git and restart Bot Crossing, or turn off repository setup.') }
    }
    if (input.github) {
      try { await run('gh', ['auth', 'status', '--hostname', 'github.com'], root) }
      catch { throw new Error('GitHub CLI is unavailable or not signed in. Install gh, run gh auth login, then try again.') }
    }
    let dir
    if (input.mode === 'new') {
      dir = path.join(root, name)
      await fs.mkdir(dir) // Never silently reuse an existing folder.
    } else dir = await folder(root, input.folder)
    const projects = await list()
    let project = projects.find(p => same(p.path, dir))
    if (!project) { project = { name: path.basename(dir), path: dir }; projects.push(project) }
    let warning = ''
    try {
      if (input.git || input.github) {
        if (!(await fs.stat(path.join(dir, '.git')).catch(() => null))) await run('git', ['init', '--initial-branch=main'], dir)
      }
      if (input.github) {
        const origin = await run('git', ['remote', 'get-url', 'origin'], dir).catch(() => '')
        if (origin) throw new Error('This folder already has an origin remote; it was kept unchanged.')
        await run('gh', ['repo', 'create', input.repository, `--${input.visibility}`, '--source', dir, '--remote', 'origin'], dir)
      }
    } catch (e) { warning = `Project added, but repository setup needs attention: ${e.message}` }
    await fs.mkdir(data, { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await fs.writeFile(temp, JSON.stringify(projects, null, 2))
    await fs.rename(temp, file)
    return { project, warning }
  }
  return { list, options, add: input => (queue = queue.then(() => add(input), () => add(input))) }
}
