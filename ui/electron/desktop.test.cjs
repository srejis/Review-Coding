const assert = require('node:assert/strict')
const { once } = require('node:events')
const path = require('node:path')
const test = require('node:test')
const { _electron } = require('playwright-core')

const data = process.env.REVIEW_CODING_DATA
const screenshot = process.env.REVIEW_CODING_SCREENSHOTS

test('Windows Electron uses real snapshots and manages independent detail windows', {
  skip: !data && 'Set REVIEW_CODING_DATA to a data directory containing analyzed check_cases.',
  timeout: 120000
}, async () => {
  const desktop = await _electron.launch({ args: [path.resolve(__dirname, '..')], timeout: 30000,
    env: { ...process.env, REVIEW_CODING_DATA: path.resolve(data) } })
  let origin
  try {
    const main = await desktop.firstWindow()
    await main.getByRole('heading', { name: 'Review-Coding' }).waitFor()
    origin = new URL(main.url()).origin
    const projects = await fetch(origin + '/api/projects').then(response => response.json())
    const project = projects.find(project => path.basename(project.root) === 'check_cases')
    assert.ok(project, 'Register and analyze check_cases first.')
    await main.getByRole('combobox', { name: '프로젝트·스냅샷' }).selectOption(project.id)
    const select = main.getByRole('combobox', { name: '분석 프로필' })
    await select.waitFor()
    const profile = await select.inputValue()
    const getSnapshot = (view, unit) => fetch(origin + '/api/snapshot?' +
      new URLSearchParams({ revision: project.id, profile, view, ...(unit ? { unit } : {}) }))
      .then(response => response.json())
    const snapshot = await getSnapshot('graph')
    assert.deepEqual(snapshot.files, {})
    const normalize = Object.values(snapshot.units).find(unit => unit.name === 'normalize')
    const scores = Object.values(snapshot.units).find(unit => unit.name === 'append_scores')
    assert.ok(normalize && scores)
    assert.ok(snapshot.results[scores.id].relations.some(edge => edge.target === normalize.id))
    const normalizeData = await getSnapshot('unit', normalize.id)
    const scoresData = await getSnapshot('unit', scores.id)
    assert.equal(Object.keys(normalizeData.files).length, 1)

    const canvas = main.getByRole('img', { name: 'Interactive 3D code graph' }).or(main.locator('canvas'))
    const pixels = () => canvas.evaluate(el => el.toDataURL())
    await main.getByRole('status').getByText(new RegExp(Object.keys(snapshot.units).length + '개 단위')).waitFor()
    const bounds = await canvas.boundingBox()
    const x=bounds.x+bounds.width*.25, y=bounds.y+bounds.height*.25
    const drag = async (shift=false) => {
      if (shift) await main.keyboard.down('Shift')
      await main.mouse.move(x,y)
      await main.mouse.down()
      await main.mouse.move(x+60,y+40,{steps:5})
      await main.mouse.up()
      if (shift) await main.keyboard.up('Shift')
    }
    const changed = async previous => {
      await main.waitForFunction(value => document.querySelector('canvas').toDataURL() !== value, previous)
    }
    const initial = await pixels()
    await drag()
    await changed(initial)
    const rotated = await pixels()
    await drag(true)
    await changed(rotated)
    const panned = await pixels()
    await main.mouse.move(x,y)
    await main.mouse.wheel(0,-300)
    await changed(panned)
    await main.getByRole('button',{name:'시점 초기화'}).click()
    await main.waitForFunction(value => document.querySelector('canvas').toDataURL() === value, initial)

    const search = main.getByRole('textbox', { name: '함수·클래스·파일 검색' })
    async function choose(name) {
      await search.fill(name)
      await search.press('Enter')
    }
    async function open(name) {
      const pending = desktop.waitForEvent('window')
      await choose(name)
      const window = await pending
      await window.getByRole('heading', { name, exact: true }).waitFor()
      return window
    }
    const a = await open('normalize')
    const b = await open('append_scores')
    assert.notEqual(a,b)
    assert.equal(desktop.windows().length,3)
    for (const [win, id, expected] of [[a,normalize.id,normalizeData],[b,scores.id,scoresData]]) {
      assert.equal(await win.locator('.detail-role').textContent(), expected.results[id].meaning.role)
      assert.deepEqual(await win.locator('.detail-steps p').allTextContents(),
        expected.results[id].meaning.steps.map(step => step.text))
      await win.getByRole('button',{name:'원본 펼치기'}).click()
      await win.locator('.detail-source').waitFor()
      await win.getByRole('button',{name:/원본 L/}).first().click()
      assert.ok(await win.locator('.evidence-line').count())
    }
    await choose('normalize')
    await desktop.waitForEvent('window', {timeout: 500}).then(()=>{
      throw new Error('The same identity opened a duplicate window.')
    }, error=>{if (!String(error).includes('Timeout')) throw error})
    assert.equal(desktop.windows().length,3)

    const focusBounds = await desktop.browserWindow(b)
    const before = await focusBounds.evaluate(win => win.getBounds())
    await focusBounds.evaluate(win => {
      const current=win.getBounds()
      win.setBounds({x:current.x+20,y:current.y+14,width:current.width+64,height:current.height-25})
    })
    const after = await focusBounds.evaluate(win => win.getBounds())
    assert.notEqual(before.width,after.width)
    assert.notEqual(before.x,after.x)
    await a.close()
    assert.equal(desktop.windows().length,2)
    await b.getByRole('heading',{name:'append_scores'}).waitFor()

    // Search centered normalize. Clicking its canvas point reopens the closed window.
    assert.equal(await main.locator('.map-selection strong').textContent(),'normalize')
    const preserved = await pixels()
    const reopened = desktop.waitForEvent('window')
    await canvas.click({position:{x:bounds.width/2,y:bounds.height/2}})
    const again = await reopened
    await again.getByRole('heading', {name:'normalize', exact:true}).waitFor()
    assert.equal(await pixels(),preserved)

    const choices = await select.locator('option').evaluateAll(items=>items.map(item=>item.value))
    const alternative = choices.find(value=>value!==profile)
    if (alternative) {
      await select.selectOption(alternative)
      await main.waitForFunction(value =>
        document.querySelector('[aria-label="분석 프로필"]')?.value === value, alternative)
      const alternateWindow=await open('normalize')
      assert.equal(new URL(alternateWindow.url()).searchParams.get('profile'),alternative)
      assert.equal(new URL(again.url()).searchParams.get('profile'),profile)
      await alternateWindow.close()
    }

    const differentProject = projects.find(candidate => candidate.id !== project.id)
    if (differentProject) {
      await main.getByRole('combobox', {name:'프로젝트·스냅샷'}).selectOption(differentProject.id)
      await main.waitForFunction(() => document.querySelector('.map-selection') === null)
      assert.equal(new URL(again.url()).searchParams.get('revision'),project.id)
      assert.equal(await again.locator('.detail-role').textContent(),normalizeData.results[normalize.id].meaning.role)
      await main.getByRole('combobox', {name:'프로젝트·스냅샷'}).selectOption(project.id)
      await select.waitFor()
    }

    if (screenshot) {
      await main.screenshot({path:path.join(screenshot,'review-coding-graph.png')})
      await b.evaluate(()=>window.scrollTo(0,0))
      await b.screenshot({path:path.join(screenshot,'review-coding-meaning.png'),fullPage:true})
    }
    const management=desktop.waitForEvent('window')
    await main.getByRole('button',{name:'분석·검수 관리'}).click()
    const control=await management
    await control.getByRole('button',{name:'분석·재개'}).waitFor()
    assert.equal(await control.getByRole('combobox',{name:'모델',exact:true}).inputValue(),'gpt-6-luna')
    assert.equal(await control.getByRole('combobox',{name:'추론',exact:true}).inputValue(),'medium')
    await control.getByRole('link',{name:'JSON 내보내기'}).waitFor()

    const end=once(desktop.process(),'exit')
    await main.close().catch(()=>{})
    await end
    assert.equal(desktop.windows().length,0)
    await assert.rejects(fetch(origin+'/api/projects'))
  } finally {
    await desktop.close().catch(()=>{})
  }
})
