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
    const center={x:bounds.width/2,y:bounds.height/2}
    const selection=main.locator('.map-footer [role=status]')
    const waitSelection=count=>selection.getByText(new RegExp('선택 '+count+'개')).waitFor()
    await main.getByRole('button',{name:'normalize.py',exact:true}).click()
    const fileCount=Object.values(snapshot.units).filter(unit=>unit.file===normalize.file).length
    await waitSelection(fileCount)
    const fileCamera=await pixels()
    await main.getByRole('button',{name:'check_cases',exact:true}).click()
    await waitSelection(Object.keys(snapshot.units).length)
    await changed(fileCamera)
    assert.equal(desktop.windows().length,1)
    await choose('normalize')
    await waitSelection(1)
    await canvas.click({position:center,modifiers:['Control']})
    await waitSelection(0)
    await canvas.click({position:center,modifiers:['Control']})
    await waitSelection(1)
    await canvas.click({position:{x:5,y:5}})
    await waitSelection(0)
    await canvas.click({position:center})
    await waitSelection(1)
    assert.equal(desktop.windows().length,1)
    async function open(name) {
      const pending = desktop.waitForEvent('window')
      await choose(name)
      await canvas.dblclick({position:center})
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
    await canvas.dblclick({position:center})
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

    // Search centered normalize. A double click reopens the closed window.
    await waitSelection(1)
    const preserved = await pixels()
    const reopened = desktop.waitForEvent('window')
    await canvas.dblclick({position:center})
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
      await waitSelection(0)
      assert.equal(new URL(again.url()).searchParams.get('revision'),project.id)
      assert.equal(await again.locator('.detail-role').textContent(),normalizeData.results[normalize.id].meaning.role)
      await main.getByRole('combobox', {name:'프로젝트·스냅샷'}).selectOption(project.id)
      await select.waitFor()
    }

    const dense = projects.find(candidate => path.basename(candidate.root) === '97_rembg')
    if (dense) {
      await main.getByRole('combobox',{name:'프로젝트·스냅샷'}).selectOption(dense.id)
      const denseGraph = await fetch(origin+'/api/snapshot?'+new URLSearchParams({
        revision:dense.id,view:'graph'
      })).then(response=>response.json())
      const all = Object.values(denseGraph.units)
      const folder = all.find(unit=>unit.file.includes('/'))?.file.split('/')[0]
      assert.ok(folder && all.length>=170)
      const {treeCoordinates}=await import('../src/treeLayout.ts')
      const positions=treeCoordinates(all)
      const reversed=treeCoordinates([...all].reverse())
      for (const [id,point] of positions) assert.deepEqual(point,reversed.get(id))
      const [originPoint,...rest]=positions.values()
      const vectors=rest.map(p=>[p.x-originPoint.x,p.y-originPoint.y,p.z-originPoint.z])
      const first=vectors.find(v=>Math.hypot(...v)>0)
      const cross=v=>[first[1]*v[2]-first[2]*v[1],first[2]*v[0]-first[0]*v[2],first[0]*v[1]-first[1]*v[0]]
      const normal=vectors.map(cross).find(v=>Math.hypot(...v)>0)
      assert.ok(normal && vectors.some(v=>Math.abs(v.reduce((sum,n,i)=>sum+n*normal[i],0))>1e-4),
        'The saved rembg units occupy a genuinely non-coplanar layout.')
      const explorer=main.getByRole('complementary',{name:'파일 탐색기'})
      await explorer.getByRole('button',{name:folder,exact:true}).waitFor()
      const denseBefore=await pixels()
      await explorer.getByRole('button',{name:folder,exact:true}).click()
      const count=all.filter(unit=>unit.file.split('/')[0]===folder).length
      await waitSelection(count)
      await changed(denseBefore)
      await explorer.getByRole('button',{name:folder+' 폴더 펼치기·접기'}).click()
      const choice = all.find(unit=>unit.file.split('/')[0]===folder)
      await explorer.getByRole('searchbox',{name:'파일·폴더 검색'}).fill(choice.file)
      await explorer.locator('button[title]').filter({hasText:path.basename(choice.file)}).last().click()
      await waitSelection(all.filter(unit=>unit.file===choice.file).length)
      assert.equal(await main.locator('.map-selection').count(),0)
      if (screenshot) await main.screenshot({path:path.join(screenshot,'review-coding-rembg-tree.png')})
      await main.getByRole('combobox',{name:'프로젝트·스냅샷'}).selectOption(project.id)
      await select.waitFor()
    }

    if (screenshot) {
      await main.screenshot({path:path.join(screenshot,'review-coding-graph.png')})
      await b.evaluate(()=>window.scrollTo(0,0))
      await b.screenshot({path:path.join(screenshot,'review-coding-meaning.png'),fullPage:true})
    }
    const management=desktop.waitForEvent('window')
    await main.getByRole('button',{name:'검수·이력 및 내보내기'}).click()
    const control=await management
    await control.getByRole('button',{name:'분석·재개'}).waitFor()
    assert.equal(await control.getByRole('combobox',{name:'모델',exact:true}).count(),0)
    await control.getByRole('link',{name:'JSON 내보내기'}).waitFor()

    const settingsPromise=desktop.waitForEvent('window')
    await main.getByRole('button',{name:'설정',exact:true}).click()
    const settings=await settingsPromise
    await settings.getByRole('button',{name:'모델',exact:true}).click()
    await settings.getByRole('button',{name:'설정 저장'}).waitFor()
    assert.equal(await settings.getByRole('combobox',{name:'기본 모델'}).inputValue(),'gpt-6-luna')
    assert.equal(await settings.getByRole('combobox',{name:'추론 노력'}).inputValue(),'medium')
    // The test data folder has a DB copy and no credentials. Exercise the real HTTP flow without purchasing inference.
    if (process.env.REVIEW_CODING_TEST_ANALYZE === 'signed-out') {
      await settings.getByRole('combobox',{name:'추론 노력'}).selectOption('high')
      await settings.getByRole('button',{name:'설정 저장'}).click()
      await settings.getByText('저장했습니다.',{exact:false}).waitFor()
      await settings.close()
      const progressPromise=desktop.waitForEvent('window')
      await main.getByRole('button',{name:'분석 시작',exact:true}).click()
      const progress=await progressPromise
      await progress.getByText('분석 실패',{exact:true}).waitFor()
      assert.match(await progress.getByRole('alert').textContent(),/ChatGPT/)
      const run=await fetch(origin+'/api/run').then(response=>response.json())
      assert.equal(run.model,'gpt-6-luna')
      assert.equal(run.effort,'high')
      assert.equal(run.revision,project.id)
    }

    const end=once(desktop.process(),'exit')
    await main.close().catch(()=>{})
    await end
    assert.equal(desktop.windows().length,0)
    await assert.rejects(fetch(origin+'/api/projects'))
  } finally {
    await desktop.close().catch(()=>{})
  }
})
