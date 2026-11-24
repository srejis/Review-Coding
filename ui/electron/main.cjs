const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { mkdir, readFile, rename, writeFile, unlink } = require('node:fs/promises')
const { createInterface } = require('node:readline')

const themes = require('./themes.json')
const isTheme = theme => typeof theme === 'string' && Object.hasOwn(themes, theme)

app.setName('Review-Coding')
const backendRoot = app.isPackaged ? path.join(process.resourcesPath, 'backend') : path.resolve(__dirname, '..', '..')
const secondary = new Map()
let origin, service, mainWindow, quitting = false

function startService() {
  const localPython = path.join(backendRoot, '.venv', 'Scripts', 'python.exe')
  const python = process.env.REVIEW_CODING_PYTHON || (existsSync(localPython) ? localPython : 'python')
  const args = ['-B', path.join(backendRoot, 'main.py')]
  if (process.env.REVIEW_CODING_DATA) args.push('--data', process.env.REVIEW_CODING_DATA)
  args.push('review', '--port', '0', '--no-browser')
  return new Promise((resolve, reject) => {
    const child = service = spawn(python, args, { cwd: backendRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let diagnostics = ''
    let ready = false
    const fail = error => { clearTimeout(timer); reject(error) }
    const timer = setTimeout(() => {
      child.kill()
      fail(new Error('The Python service did not report readiness.'))
    }, 20000)
    child.stderr.on('data', buffer => { diagnostics = (diagnostics + buffer).slice(-1500) })
    child.on('error', () => fail(new Error('Python could not be started. Check REVIEW_CODING_PYTHON.')))
    child.on('exit', code => {
      fail(new Error(diagnostics.trim() || 'The Python service exited (' + code + ').'))
      if (ready && !quitting) serviceLost()
    })
    createInterface({ input: child.stdout }).on('line', line => {
      if (ready || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(line.trim())) return
      origin = line.trim()
      ready = true
      clearTimeout(timer)
      resolve()
    })
  })
}

async function serviceLost() {
  const answer = await dialog.showMessageBox({
    type: 'error', message: 'Python 분석 서비스 연결이 끊겼습니다.',
    detail: '저장된 분석을 다시 열려면 서비스를 재시작하세요.',
    buttons: ['앱 다시 시작', '닫기'], cancelId: 1
  })
  if (answer.response === 0) app.relaunch()
  app.quit()
}

function permittedPage(value) {
  try {
    const url = new URL(value)
    return url.origin === origin && url.pathname === '/' && !url.username && !url.password
  } catch {
    return false
  }
}

function appWindow(query, sizes, kind) {
  const window = new BrowserWindow({
    ...sizes, minWidth: kind === 'graph' ? 720 : 440, minHeight: 500,
    backgroundColor: themes[preferences.theme].surface,
    show: false, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!permittedPage(url)) event.preventDefault()
  })
  window.webContents.on('will-redirect', (event, url) => {
    if (!permittedPage(url)) event.preventDefault()
  })
  window.once('ready-to-show', () => window.show())
  window.loadURL(origin + '/?' + new URLSearchParams({ ...query, appearance: preferences.theme })).catch(() => {
    if (!quitting && !window.isDestroyed()) {
      window.destroy()
      if (kind === 'graph' && !quitting) serviceLost()
    }
  })
  return window
}

function openSecondary(key, query, sizes, kind) {
  const existing = secondary.get(key)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return
  }
  const window = appWindow(query, sizes, kind)
  secondary.set(key, window)
  window.once('closed', () => secondary.delete(key))
}

function trust(event, kinds) {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame || !permittedPage(frame.url)) {
    throw new Error('Invalid desktop window.')
  }
  const kind = new URL(frame.url).searchParams.get('mode') || 'graph'
  if (!kinds.includes(kind)) throw new Error('This window cannot use that action.')
}

async function local(route, payload) {
  const options = payload ? {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Review-Local': '1' },
    body: JSON.stringify(payload)
  } : {}
  const response = await fetch(origin + route, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || 'The local service could not complete this request.')
  return body
}

async function verifyIdentity(value) {
  if (!value || !['root', 'revision', 'profile', 'unit'].every(key => typeof value[key] === 'string')
      || !/^[0-9a-f]{64}$/.test(value.revision) || !value.unit
      || value.root.length > 8192 || value.profile.length > 4096 || value.unit.length > 4096) {
    throw new Error('Invalid code unit selection.')
  }
  const identity = { root: value.root, revision: value.revision, profile: value.profile, unit: value.unit }
  const item = await local('/api/snapshot?' + new URLSearchParams({ ...identity, view: 'unit' }))
  if (item.root !== identity.root || item.profile !== identity.profile || !Object.hasOwn(item.units, identity.unit)) {
    throw new Error('This code unit is unavailable for the selected snapshot and profile.')
  }
  return identity
}

ipcMain.handle('review:detail', async (event, value) => {
  trust(event, ['graph'])
  const identity = await verifyIdentity(value)
  openSecondary(JSON.stringify(identity), { ...identity, mode: 'detail' }, { width: 710, height: 820 }, 'detail')
})
ipcMain.handle('review:manage', async (event, value) => {
  trust(event, ['graph', 'detail'])
  const identity = value ? await verifyIdentity(value) : undefined
  openSecondary('management:' + JSON.stringify(identity || null),
    { ...identity, mode: 'management' }, { width: 1380, height: 880 }, 'management')
})
ipcMain.handle('review:folder', async event => {
  trust(event, ['graph'])
  const selections = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
  return selections.filePaths[0] || null
})
const defaults = { model: 'gpt-6-luna', effort: 'medium', compactExplorer: false, theme: 'editorial' }
let preferences = defaults
const efforts = new Set(['none','minimal','low','medium','high','xhigh','max','ultra'])
let settingsQueue = Promise.resolve()

function settingsPath() {
  return path.join(process.env.REVIEW_CODING_DATA || app.getPath('userData'), 'desktop-settings.json')
}

function validPreferences(value) {
  return value && typeof value.model === 'string' && /^[a-zA-Z0-9._:-]{1,120}$/.test(value.model)
    && efforts.has(value.effort) && typeof value.compactExplorer === 'boolean'
}

async function loadPreferences() {
  try {
    const value = JSON.parse(await readFile(settingsPath(), 'utf8'))
    if (!validPreferences(value)) throw new Error('Invalid desktop settings file.')
    return { ...value, theme: isTheme(value.theme) ? value.theme : defaults.theme }
  } catch (error) {
    if (error.code === 'ENOENT') return defaults
    console.warn('Could not load desktop settings:', error.message)
    return defaults
  }
}
ipcMain.handle('review:preferences', event => {
  trust(event, ['graph','detail','management','settings','progress'])
  return preferences
})
ipcMain.handle('review:save-preferences', async (event, value) => {
  trust(event, ['settings'])
  if (!validPreferences(value) || !isTheme(value.theme)) throw new Error('Invalid desktop settings.')
  const operation = settingsQueue.then(async () => {
    const file = settingsPath(), temp = file + '.tmp'
    await mkdir(path.dirname(file), { recursive: true })
    const next = { ...preferences, model:value.model, effort:value.effort,
      compactExplorer:value.compactExplorer, theme:value.theme }
    await writeFile(temp, JSON.stringify(next), 'utf8')
    await rename(temp, file)
    preferences = next
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      window.setBackgroundColor(themes[next.theme].surface)
      if (permittedPage(window.webContents.getURL())) window.webContents.send('review:preferences-changed', next)
    }
  })
  settingsQueue = operation.catch(() => {})
  await operation
})
function layoutFile(scope) {
  if (!scope || typeof scope.root !== 'string' || scope.root.length > 8192 ||
      typeof scope.revision !== 'string' || !/^[0-9a-f]{64}$/.test(scope.revision) ||
      typeof scope.profile !== 'string' || scope.profile.length > 4096 ||
      typeof scope.version !== 'string' || !/^[a-z0-9-]{1,40}$/.test(scope.version)) {
    throw new Error('Invalid graph layout scope.')
  }
  const key = JSON.stringify([scope.root, scope.revision, scope.profile, scope.version])
  const hash = createHash('sha256').update(key).digest('hex')
  return path.join(path.dirname(settingsPath()), 'graph-layouts', hash + '.json')
}

function cleanLayout(cache) {
  if (!cache || !cache.positions || typeof cache.positions !== 'object' ||
      Array.isArray(cache.positions) || !Array.isArray(cache.pairs)) return null
  const entries = Object.entries(cache.positions)
  if (entries.length > 20000 || cache.pairs.length > 160000) return null
  const positions = Object.create(null)
  for (const [id, point] of entries) {
    if (!id || id.length > 4096 || !point ||
        !['x','y','z'].every(axis=>Number.isFinite(point[axis]) && Math.abs(point[axis]) <= 1e6)) continue
    positions[id] = { x:point.x, y:point.y, z:point.z }
  }
  const pairs = cache.pairs.filter(pair=>Array.isArray(pair) && pair.length === 2 &&
    pair.every(id=>typeof id === 'string' && Object.hasOwn(positions,id)))
  return { positions, pairs }
}

ipcMain.handle('review:load-layout', async (event, scope) => {
  trust(event, ['graph'])
  const file = layoutFile(scope)
  try { return cleanLayout(JSON.parse(await readFile(file,'utf8'))) }
  catch { return null }
})
ipcMain.handle('review:save-layout', async (event, scope, value) => {
  trust(event, ['graph'])
  const file = layoutFile(scope)
  const cache = cleanLayout(value)
  if (!cache) throw new Error('Invalid graph layout.')
  const temp = file + '.' + randomUUID() + '.tmp'
  await mkdir(path.dirname(file), { recursive:true })
  try {
    await writeFile(temp, JSON.stringify(cache), 'utf8')
    await rename(temp,file)
  } finally {
    await unlink(temp).catch(()=>{})
  }
})
ipcMain.handle('review:settings', event => {
  trust(event, ['graph','management','detail','progress'])
  openSecondary('settings', { mode:'settings' }, { width:630, height:690 }, 'settings')
})
ipcMain.handle('review:progress', async (event, revision) => {
  trust(event, ['graph','management','detail'])
  if (typeof revision !== 'string' || !/^[0-9a-f]{64}$/.test(revision)) {
    throw new Error('Invalid analysis snapshot.')
  }
  const projects = await local('/api/projects')
  if (!projects.some(project => project.id === revision)) throw new Error('Unknown analysis snapshot.')
  openSecondary('progress:'+revision, {mode:'progress',revision}, { width:655, height:620 }, 'progress')
})
ipcMain.handle('review:login', async (event, account) => {
  trust(event, ['management','settings'])
  if (account !== undefined && (typeof account !== 'string' || account.length > 512)) {
    throw new Error('Invalid ChatGPT registration.')
  }
  const { url } = await local('/api/login', { account })
  const external = new URL(url)
  if (external.origin !== 'https://auth.openai.com' || external.pathname !== '/api/accounts/authorize'
      || external.username || external.password) throw new Error('Unexpected OAuth destination.')
  await shell.openExternal(external.href)
})

app.whenReady().then(async () => {
  app.on('web-contents-created', (_, contents) => {
    contents.on('will-attach-webview', event => event.preventDefault())
  })
  try {
    preferences = await loadPreferences()
    await startService()
  } catch (error) {
    dialog.showErrorBox('Review-Coding 시작 실패',
      error.message + '\n\nPython 의존성을 설치하고 UI를 빌드한 뒤 다시 시작하세요.')
    app.quit()
    return
  }
  mainWindow = appWindow({ mode: 'graph' }, { width: 1360, height: 880 }, 'graph')
  mainWindow.once('closed', () => app.quit())
})
app.on('before-quit', () => {
  quitting = true
  for (const window of secondary.values()) if (!window.isDestroyed()) window.destroy()
  if (service && service.exitCode === null) service.kill()
})
app.on('window-all-closed', () => app.quit())
