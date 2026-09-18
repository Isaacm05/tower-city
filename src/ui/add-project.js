import { fetchProjectFolders, addProject } from '../game/api.js'

export async function showAddProject(onAdded) {
  if (document.querySelector('.add-project-dialog')) return
  const dialog = document.createElement('dialog')
  dialog.className = 'add-project-dialog'
  dialog.setAttribute('aria-labelledby', 'add-project-title')
  dialog.innerHTML = `<form>
    <h2 id="add-project-title">Add a project</h2>
    <p class="project-workspace"></p>
    <fieldset><legend>Project folder</legend>
      <label><input type="radio" name="mode" value="existing" checked> Existing workspace folder</label>
      <label><input type="radio" name="mode" value="new"> Create a new folder</label>
    </fieldset>
    <div class="existing-folder">
      <div class="folder-location"></div>
      <div class="folder-list" aria-label="Workspace folders"></div>
      <p class="folder-selection">Select a folder below the workspace.</p>
    </div>
    <label class="new-folder" hidden>New folder name<input name="name" autocomplete="off" placeholder="my-project"></label>
    <fieldset><legend>Version control</legend>
      <label><input type="checkbox" name="git"> Initialize Git in this folder</label>
      <label><input type="checkbox" name="github"> Create a GitHub repository</label>
    </fieldset>
    <div class="github-options" hidden>
      <label>Repository name<input name="repository" autocomplete="off" placeholder="my-project" pattern="[A-Za-z0-9_.-]+"></label>
      <label>Visibility<select name="visibility"><option value="private">Private</option><option value="public">Public</option></select></label>
      <p>Uses your signed-in GitHub CLI account and connects the origin remote. Files are not committed or pushed.</p>
    </div>
    <p class="project-error" role="alert"></p>
    <div class="project-form-actions"><button type="button" class="btn cancel">Cancel</button><button class="btn primary" type="submit">Add project</button></div>
  </form>`
  document.body.appendChild(dialog)
  const $ = selector => dialog.querySelector(selector)
  const form = $('form')
  const fields = form.elements
  let selected = ''
  let busy = false
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    dialog.classList.add('is-closing')
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      await dialog.animate([
        { opacity: 1, transform: 'translateY(0) scale(1)' },
        { opacity: 0, transform: 'translateY(5px) scale(0.99)' },
      ], { duration: 140, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {})
    }
    dialog.close()
  }
  let loadId = 0
  const error = $('.project-error')
  const sync = () => {
    const creating = fields.mode.value === 'new'
    $('.new-folder').hidden = !creating
    $('.existing-folder').hidden = creating
    fields.name.required = creating
    $('.github-options').hidden = !fields.github.checked
    fields.repository.required = fields.github.checked
    if (fields.github.checked) fields.git.checked = true
    fields.git.disabled = fields.github.checked
    $('button[type="submit"]').disabled = busy || (!creating && !selected)
  }
  const suggestName = () => {
    if (!fields.repository.dataset.edited) fields.repository.value = (fields.mode.value === 'new' ? fields.name.value : selected.split(/[\\/]/).pop() || '').replace(/[^A-Za-z0-9_.-]/g, '-')
  }
  async function browse(folder = '') {
    const id = ++loadId
    error.textContent = ''
    try {
      const result = await fetchProjectFolders(folder)
      if (id !== loadId || !dialog.open) return
      $('.project-workspace').textContent = `Workspace: ${result.workspace}`
      $('.folder-location').textContent = result.current || 'Workspace'
      const list = $('.folder-list')
      list.replaceChildren()
      const button = (text, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = text; b.onclick = fn; return b }
      if (result.parent !== null) list.append(button('↑ Parent folder', () => browse(result.parent)))
      for (const folder of result.folders) {
        const row = document.createElement('div')
        row.className = 'folder-row'
        const choose = button(folder.name, () => {
          selected = folder.path
          $('.folder-selection').textContent = `Selected: ${selected}`
          for (const b of list.querySelectorAll('[aria-pressed]')) b.setAttribute('aria-pressed', 'false')
          choose.setAttribute('aria-pressed', 'true')
          suggestName(); sync()
        })
        choose.setAttribute('aria-pressed', String(selected === folder.path))
        const open = button('Browse →', () => browse(folder.path))
        open.setAttribute('aria-label', `Browse ${folder.name}`)
        row.append(choose, open)
        list.append(row)
      }
      if (!result.folders.length) { const p = document.createElement('p'); p.textContent = 'No subfolders here.'; list.append(p) }
    } catch (e) { error.textContent = `Could not load workspace folders: ${e.message}` }
  }
  form.addEventListener('change', () => { suggestName(); sync() })
  fields.name.addEventListener('input', suggestName)
  fields.repository.addEventListener('input', () => { fields.repository.dataset.edited = 'true' })
  $('.cancel').onclick = close
  dialog.addEventListener('cancel', e => { e.preventDefault(); if (!busy) void close() })
  dialog.addEventListener('close', () => dialog.remove())
  form.onsubmit = async e => {
    e.preventDefault()
    if (busy || closing) return
    const input = { mode: fields.mode.value, folder: selected, name: fields.name.value, git: fields.git.checked, github: fields.github.checked, repository: fields.repository.value, visibility: fields.visibility.value }
    busy = true
    for (const control of form.elements) control.disabled = true
    error.textContent = ''
    $('button[type="submit"]').textContent = 'Adding project…'
    try {
      const result = await addProject(input)
      if (result.warning) {
        error.textContent = result.warning
        $('.cancel').textContent = 'Close'
        $('.cancel').disabled = false
        busy = false
        await onAdded(result)
      } else { await close(); await onAdded(result) }
    } catch (e) {
      error.textContent = e.message
      busy = false
      for (const control of form.elements) control.disabled = false
      $('button[type="submit"]').textContent = 'Add project'
      sync()
    }
  }
  dialog.showModal()
  sync()
  await browse()
}
