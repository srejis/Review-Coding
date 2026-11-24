const assert = require('node:assert/strict')
const { once } = require('node:events')
const path = require('node:path')
const test = require('node:test')
const { _electron } = require('playwright-core')

const data = process.env.REVIEW_CODING_DATA
const screenshot = process.env.REVIEW_CODING_SCREENSHOTS

async function selectCode(page, revision, profile='') {
  const origin=new URL(page.url()).origin
  const projects=await fetch(origin+'/api/project-catalog').then(response=>response.json())
  const project=projects.find(item=>item.snapshots.some(code=>code.id===revision))
  assert.ok(project)
  await page.evaluate(value=>{
    const key='review-coding-project'
    localStorage.setItem(key,JSON.stringify(value))
    dispatchEvent(new StorageEvent('storage',{key}))
  },{project:project.id,revision,profile})
  await page.getByRole('button',{name:'프로젝트 관리'}).filter({hasText:project.name}).waitFor()
}

test('project management groups revisions, opens history and safely deletes app data', {
  skip: process.env.REVIEW_CODING_TEST_LAYOUT !== 'isolated' && 'Requires a disposable copied data directory.',
  timeout: 60000
}, async () => {
  const {mkdir,readFile,writeFile}=require('node:fs/promises')
  const desktop=await _electron.launch({args:[path.resolve(__dirname,'..')],timeout:25000})
  try {
    const main=await desktop.firstWindow()
    const origin=new URL(main.url()).origin
    const list=()=>fetch(origin+'/api/project-catalog').then(r=>r.json())
    const source=path.join(path.dirname(data),'project-manager-fixture')
    await mkdir(source,{recursive:true})
    const file=path.join(source,'example.py')
    await writeFile(file,'value = 1\n')
    const projectsReady=desktop.waitForEvent('window')
    await main.getByRole('button',{name:'프로젝트 관리'}).click()
    const projects=await projectsReady
    await projects.getByRole('heading',{name:'프로젝트 관리'}).waitFor()
    await desktop.evaluate(({dialog},source)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]})},source)
    await projects.getByRole('button',{name:'프로젝트 등록'}).click()
    const card=projects.locator('.project-card').filter({has:projects.getByRole('heading',{name:path.basename(source),exact:true})})
    await card.waitFor()
    const first=(await list()).find(p=>p.root===source)
    assert.equal(first.snapshots.length,1)
    await writeFile(file,'value = 2\n')
    await projects.getByRole('button',{name:'프로젝트 등록'}).click()
    await card.getByText(/2개 버전/).waitFor()
    assert.equal(await card.count(),1)
    await card.locator('summary').first().click()
    await card.getByText(/이전 코드/).waitFor()
    await card.getByRole('button',{name:'이 코드 보기'}).last().click()
    await main.getByRole('button',{name:'프로젝트 관리'}).filter({hasText:path.basename(source)}).waitFor()
    assert.equal(await main.getByRole('combobox').count(),0)
    assert.equal(await main.locator('.map-primary').count(),1)
    await main.getByRole('button',{name:'분석 시작',exact:true}).waitFor()
    const details=desktop.waitForEvent('window')
    const unit=await fetch(origin+'/api/snapshot?'+new URLSearchParams({revision:first.latest,view:'graph'}))
      .then(response=>response.json()).then(value=>Object.values(value.units)[0])
    await main.evaluate(identity=>window.reviewDesktop.openDetail(identity),
      {revision:first.latest,root:source,profile:'',unit:unit.id})
    const detail=await details
    await detail.getByRole('heading',{name:'example.py',exact:true}).waitFor()
    const closed=detail.waitForEvent('close')
    await card.getByRole('button',{name:'프로젝트 삭제'}).click()
    const confirmation=projects.getByRole('alertdialog')
    await confirmation.getByText(/원본 폴더와 소스 파일은 보존됩니다/).waitFor()
    await confirmation.getByRole('button',{name:'앱 데이터 삭제'}).click()
    await closed
    await card.waitFor({state:'detached'})
    assert.equal(await readFile(file,'utf8'),'value = 2\n')
    assert.ok((await list()).some(project=>project.name==='97_rembg'))
  } finally {await desktop.close().catch(()=>{})}
})

test('Windows Electron uses real snapshots and manages independent detail windows', {
  skip: !data && 'Set REVIEW_CODING_DATA to a data directory containing analyzed check_cases.',
  timeout: 120000
}, async () => {
  const desktop = await _electron.launch({ args: [path.resolve(__dirname, '..')], timeout: 30000,
    env: { ...process.env, REVIEW_CODING_DATA: path.resolve(data) } })
  let origin
  try {
    const main = await desktop.firstWindow()
    await main.emulateMedia({reducedMotion:'reduce'})
    await main.getByRole('heading', { name: 'Review-Coding' }).waitFor()
    origin = new URL(main.url()).origin
    const projects = await fetch(origin + '/api/projects').then(response => response.json())
    const project = projects.find(project => path.basename(project.root) === 'check_cases')
    assert.ok(project, 'Register and analyze check_cases first.')
    await selectCode(main,project.id)
    const load = (profile, view, unit) => fetch(origin + '/api/snapshot?' +
      new URLSearchParams({ revision: project.id, ...(profile ? {profile} : {}), view, ...(unit ? { unit } : {}) }))
      .then(response => response.json())
    const initialView=await load('','graph')
    const initialProfile=initialView.profile
    if (initialView.graph.counts.completed===0 && initialView.graph.counts.partial) {
      await main.getByText(/완료 0 · 부분 제출/).first().waitFor()
      await main.getByRole('textbox',{name:'함수·클래스·파일 검색'}).fill('normalize')
      const partialPromise=desktop.waitForEvent('window')
      await main.getByRole('button',{name:'부분 결과'}).click()
      const partial=await partialPromise
      await partial.getByRole('heading',{name:'normalize',exact:true}).waitFor()
      assert.equal(await partial.locator('.detail-badge').textContent(),'부분 제출')
      await partial.close()
      await main.getByRole('textbox',{name:'함수·클래스·파일 검색'}).fill('')
    }
    const candidates=await Promise.all(initialView.profiles.map(async profile=>({profile,data:await load(profile,'graph')})))
    const completed=candidates.find(({data})=>data.graph.nodes.some(node=>node.name==='normalize') &&
      data.graph.nodes.some(node=>node.name==='append_scores') && data.graph.edges.some(edge=>edge.source!==edge.target))
    assert.ok(completed,'Register a completed normalize and append_scores profile.')
    const profile=completed.profile
    if (profile!==initialProfile) await selectCode(main,project.id,profile)
    const getSnapshot=(view,unit)=>load(profile,view,unit)
    const snapshot=completed.data
    assert.deepEqual(snapshot.files,{})
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
    await main.waitForFunction(()=>{
      const canvas=document.querySelector('canvas')
      if (!canvas?.width || !canvas?.height) return false
      return canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data.some((value,i)=>i%4===3 && value>0)
    })
    const paint=()=>main.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    await main.getByRole('button',{name:'시점 초기화'}).click()
    await paint()
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
    const fileCount=snapshot.graph.nodes.filter(unit=>snapshot.units[unit.id].file===normalize.file).length
    await waitSelection(fileCount)
    const fileCamera=await pixels()
    await main.getByRole('button',{name:'check_cases',exact:true}).click()
    await waitSelection(snapshot.graph.counts.completed)
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

    const choices = initialView.profiles
    const alternative = choices.find(value=>value!==profile &&
      candidates.find(item=>item.profile===value)?.data.graph.nodes.some(node=>node.name==='normalize'))
    if (alternative) {
      await selectCode(main,project.id,alternative)
      const alternateWindow=await open('normalize')
      assert.equal(new URL(alternateWindow.url()).searchParams.get('profile'),alternative)
      assert.equal(new URL(again.url()).searchParams.get('profile'),profile)
      await alternateWindow.close()
    }

    const differentProject = projects.find(candidate => candidate.id !== project.id)
    if (differentProject) {
      await selectCode(main,differentProject.id)
      await waitSelection(0)
      assert.equal(new URL(again.url()).searchParams.get('revision'),project.id)
      assert.equal(await again.locator('.detail-role').textContent(),normalizeData.results[normalize.id].meaning.role)
      await selectCode(main,project.id,profile)
    }

    const dense = projects.find(candidate => path.basename(candidate.root) === '97_rembg')
    if (dense) {
      await selectCode(main,dense.id)
      const denseGraph = await fetch(origin+'/api/snapshot?'+new URLSearchParams({
        revision:dense.id,view:'graph'
      })).then(response=>response.json())
      const all = Object.values(denseGraph.units)
      const folder = all.find(unit=>unit.file.includes('/'))?.file.split('/')[0]
      assert.ok(folder && all.length>=170)
      const visible=new Set(denseGraph.graph.nodes.map(node=>node.id))
      const explorer=main.getByRole('complementary',{name:'파일 탐색기'})
      await explorer.getByRole('button',{name:folder,exact:true}).waitFor()
      const denseBefore=await pixels()
      await explorer.getByRole('button',{name:folder,exact:true}).click()
      const count=all.filter(unit=>unit.file.split('/')[0]===folder && visible.has(unit.id)).length
      await waitSelection(count)
      if (count) await changed(denseBefore)
      else assert.equal(await pixels(),denseBefore)
      await explorer.getByRole('button',{name:folder+' 폴더 펼치기·접기'}).click()
      const choice = all.find(unit=>unit.file.split('/')[0]===folder)
      await explorer.getByRole('searchbox',{name:'파일·폴더 검색'}).fill(choice.file)
      await explorer.locator('button[title]').filter({hasText:path.basename(choice.file)}).last().click()
      await waitSelection(all.filter(unit=>unit.file===choice.file && visible.has(unit.id)).length)
      assert.equal(await main.locator('.map-selection').count(),0)
      if (screenshot) await main.screenshot({path:path.join(screenshot,'review-coding-rembg-tree.png')})
      await selectCode(main,project.id,profile)
    }

    if (screenshot) {
      await main.screenshot({path:path.join(screenshot,'review-coding-graph.png')})
      await b.evaluate(()=>window.scrollTo(0,0))
      await b.screenshot({path:path.join(screenshot,'review-coding-meaning.png'),fullPage:true})
    }
    const progressOpened=desktop.waitForEvent('window')
    await main.locator('.map-primary').click()
    const progressWindow=await progressOpened
    const management=desktop.waitForEvent('window')
    await progressWindow.getByRole('button',{name:'검수·실행 기록·내보내기'}).click()
    const control=await management
    await control.getByRole('button',{name:'분석 관리'}).waitFor()
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
      const progress=progressWindow
      await progress.getByText('현재 설정으로 별도 실행',{exact:true}).click()
      await progress.getByRole('button',{name:'새 설정으로 분석 시작',exact:true}).click()
      await progress.getByText('실행 오류',{exact:true}).waitFor()
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

test('late snapshot responses are isolated and coordinates survive restart or cache damage', {
  skip: process.env.REVIEW_CODING_TEST_LAYOUT !== 'isolated' && 'Requires a disposable copied data directory.',
  timeout: 90000
}, async ()=>{
  const {readFile,writeFile}=require('node:fs/promises')
  const {createHash}=require('node:crypto')
  const start=()=>_electron.launch({args:[path.resolve(__dirname,'..')],timeout:25000})
  let desktop=await start()
  try {
    let main=await desktop.firstWindow()
    const origin=new URL(main.url()).origin
    const projects=await fetch(origin+'/api/projects').then(response=>response.json())
    const samples=projects.find(project=>path.basename(project.root)==='check_cases')
    const other=projects.find(project=>path.basename(project.root)==='97_rembg')
    assert.ok(samples && other)
    let lock, unblock
    const held=new Promise(resolve=>{lock=resolve})
    const gate=new Promise(resolve=>{unblock=resolve})
    const match=url=>url.pathname==='/api/snapshot' && url.searchParams.get('revision')===samples.id &&
      url.searchParams.get('view')==='graph'
    await selectCode(main,other.id)
    await main.locator('.map-footer').getByText(/173개 단위/).waitFor()
    await main.route(match,async route=>{
      const response=await route.fetch()
      lock()
      await gate
      await route.fulfill({response}).catch(()=>{})
    },{times:1})
    await selectCode(main,samples.id)
    await held
    await selectCode(main,other.id)
    await main.locator('.map-footer').getByText(/173개 단위/).waitFor()
    unblock()
    const profile=(await fetch(origin+'/api/snapshot?'+new URLSearchParams({revision:other.id,view:'graph'}))
      .then(response=>response.json())).profile
    const query=new URLSearchParams({revision:other.id,profile,view:'graph'})
    const snapshot=await fetch(origin+'/api/snapshot?'+query).then(response=>response.json())
    const ids=snapshot.graph.nodes.map(node=>node.id).sort()
    assert.ok(ids.length)
    const {total,completed,partial}=snapshot.graph.counts
    const status=new RegExp(total+'개 단위 · 완료 '+completed+' · 부분 제출 '+partial)
    const key=JSON.stringify([other.root,other.id,profile,'incremental-v1'])
    const cache=path.join(data,'graph-layouts',createHash('sha256').update(key).digest('hex')+'.json')
    async function cached() {
      for (let i=0;i<120;i++) {
        const value=await readFile(cache,'utf8').then(JSON.parse).catch(()=>null)
        if (value && JSON.stringify(Object.keys(value.positions).sort())===JSON.stringify(ids)) return value
        await new Promise(resolve=>setTimeout(resolve,70))
      }
      throw new Error('Saved coordinates could not be loaded.')
    }
    const previous=await cached()
    assert.match(await main.locator('.map-footer').textContent(),status)
    await desktop.close()

    desktop=await start()
    main=await desktop.firstWindow()
    await selectCode(main,other.id)
    await main.locator('.map-footer').getByText(status).waitFor()
    await main.waitForFunction(()=>{
      const canvas=document.querySelector('canvas')
      return canvas?.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data.some((value,i)=>i%4===3&&value)
    })
    assert.deepEqual(await cached(),previous)
    await desktop.close()

    await writeFile(cache,'{damaged cache','utf8')
    desktop=await start()
    main=await desktop.firstWindow()
    await selectCode(main,other.id)
    await main.locator('.map-footer').getByText(status).waitFor()
    assert.deepEqual(Object.keys((await cached()).positions).sort(),ids)
  } finally {
    await desktop.close().catch(()=>{})
  }
})

test('Windows Electron applies all three themes to existing windows and restores preferences', {
  skip: process.env.REVIEW_CODING_TEST_THEME !== 'isolated' && 'Requires a disposable copied data directory.',
  timeout: 120000
}, async () => {
  const {readFile,writeFile,unlink}=require('node:fs/promises')
  const file=path.join(data,'desktop-settings.json')
  const start=()=>_electron.launch({args:[path.resolve(__dirname,'..')],timeout:25000})
  const appearance=(page,theme)=>page.waitForFunction(value=>document.documentElement.dataset.theme===value,theme)
  const shot=(page,name)=>screenshot && page.screenshot({path:path.join(screenshot,name+'.png')})
  await unlink(file).catch(error=>{if (error.code!=='ENOENT') throw error})
  let desktop=await start()
  try {
    await appearance(await desktop.firstWindow(),'editorial')
    await desktop.close()
    const legacy={model:'gpt-6-luna',effort:'high',compactExplorer:true}
    await writeFile(file,JSON.stringify(legacy))
    desktop=await start()
    const main=await desktop.firstWindow()
    await main.emulateMedia({reducedMotion:'reduce'})
    const origin=new URL(main.url()).origin
    const project=(await fetch(origin+'/api/projects').then(r=>r.json()))
      .find(project=>path.basename(project.root)==='check_cases')
    await selectCode(main,project.id)
    const profiles=(await fetch(origin+'/api/snapshot?'+new URLSearchParams({revision:project.id,view:'graph'}))
      .then(response=>response.json())).profiles
    let snapshot
    for (const profile of profiles) {
      const query=new URLSearchParams({revision:project.id,profile,view:'graph'})
      const candidate=await fetch(origin+'/api/snapshot?'+query).then(r=>r.json())
      if (['normalize','append_scores'].every(name=>candidate.graph.nodes.some(unit=>unit.name===name)) &&
          candidate.graph.edges.length) {snapshot=candidate;break}
    }
    assert.ok(snapshot)
    await selectCode(main,project.id,snapshot.profile)
    await main.locator('.map-footer').getByText(/완료 [1-9]/).waitFor()
    assert.deepEqual(await main.evaluate(()=>window.reviewDesktop.preferences()),{...legacy,theme:'editorial'})
    assert.deepEqual(JSON.parse(await readFile(file,'utf8')),legacy)
    const open=async (action)=>{
      const pending=desktop.waitForEvent('window')
      await action()
      return pending
    }
    const detail=name=>open(()=>main.evaluate(identity=>window.reviewDesktop.openDetail(identity),{
      root:snapshot.root,revision:project.id,profile:snapshot.profile,
      unit:snapshot.graph.nodes.find(unit=>unit.name===name).id
    }))
    const a=await detail('normalize'), b=await detail('append_scores')
    for (const page of [a,b]) await page.getByRole('button',{name:/원본 L/}).first().click()
    const picked=await a.locator('.evidence-line').allTextContents()
    const original=await a.locator('.detail-source code').allTextContents()
    const unit=Object.values(snapshot.units).find(unit=>unit.name==='normalize')
    const unitQuery=new URLSearchParams({revision:project.id,profile:snapshot.profile,view:'unit',unit:unit.id})
    const unitData=await fetch(origin+'/api/snapshot?'+unitQuery).then(r=>r.json())
    assert.deepEqual(original, unitData.files[unit.file].split(/\r?\n/).map(line=>line || ' '))
    const progress=await open(()=>main.evaluate(revision=>window.reviewDesktop.openProgress(revision),project.id))
    const management=await open(()=>main.evaluate(()=>window.reviewDesktop.openManagement()))
    let analyzeRequests=0
    for (const page of [main,a,b,progress,management]) page.on('request',request=>{
      if (/\/api\/(analyze|cancel)$/.test(request.url()) && request.method()==='POST') analyzeRequests++
    })
    await progress.route('**/api/analysis?*',async route=>{
      const state=await route.fetch().then(response=>response.json())
      await route.fulfill({json:{...state,state:'running',
        live:{revision:project.id,current_unit:'normalize',phase:'SEMANTICIZING'}}})
    })
    await progress.getByRole('status').filter({hasText:'분석 중'}).waitFor()
    await progress.getByRole('button',{name:'분석 중단',exact:true}).waitFor()
    const settings=await open(()=>main.evaluate(()=>window.reviewDesktop.openSettings()))
    await settings.getByRole('button',{name:'테마',exact:true}).click()
    await settings.getByRole('radio',{name:/Editorial/}).isChecked().then(checked=>assert.ok(checked))
    await shot(settings,'theme-settings')
    await settings.getByRole('radio',{name:/Spatial/}).check()
    await appearance(main,'editorial')
    await settings.close()
    assert.equal(JSON.parse(await readFile(file,'utf8')).theme,undefined)
    const picker=await open(()=>main.evaluate(()=>window.reviewDesktop.openSettings()))
    await picker.getByRole('button',{name:'테마',exact:true}).click()
    await picker.getByRole('radio',{name:/Editorial/}).isChecked().then(checked=>assert.ok(checked))
    const canvas=main.locator('canvas')
    const search=main.getByRole('textbox',{name:'함수·클래스·파일 검색'})
    await search.fill('normalize')
    await search.press('Enter')
    await main.locator('.map-footer').getByText(/선택 1개/).waitFor()
    const bounds=await canvas.boundingBox()
    await main.mouse.move(bounds.x+15,bounds.y+15)
    await main.mouse.wheel(0,-220)
    await main.waitForFunction(()=>document.querySelector('canvas').getContext('2d')
      .getImageData(0,0,document.querySelector('canvas').width,document.querySelector('canvas').height)
      .data.some((value,i)=>i%4===3&&value))
    await main.waitForTimeout(330)
    const pixels=()=>canvas.evaluate(el=>el.toDataURL())
    const initial=await pixels()
    const stableWindowCount=desktop.windows().length
    const {createHash}=require('node:crypto')
    const key=JSON.stringify([snapshot.root,project.id,snapshot.profile,'incremental-v1'])
    const layoutFile=path.join(data,'graph-layouts',createHash('sha256').update(key).digest('hex')+'.json')
    const layout=await readFile(layoutFile,'utf8')
    const surfaces=new Set(), images=new Set()
    const options=[['Editorial','editorial'],['Precision','engineering'],['Spatial','spatial'],['Editorial','editorial']]
    for (const [name,theme] of options) {
      await picker.getByRole('radio',{name:new RegExp(name)}).check()
      await picker.getByRole('button',{name:'설정 저장'}).click()
      await picker.getByText('저장했습니다.').waitFor()
      for (const page of [main,a,b,progress,management,picker]) await appearance(page,theme)
      await main.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
      const control=await main.getByRole('button',{name:'프로젝트 관리'}).evaluate(element=>{
        const style=getComputedStyle(element)
        return {
          color:style.color,
          ink:style.getPropertyValue('--ink').trim()
        }
      })
      const rgb=[...control.ink.matchAll(/[0-9a-f]{2}/gi)].map(pair=>parseInt(pair[0],16))
      assert.equal(control.color,'rgb('+rgb.join(', ')+')')
      surfaces.add(await a.locator('.detail-shell').evaluate(el=>getComputedStyle(el).backgroundColor))
      images.add(await pixels())
      assert.deepEqual(await a.locator('.evidence-line').allTextContents(),picked)
      assert.equal(await main.evaluate(()=>JSON.parse(localStorage.getItem('review-coding-project')).profile),snapshot.profile)
      assert.equal(await readFile(layoutFile,'utf8'),layout)
      assert.equal(desktop.windows().length,stableWindowCount)
      await main.locator('.map-footer').getByText(/선택 1개/).waitFor()
      await progress.getByRole('status').filter({hasText:'분석 중'}).waitFor()
      await shot(main,theme+'-graph')
      if (screenshot) {
        await a.locator('.detail-header').scrollIntoViewIfNeeded()
        await shot(a,theme+'-detail')
        await a.locator('.evidence-line').first().scrollIntoViewIfNeeded()
        await shot(a,theme+'-evidence')
      }
    }
    assert.equal(await pixels(),initial,'Same theme restores the exact camera and canvas')
    assert.equal(surfaces.size,3)
    assert.equal(images.size,3)
    assert.equal(analyzeRequests,0)
    await main.emulateMedia({reducedMotion:'reduce'})
    await main.getByRole('button',{name:'시점 초기화'}).click()
    await main.waitForFunction(()=>matchMedia('(prefers-reduced-motion: reduce)').matches)
    assert.equal(await main.locator('.map-primary').evaluate(el=>getComputedStyle(el).transitionDuration),'0s')
    await picker.getByRole('radio',{name:/Spatial/}).check()
    await picker.getByRole('button',{name:'설정 저장'}).click()
    await appearance(main,'spatial')
    assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{...legacy,theme:'spatial'})
    await desktop.close()
    desktop=await start()
    await appearance(await desktop.firstWindow(),'spatial')
  } finally {
    await desktop.close().catch(()=>{})
  }
})


test('Browser tabs synchronize saved themes through local storage', {
  skip: !process.env.REVIEW_CODING_TEST_BROWSER && 'Set REVIEW_CODING_TEST_BROWSER to an installed Chromium executable.',
  timeout: 60000
}, async () => {
  const {chromium}=require('playwright-core')
  const desktop=await _electron.launch({args:[path.resolve(__dirname,'..')],timeout:25000})
  let browser
  try {
    const main=await desktop.firstWindow()
    const origin=new URL(main.url()).origin
    browser=await chromium.launch({executablePath:process.env.REVIEW_CODING_TEST_BROWSER})
    const context=await browser.newContext()
    const graph=await context.newPage(), settings=await context.newPage()
    const theme=(page,value)=>page.waitForFunction(expected=>document.documentElement.dataset.theme===expected,value)
    await graph.goto(origin)
    assert.equal(await graph.evaluate(()=>Boolean(window.reviewDesktop)),false)
    await theme(graph,'editorial')
    await settings.goto(origin+'/?mode=settings')
    await settings.getByRole('button',{name:'테마',exact:true}).click()
    await settings.getByRole('radio',{name:/Precision/}).check()
    await theme(graph,'editorial')
    await settings.getByRole('button',{name:'설정 저장'}).click()
    await theme(settings,'engineering')
    await theme(graph,'engineering')
    await graph.reload()
    await theme(graph,'engineering')
  } finally {
    if (browser) await browser.close()
    await desktop.close()
  }
})
