import {lazy, Suspense, useEffect, useMemo, useRef, useState} from 'react'
import {createRoot} from 'react-dom/client'
import Graph from './Graph'
import {LAYOUT_VERSION} from './incrementalLayout'
import Explorer from './Explorer'
import {request} from './api'
import type {AnalysisStatus, ProjectRecord, Snapshot} from './api'
import {openProgress, openProjects, openSettings, projectChangeKey, projectSelectionKey, readProjectSelection, usePreferences} from './desktop'
import type {NodeIdentity} from './desktop'
import './style.css'
import './desktop.css'
import './themes.css'
import {browserPreferences,watchPreferences} from './desktop'
import {isTheme} from './theme'

const Detail=lazy(()=>import('./Detail'))
const Management=lazy(()=>import('./Management'))
const Progress=lazy(()=>import('./Progress'))
const Settings=lazy(()=>import('./Settings'))
const Projects=lazy(()=>import('./Projects'))
const mode=new URLSearchParams(location.search)

function navigateWindow(mode:string, identity?:NodeIdentity) {
  window.open('/?'+new URLSearchParams({...identity,mode}),'_blank','noopener')
}

function GraphApp() {
  const [project,setProject]=useState<ProjectRecord>()
  const [revision,setRevision]=useState('')
  const [profile,setProfile]=useState('')
  const [snapshot,setSnapshot]=useState<Snapshot>()
  const [search,setSearch]=useState('')
  const [selected,setSelected]=useState<ReadonlySet<string>>(new Set())
  const [focus,setFocus]=useState(0)
  const [reset,setReset]=useState(0)
  const refreshGraph=useRef(()=>{})
  const generation=useRef(0)
  const [analysis,setAnalysis]=useState<AnalysisStatus>()
  const [error,setError]=useState('')
  const [loaded,setLoaded]=useState(false)
  const preferences=usePreferences(setError)
  const selection=useRef({revision:'',profile:''})

  async function updateProjects() {
    const list=await request<ProjectRecord[]>('/api/project-catalog')
    const saved=readProjectSelection()
    const project=list.find(item=>item.id===saved?.project) || list[0]
    const code=project?.snapshots.find(item=>item.id===saved?.revision) || project?.snapshots[0]
    const revision=code?.id || ''
    const profile=code?.profiles.some(item=>item.id===saved?.profile) ? saved!.profile! : ''
    setProject(project)
    if (selection.current.revision!==revision || selection.current.profile!==profile) {
      selection.current={revision,profile}
      generation.current++
      setRevision(revision);setProfile(profile);setSnapshot(undefined);setAnalysis(undefined)
      setSelected(new Set());setSearch('')
    }
    setLoaded(true)
  }
  useEffect(()=>{
    updateProjects().catch(error=>{setError(error.message);setLoaded(true)})
    const reload=()=>{updateProjects().catch(error=>setError(error.message));refreshGraph.current()}
    const storage=(event:StorageEvent)=>{if ([projectSelectionKey,projectChangeKey].includes(event.key || '')) reload()}
    window.addEventListener('focus',reload)
    window.addEventListener('storage',storage)
    return ()=>{window.removeEventListener('focus',reload);window.removeEventListener('storage',storage)}
  },[])

  useEffect(()=>{
    if (!revision) return
    const epoch=++generation.current
    const abort=new AbortController()
    const query=new URLSearchParams({revision,view:'graph'})
    if (profile) query.set('profile',profile)
    let timer:number|undefined, fetching=false, pending=false
    async function refresh() {
      if (epoch!==generation.current || fetching) return
      fetching=true;pending=false;timer=undefined
      try {
        const response=await fetch('/api/snapshot?'+query,{signal:abort.signal})
        const data=await response.json() as Snapshot & {error?:string}
        if (!response.ok) throw new Error(data.error || response.statusText)
        if (epoch===generation.current && data.graph?.revision===revision &&
            (!profile || data.profile===profile)) {
          setSnapshot(data)
        }
      } catch (error) {
        if (epoch===generation.current && !abort.signal.aborted) setError(String(error))
      } finally {
        fetching=false
        if (pending && epoch===generation.current) queueRefresh()
      }
    }
    function queueRefresh() {
      pending=true
      if (!fetching && timer===undefined) timer=window.setTimeout(refresh,100)
    }
    refreshGraph.current=queueRefresh
    const stream=new EventSource('/api/events?'+new URLSearchParams({revision}))
    stream.onmessage=({data})=>{
      const item=JSON.parse(data)
      const state=item.event.state
      if (state || item.event.tool?.startsWith('submit_')) queueRefresh()
    }
    stream.addEventListener('run',queueRefresh)
    void refresh()
    return ()=>{
      generation.current++
      abort.abort()
      stream.close()
      window.clearTimeout(timer)
      refreshGraph.current=()=>{}
    }
  },[revision,profile])

  useEffect(()=>{
    if (!revision) return
    let active=true
    let timer:number|undefined
    const poll=async()=>{
      try {
        const state=await request<AnalysisStatus>('/api/analysis?'+new URLSearchParams({revision,profile,summary:'1'}))
        if (active) setAnalysis(state)
      } catch (error) {if (active) setError(String(error))}
      if (active) timer=window.setTimeout(poll,1250)
    }
    void poll()
    return ()=>{active=false;window.clearTimeout(timer)}
  },[revision,profile])

  const matches=useMemo(()=>{
    const query=search.trim().toLowerCase()
    if (!query) return []
    return Object.values(snapshot?.units || {}).filter(unit=>[unit.name,unit.file,unit.kind,unit.scope]
      .some(value=>value.toLowerCase().includes(query)))
      .sort((a,b)=>Number(b.name.toLowerCase()===query)-Number(a.name.toLowerCase()===query)).slice(0,12)
  },[snapshot,search])
  const counts=snapshot?.graph?.counts
  const visible=useMemo(()=>new Set(snapshot?.graph?.nodes.map(node=>node.id) || []),[snapshot])
  const visibleSelected=useMemo(()=>new Set([...selected].filter(id=>visible.has(id))),[selected,visible])
  const scope=snapshot && {root:snapshot.root,revision,profile:snapshot.profile,version:LAYOUT_VERSION}
  const quality=analysis?.counts
  const label=analysis?.state==='running'?'분석 중':analysis?.state==='cancelled'?'분석 재개':
    quality && (quality.partial || quality.failed || analysis?.error || analysis?.state==='partial' ||
      (quality.complete && quality.unprocessed))?'분석 확인':
    quality?.complete && quality.complete===quality.total && !Object.keys(analysis?.issues || {}).length?'분석 완료':'분석 시작'
  function selectNodes(ids:string[]) {
    setSelected(new Set(ids))
    setFocus(n=>n+1)
  }
  function choose(id:string|null,toggle:boolean) {
    setSelected(current=>{
      if (!id || !toggle) return new Set(id ? [id] : [])
      const next=new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function searchSelect(id:string) {
    selectNodes([id])
    setSearch('')
  }
  async function open(unit:string) {
    if (!snapshot?.units[unit]) return
    const identity={root:snapshot.root,revision,profile:snapshot.profile,unit}
    try {
      if (window.reviewDesktop) await window.reviewDesktop.openDetail(identity)
      else navigateWindow('detail',identity)
    } catch (error) {setError(String(error))}
  }
  return <main className="map-shell">
    <header className="map-header">
      <div className="map-title"><span className="app-mark" aria-hidden="true">RC</span><h1>Review-Coding</h1></div>
      <div className="map-controls">
        <button aria-label="프로젝트 관리" title="프로젝트 관리" onClick={()=>openProjects().catch(error=>setError(String(error)))}
          >{project?.name || '프로젝트'} <span aria-hidden="true">⌄</span></button>
        <button className="map-primary" disabled={!revision} onClick={()=>openProgress(revision,profile)
          .catch(error=>setError(String(error)))}>{label}</button>
        <button className="icon-button" aria-label="설정" title="설정"
          onClick={()=>openSettings().catch(error=>setError(String(error)))}>⚙</button>
      </div>
    </header>
    <section className="map-tools" aria-label="그래프 탐색">
      <form className="map-search" onSubmit={e=>{e.preventDefault();if (matches[0]) searchSelect(matches[0].id)}}>
        <label htmlFor="node-search" className="sr-only">함수·클래스·파일 검색</label>
        <input id="node-search" placeholder="함수·클래스·파일 검색" value={search}
          onChange={e=>setSearch(e.target.value)} onKeyDown={e=>{if (e.key==='Escape') setSearch('')}}/>
        {!!search.trim() && <div className="map-search-results">
          {matches.length ? matches.map(item=><div className="map-search-item" key={item.id}>
            <button type="button" onClick={()=>searchSelect(item.id)}>
              <strong>{item.name}</strong><small>{item.kind} · {item.file}:{item.line}</small>
            </button>
            {snapshot?.results[item.id]?.status==='partial' && <button type="button" className="partial-link"
              onClick={()=>open(item.id)}>부분 결과</button>}
          </div>) : <p>일치하는 코드 단위가 없습니다.</p>}
        </div>}
      </form>
    </section>
    {error && <div className="map-error" role="alert">{error} <button onClick={()=>{setError('');void updateProjects().catch(e=>setError(e.message));refreshGraph.current()}}>다시 연결</button></div>}
    <div className={'map-workspace'+(preferences.compactExplorer?' compact-explorer':'')}>
      <Explorer key={revision} snapshot={snapshot} selected={selected} select={selectNodes}/>
    <section className="map-stage" aria-label="3D 관계 공간">
      {scope && <button className="map-reset icon-button" aria-label="시점 초기화" title="시점 초기화"
        onClick={()=>setReset(n=>n+1)}>↺</button>}
      {scope && <Graph key={JSON.stringify(scope)} scope={scope} graph={snapshot?.graph} selected={visibleSelected}
        focus={focus} reset={reset} choose={choose} open={open} report={setError}/>}
      {!snapshot && <div className="map-empty">{revision || !loaded?'프로젝트를 불러오는 중…':'Python 프로젝트를 등록해 그래프를 시작하세요.'}</div>}
      {snapshot?.graph && !snapshot.graph.nodes.length && <div className="map-empty">
        <div><strong>{counts?.completed ? '표시할 완료 노드가 없습니다.' : `완료 0 · 부분 제출 ${counts?.partial}`}</strong>
          <p>{counts?.partial ? '부분 결과는 검색 또는 검수 창에서 열 수 있습니다.' :
            '원본 구조 단위의 의미가 완료되면 이 공간에 나타납니다.'}</p>
        </div>
      </div>}
      <div className="map-legend" aria-label="그래프 범례">
        <span><i className="legend-file" aria-hidden="true"/>파일</span>
        <span><i className="legend-call" aria-hidden="true">»</i>호출</span>
        <span><i className="legend-class" aria-hidden="true"/>클래스</span>
        <span><i className="legend-inheritance" aria-hidden="true">∿</i>상속</span>
        <span><i className="legend-function" aria-hidden="true"/>함수·메서드</span>
        <span><i className="legend-contains" aria-hidden="true"/>포함</span>
      </div>
    </section>
    </div>
    <footer className="map-footer">
      <span role="status">{counts?.total || 0}개 단위 · 완료 {counts?.completed || 0} · 부분 제출 {counts?.partial || 0}
        {' · 선택 '+visibleSelected.size+'개 / 대상 '+selected.size+'개'}
        {analysis?.state==='running' ? ' · 분석 중' : ''}</span>
      <span>드래그 회전 · Shift+드래그 이동 · 휠 확대 · Ctrl+클릭 추가 · 더블클릭 상세</span>
    </footer>
  </main>
}

function Root() {
  const [deleted,setDeleted]=useState(false)
  useEffect(()=>{
    const revision=mode.get('revision')
    if (!revision) return
    const onDelete=(event:StorageEvent)=>{
      if (event.key==='review-coding-deleted-revisions' && JSON.parse(event.newValue || '[]').includes(revision)) {
        setDeleted(true)
        window.close()
      }
    }
    window.addEventListener('storage',onDelete)
    return ()=>window.removeEventListener('storage',onDelete)
  },[])
  if (deleted) return <main className="detail-shell"><p>프로젝트가 삭제되었습니다.</p></main>
  if (mode.has('login')) {
    return <main className="detail-shell"><h1>{mode.get('login')==='connected'?'ChatGPT 연결 완료':'ChatGPT 연결 실패'}</h1>
      <p>Review-Coding의 설정 창으로 돌아가세요.</p>
      {mode.get('login')!=='connected' && <p role="alert">{mode.get('login')}</p>}
      {!window.reviewDesktop && <a href="/?mode=settings">설정 화면으로 이동</a>}
    </main>
  }
  return <Suspense fallback={<p className="empty">화면을 불러오는 중…</p>}>
    {mode.get('mode')==='detail'?<Detail/>:mode.get('mode')==='management'?<Management/>:mode.get('mode')==='settings'?<Settings/>:
      mode.get('mode')==='progress'?<Progress/>:mode.get('mode')==='projects'?<Projects/>:<GraphApp/>}
  </Suspense>
}

const appearance=window.reviewDesktop ? mode.get('appearance') : browserPreferences().theme
document.documentElement.dataset.theme=isTheme(appearance)?appearance:'editorial'
watchPreferences(value=>{document.documentElement.dataset.theme=value.theme},console.error)
createRoot(document.getElementById('root')!).render(<Root/>)
