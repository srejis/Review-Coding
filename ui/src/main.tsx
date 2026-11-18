import {lazy, Suspense, useEffect, useMemo, useState} from 'react'
import {createRoot} from 'react-dom/client'
import Graph from './Graph'
import {request} from './api'
import type {Project, Run, Snapshot} from './api'
import {profileLabel} from './desktop'
import type {NodeIdentity} from './desktop'
import './style.css'
import './desktop.css'

const Detail=lazy(()=>import('./Detail'))
const Management=lazy(()=>import('./Management'))
const mode=new URLSearchParams(location.search)

function navigateWindow(mode:string, identity?:NodeIdentity) {
  window.open('/?'+new URLSearchParams({...identity,mode}),'_blank','noopener')
}

function GraphApp() {
  const [projects,setProjects]=useState<Project[]>([])
  const [revision,setRevision]=useState('')
  const [profile,setProfile]=useState('')
  const [snapshot,setSnapshot]=useState<Snapshot>()
  const [search,setSearch]=useState('')
  const [selected,setSelected]=useState('')
  const [focus,setFocus]=useState(0)
  const [reset,setReset]=useState(0)
  const [refresh,setRefresh]=useState(0)
  const [run,setRun]=useState<Run>()
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const [loaded,setLoaded]=useState(false)

  async function updateProjects() {
    const list=await request<Project[]>('/api/projects')
    setProjects(list)
    setRevision(current=>current || list[0]?.id || '')
    setLoaded(true)
  }
  useEffect(()=>{
    updateProjects().catch(error=>{setError(error.message);setLoaded(true)})
    const reload=()=>{updateProjects().catch(error=>setError(error.message));setRefresh(v=>v+1)}
    window.addEventListener('focus',reload)
    return ()=>window.removeEventListener('focus',reload)
  },[])

  useEffect(()=>{
    if (!revision) return
    let active=true
    const query=new URLSearchParams({revision,view:'graph'})
    if (profile) query.set('profile',profile)
    request<Snapshot>('/api/snapshot?'+query).then(data=>{
      if (active) setSnapshot(data)
    }).catch(error=>{
      if (active) setError(error.message)
    })
    return ()=>{active=false}
  },[revision,profile,refresh])

  useEffect(()=>{
    if (!revision) return
    let timeout:number|undefined
    const stream=new EventSource('/api/events?'+new URLSearchParams({revision}))
    stream.onmessage=({data})=>{
      const {event}=JSON.parse(data)
      if (event.state || event.tool?.startsWith('submit_')) {
        window.clearTimeout(timeout)
        timeout=window.setTimeout(()=>setRefresh(n=>n+1),250)
      }
    }
    stream.addEventListener('run',event=>setRun(JSON.parse(event.data)))
    return ()=>{stream.close();window.clearTimeout(timeout)}
  },[revision])

  const matches=useMemo(()=>{
    const query=search.trim().toLowerCase()
    if (!query) return []
    return Object.values(snapshot?.units || {}).filter(unit=>[unit.name,unit.file,unit.kind,unit.scope]
      .some(value=>value.toLowerCase().includes(query)))
      .sort((a,b)=>Number(b.name.toLowerCase()===query)-Number(a.name.toLowerCase()===query)).slice(0,12)
  },[snapshot,search])
  const node=snapshot?.units[selected]
  const counts=Object.values(snapshot?.results || {})
  const current=node && snapshot?.results[node.id]
  const currentTask=node && snapshot?.tasks[node.id]
  const unmapped=current?.relations.filter(edge=>!edge.target && edge.certainty!=="confirmed").length || 0
  const pending=Object.values(snapshot?.tasks || {}).filter(task=>['CONNECTING','SEMANTICIZING','WAITING_DEPENDENCIES'].includes(task.state)).length

  function selectRevision(id:string) {
    setRevision(id);setProfile('');setSnapshot(undefined);setSelected('');setSearch('');setRun(undefined)
    setReset(n=>n+1)
  }
  async function registerProject() {
    if (!window.reviewDesktop) {
      navigateWindow('management')
      return
    }
    setError('')
    setBusy(true)
    try {
      const root=await window.reviewDesktop.pickFolder()
      if (!root) return
      const created=await request<{id:string}>('/api/register',{root})
      await updateProjects()
      selectRevision(created.id)
    } catch (error) { setError(String(error)) }
    finally { setBusy(false) }
  }
  async function choose(unit:string, center=false) {
    if (!snapshot?.units[unit]) return
    setSelected(unit)
    if (center) {
      setFocus(n=>n+1)
      setSearch('')
    }
    const identity={root:snapshot.root,revision,profile:snapshot.profile,unit}
    try {
      if (window.reviewDesktop) await window.reviewDesktop.openDetail(identity)
      else navigateWindow('detail',identity)
    } catch (error) { setError(String(error)) }
  }
  async function manage() {
    const identity=node && snapshot ? {root:snapshot.root,revision,profile:snapshot.profile,unit:node.id} : undefined
    try {
      if (window.reviewDesktop) await window.reviewDesktop.openManagement(identity)
      else navigateWindow('management',identity)
    } catch (error) {setError(String(error))}
  }

  return <main className="map-shell">
    <header className="map-header">
      <div className="map-title"><span className="app-mark" aria-hidden="true">◉</span><h1>Review-Coding</h1></div>
      <div className="map-controls">
        <select aria-label="프로젝트·스냅샷" value={revision} onChange={e=>selectRevision(e.target.value)}>
          <option value="" disabled>프로젝트 선택</option>
          {projects.map(item=><option key={item.id} value={item.id}>{item.root.split(/[\\/]/).at(-1)} · {item.id.slice(0,8)}</option>)}
        </select>
        <button onClick={()=>registerProject()} disabled={busy}>프로젝트 등록</button>
        <button onClick={()=>manage()}>분석·검수 관리</button>
      </div>
    </header>
    <section className="map-tools" aria-label="그래프 탐색">
      <form className="map-search" onSubmit={e=>{e.preventDefault();if (matches[0]) void choose(matches[0].id,true)}}>
        <label htmlFor="node-search" className="sr-only">함수·클래스·파일 검색</label>
        <input id="node-search" placeholder="함수·클래스·파일 검색" value={search}
          onChange={e=>setSearch(e.target.value)} onKeyDown={e=>{if (e.key==='Escape') setSearch('')}}/>
        {!!search.trim() && <div className="map-search-results">
          {matches.length ? matches.map(item=><button type="button" key={item.id} onClick={()=>choose(item.id,true)}>
            <strong>{item.name}</strong><small>{item.kind} · {item.file}:{item.line}</small>
          </button>) : <p>일치하는 코드 단위가 없습니다.</p>}
        </div>}
      </form>
      {!!snapshot?.profiles.length && <select aria-label="분석 프로필" value={snapshot.profile}
        onChange={e=>{setProfile(e.target.value);setSnapshot(undefined)}}>
        {snapshot.profiles.map(item=><option key={item} value={item}>{profileLabel(item)}</option>)}
      </select>}
      <button onClick={()=>setReset(n=>n+1)}>시점 초기화</button>
    </section>
    {error && <div className="map-error" role="alert">{error} <button onClick={()=>{setError('');void updateProjects().catch(e=>setError(e.message));setRefresh(n=>n+1)}}>다시 연결</button></div>}
    <section className="map-stage" aria-label="3D 관계 공간">
      <Graph snapshot={snapshot} selected={selected} focus={focus} reset={reset} choose={choose}/>
      {!snapshot && <div className="map-empty">{revision || !loaded?'프로젝트를 불러오는 중…':'Python 프로젝트를 등록해 그래프를 시작하세요.'}</div>}
      {snapshot && !Object.keys(snapshot.units).length && <div className="map-empty">표시할 Python 코드 단위가 없습니다.</div>}
      {node && <div className="map-selection"><strong>{node.name}</strong><span>{node.file}:{node.line}</span>
        <span>{currentTask?.state==="QUALITY_VERIFIED"?"독립 품질 검증":
          current?.status==="partial"?"부분 제출":current?.status==="submitted"?"의미 제출":
          current?.status==="stale"?"오래된 결과":currentTask?.state || "미분석"}{unmapped ? " · 대상 미확정 "+unmapped+"개" : ""}</span></div>}
      <div className="map-legend" aria-label="그래프 범례">
        <span><i className="node-ready"/>의미 제출</span><span><i className="node-partial"/>부분 제출</span>
        <span><i className="node-new"/>미분석</span><span><i className="node-stale"/>오래됨</span>
        <span><i className="edge-call"/>호출</span><span><i className="edge-other"/>기타 관계</span>
        <span><i className="edge-candidate"/>후보·미해결</span><span><i className="edge-dep"/>의미 선행</span>
      </div>
    </section>
    <footer className="map-footer">
      <span role="status">{Object.keys(snapshot?.units || {}).length}개 단위 · 의미 {counts.filter(r=>r.status==='submitted').length} · 부분 {counts.filter(r=>r.status==='partial').length}
        {run?.state==='running' ? ' · 분석 중' : pending ? ' · 대기 또는 재개 가능 '+pending+'개' : ''}</span>
      <span>드래그 회전 · Shift+드래그 이동 · 휠 확대</span>
    </footer>
  </main>
}

function Root() {
  if (mode.has('login')) {
    return <main className="detail-shell"><h1>{mode.get('login')==='connected'?'ChatGPT 연결 완료':'ChatGPT 연결 실패'}</h1>
      <p>Review-Coding의 분석·검수 관리 창으로 돌아가세요.</p>
      {mode.get('login')!=='connected' && <p role="alert">{mode.get('login')}</p>}
      {!window.reviewDesktop && <a href="/?mode=management">관리 화면으로 이동</a>}
    </main>
  }
  return <Suspense fallback={<p className="empty">화면을 불러오는 중…</p>}>
    {mode.get('mode')==='detail'?<Detail/>:mode.get('mode')==='management'?<Management/>:<GraphApp/>}
  </Suspense>
}

createRoot(document.getElementById('root')!).render(<Root/>)
