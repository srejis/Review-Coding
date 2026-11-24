import {useEffect, useRef, useState} from 'react'
import {request,meaningSites} from './api'
import {openProgress, profileLabel} from './desktop'
import type {Project, Result, Run, Snapshot, Trace, Unit} from './api'

const categoryOptions = ['검수 메모','설명 누락','잘못된 연결','너무 추상적','근거 없는 의미']
const certainty: Record<string,string> = { confirmed:'근거 포함 · 모델 확정', candidate:'후보', unresolved:'미해결', external:'외부 경계' }

function SourcePanel({unit, source, lines}: {unit?:Unit; source:string; lines:number[]}) {
  const marked = useRef<HTMLDivElement>(null)
  useEffect(() => { marked.current?.scrollIntoView({block:'nearest'}) }, [lines, unit?.id])
  return <section className="source panel" aria-label="원본 코드">
    <div className="panel-title"><strong>원본 코드</strong><span>{unit?.file || 'Python'}</span></div>
    {unit ? <div className="code" tabIndex={0}>
      {source.split(/\r?\n/).map((line, index) => {
        const number = index + 1
        return <div className={lines.includes(number) ? 'line highlighted' : 'line'} key={number}
          ref={number === lines[0] ? marked : undefined}><span>{number}</span><code>{line || ' '}</code></div>
      })}
    </div> : <div className="empty">분석 단위를 선택하면 원본이 표시됩니다.</div>}
  </section>
}

const taskName:Record<string,string> = {
  NEW:'연결 조사 대기', CONNECTING:'연결 조사 중', WAITING_DEPENDENCIES:'하위 의미 대기',
  READY_TO_SEMANTICIZE:'의미화 준비', SEMANTICIZING:'의미화 중', SEMANTIC_PARTIAL:'부분 제출',
  SEMANTIC_SUBMITTED:'의미 제출 · 미검수', QUALITY_VERIFIED:'독립 품질 검증 완료',
  FAILED:'분석 실패', BLOCKED_DEPENDENCY:'하위 분석 실패로 중단'
}

function Findings({unit, result, snapshot, navigate, highlight}: {
  unit:Unit; result?:Result; snapshot:Snapshot; navigate:(id:string,line?:number)=>void;
  highlight:(lines:number[])=>void
}) {
  const children = Object.values(snapshot.units).filter(child => child.parent === unit.id)
  const incoming = Object.entries(snapshot.results).flatMap(([id, item]) => item.relations
    .filter(edge => edge.target === unit.id && id !== unit.id).map(edge => ({id, edge})))
  const task=snapshot.tasks[unit.id]
  const links=result?.status=== "stale" ? [] : snapshot.connections[unit.id]?.relations || result?.relations || []
  const deps=snapshot.dependencies[unit.id] || []
  return <>
    {task && <div className="edge">
      <strong>{taskName[task.state] || task.state}</strong>
      {task.stale && <p>하위 의미 또는 원본이 바뀌어 재분석이 필요합니다.</p>}
      {task.waiting?.length ? <p>대기 중인 하위 단위 {task.waiting.map(id=>
        <button key={id} className="chip" onClick={()=>navigate(id)}>{snapshot.units[id]?.name || id}</button>)}</p> : null}
      {task.path?.length ? <p>탐색 경로 {task.path.map(id=>snapshot.units[id]?.name || id).join(" → ")}</p> : null}
      {task.cycle?.length ? <p>순환 {task.cycle.map(id=>snapshot.units[id]?.name || id).join(" ↔ ")}</p> : null}
    </div>}
    {deps.length > 0 && <><h2>의미화 선행 의존성</h2>{deps.map(id=>
      <button key={id} className="chip" onClick={()=>navigate(id)}>{snapshot.units[id]?.name || id}</button>)}</>}
    {result ? <>
      <h2>역할</h2><p className="role">{result.meaning.role}</p>
      <h2>상세 처리</h2><ol className="steps">
      {result.meaning.steps.map((step,i) => {
        const lines = [...new Set(step.sites.flatMap(id => {
          const line = meaningSites(unit,result).find(site => site.id === id)?.line
          return line === undefined ? [] : [line]
        }))].sort((a,b) => a-b)
        return <li key={i}><button className="step" disabled={result.status==="stale"} onClick={()=>highlight(lines)}>{step.text}
          <small>{lines.map(line => `L${line}`).join(' · ')}</small></button></li>
      })}</ol>
      <p className="muted">구문 대응 {meaningSites(unit,result).length - result.meaning.missing.length}/{meaningSites(unit,result).length} · {task?.state==="QUALITY_VERIFIED" ? "독립 품질 검증 완료" : "의미 정확도 미검수"}</p>
      {result.dependencies?.length ? <><h2>재사용한 하위 의미</h2>{result.dependencies.map(ref=>
        <button key={ref.unit} className="chip" onClick={()=>navigate(ref.unit)}>{snapshot.units[ref.unit]?.name} · {ref.version.slice(0,8)}</button>)}</> : null}
      {result.boundaries?.length ? <><h2>미해결 경계</h2><ul>{result.boundaries.map((boundary,i)=>
        <li key={i}>{boundary.kind==="cycle" ? "순환 내부" : certainty[boundary.kind] || boundary.kind} · {boundary.reason}</li>)}</ul></> : null}
      {result.meaning.unresolved.length > 0 && <><h2>미해결</h2><ul>{result.meaning.unresolved.map((note,i)=><li key={i}>{note}</li>)}</ul></>}
    </> : <p className="empty">이 단위의 의미화 결과가 아직 없습니다.</p>}
    {(result?.status==="stale" || links.length===0) ? null : <>
      <h2>연결 그래프</h2>
      <p className="muted">원본 위치와 조회 이력을 검증합니다. 관계 판정은 모델의 제출입니다.</p>
      <div className="graph-center">{unit.name}</div>
      <div className="edges">{links.map((edge,i)=><article className="edge" key={i}>
        <div className="edge-label"><span>↳ {edge.kind}</span><span className={`certainty ${edge.certainty}`}>{certainty[edge.certainty]}</span></div>
        {edge.target && <button className="link" onClick={()=>navigate(edge.target!)}>{snapshot.units[edge.target]?.scope || edge.target}</button>}
        <p>{edge.reason}</p><div>{edge.evidence.map((ref,j)=><button className="chip" key={j}
          onClick={()=>navigate(ref.unit,ref.line)}>{snapshot.units[ref.unit]?.file}:{ref.line}</button>)}</div>
      </article>)}</div>
    </>}
    {incoming.length > 0 && <><h2>들어오는 연결</h2>{incoming.map(({id,edge},i)=>
      <button className="chip" key={i} onClick={()=>navigate(id)}>{snapshot.units[id]?.name} → {edge.kind}</button>)}</>}
    {children.length > 0 && <><h2>하위 단위</h2>{children.map(child=>
      <button className="chip" key={child.id} onClick={()=>navigate(child.id)}>{child.name} · L{child.line}</button>)}</>}
  </>
}

export default function Management() {
  const initial = new URLSearchParams(window.location.search)
  const [revision,setRevision]=useState('')
  const [snapshot,setSnapshot]=useState<Snapshot>()
  const profile=initial.get('profile') || ''
  const [selected,setSelected]=useState(initial.get('unit') || '')
  const [filter,setFilter]=useState('')
  const [tab,setTab]=useState<'findings'|'events'|'feedback'>('findings')
  const [highlight,setHighlight]=useState<number[]>([])
  const [trace,setTrace]=useState<Trace[]>([])
  const [error,setError]=useState('')
  const [category,setCategory]=useState(categoryOptions[0])
  const [note,setNote]=useState('')
  const [busy,setBusy]=useState(false)
  const [refresh,setRefresh]=useState(0)

  useEffect(() => {
    const chosen=initial.get('revision')
    if (chosen) setRevision(chosen)
    else request<Project[]>('/api/projects').then(rows=>setRevision(rows[0]?.id || '')).catch(e=>setError(e.message))
  }, [])

  useEffect(() => {
    if (!revision) return
    let current=true
    const query=new URLSearchParams({revision})
    if (profile) query.set('profile',profile)
    request<Snapshot>(`/api/snapshot?${query}`).then(value=>{
      if (!current) return
      setSnapshot(value)
      setSelected(previous=>value.units[previous] ? previous : Object.keys(value.units)[0] || '')
    }).catch(e=>{if (current) setError(e.message)})
    return ()=>{current=false}
  }, [revision, profile, refresh])

  useEffect(() => {
    if (!revision) return
    const events=new EventSource(`/api/events?revision=${encodeURIComponent(revision)}`)
    let refreshTimer: number | undefined
    events.onmessage=message=>{
      const item=JSON.parse(message.data) as Trace
      setTrace(items=>[...items.slice(-299),item])
      if (item.event.state && item.event.state === item.event.state.toUpperCase() ||
          item.event.state === "connection_saved" || item.event.tool?.startsWith("submit_")) {
        window.clearTimeout(refreshTimer)
        refreshTimer=window.setTimeout(()=>setRefresh(value=>value+1),350)
      }
    }
    events.addEventListener('run', event=>{
      const state=JSON.parse(event.data) as Run
      if (state.state !== 'running') setRefresh(value=>value+1)
    })
    return ()=>{events.close();window.clearTimeout(refreshTimer)}
  }, [revision])

  const unit=snapshot?.units[selected]
  const units=Object.values(snapshot?.units || {})
  const files=new Map<string,Unit[]>()
  for (const item of units.filter(item=>item.scope.toLowerCase().includes(filter.toLowerCase()))
    .sort((a,b)=>a.file.localeCompare(b.file) || a.line-b.line)) {
    const group=files.get(item.file)
    if (group) group.push(item)
    else files.set(item.file,[item])
  }
  const result=snapshot?.results[selected]
  const visibleTrace=trace.filter(item=>!snapshot?.profile || JSON.stringify(item.profile)===JSON.stringify(JSON.parse(snapshot.profile)))
  const submitted=Object.values(snapshot?.results || {}).filter(value=>value.status==="submitted").length
  const partial=Object.values(snapshot?.results || {}).filter(value=>value.status==="partial").length
  function navigate(id:string,line?:number) {
    setSelected(id)
    setHighlight([line ?? snapshot?.units[id]?.line ?? 1])
  }
  async function action(work:()=>Promise<void>) {
    setError('');setBusy(true)
    try { await work() } catch(e) { setError(e instanceof Error ? e.message : '요청 실패') }
    finally {setBusy(false)}
  }
  return <main className="shell">
    <header className="top">
      <div className="title"><span className="brand">RC</span><div><h1>Review-Coding</h1><p>Python 코드 검수</p></div></div>
      <button disabled={!revision} onClick={()=>action(()=>openProgress(revision,snapshot?.profile))}>분석 관리</button>
    </header>
    <section className="toolbar"><span title={snapshot?.root}>{snapshot?.root?.split(/[\\/]/).at(-1) || '프로젝트'}</span>
      {snapshot?.profile && <span className="muted">{profileLabel(snapshot.profile)}</span>}
      {unit && <button onClick={()=>action(()=>openProgress(revision,snapshot?.profile,unit.id))}>선택 단위 분석 관리</button>}
    </section>
    {error && <div role="alert" className="alert">{error}</div>}
    <div className="workspace">
      <aside className="tree panel">
        <div className="panel-title"><strong>코드 단위</strong><span>{units.length}개</span></div>
        <div className="tree-controls">
          <input aria-label="단위 검색" placeholder="파일 또는 단위 검색" value={filter} onChange={event=>setFilter(event.target.value)}/>
        </div>
        <div className="unit-list">
          {[...files].map(([file,group])=><section key={file} className="file-group" aria-label={file}>
            <h2>{file}</h2>{group.map(item=>
            <button key={item.id} className={selected===item.id?'unit active':'unit'} onClick={()=>navigate(item.id)}>
              <span className={snapshot?.results[item.id]?.status==='submitted'?'dot done':'dot'}/>
              <span><strong>{item.name}</strong><small>{item.kind} · {item.file}:{item.line}{snapshot?.tasks[item.id] &&
                " · " + taskName[snapshot.tasks[item.id].state]}</small></span>
            </button>)}</section>)}
        </div>
        <div className="tree-footer">제출 {submitted} · 부분 {partial} / {units.length}
          {' · '}파싱 오류 {Object.keys(snapshot?.issues || {}).length}</div>
      </aside>
      <SourcePanel unit={unit} source={unit ? snapshot?.files[unit.file] || '' : ''} lines={highlight}/>
      <section className="review panel">
        <div className="panel-title"><strong>검수</strong>{revision && <a href={`/api/export?revision=${revision}`} download="review-coding.json">JSON 내보내기</a>}</div>
        <nav className="tabs" aria-label="검수 보기">
          {([['findings','설명·연결'],['events','실행 기록'],['feedback','피드백']] as const).map(([id,label])=>
            <button key={id} aria-pressed={id===tab} onClick={()=>setTab(id)}>{label}</button>)}
        </nav>
        <div className="review-body">
          {tab==='findings' && (unit && snapshot ? <Findings unit={unit} result={result} snapshot={snapshot} navigate={navigate} highlight={setHighlight}/>
            : <p className="empty">이 분석에서 검수할 코드 단위가 없습니다.</p>)}
          {tab==='events' && (visibleTrace.length ? visibleTrace.slice().reverse().map(item=><details key={item.id} className="event">
            <summary>{item.event.tool || taskName[item.event.state || ""] || item.event.state}
              {item.event.unit && " · " + (snapshot?.units[item.event.unit]?.name || item.event.unit)} <span>{item.time}</span></summary>
            {item.event.path?.length ? <p>탐색 경로 {item.event.path.map(id=>snapshot?.units[id]?.name || id).join(" → ")}</p> : null}
            <pre>{JSON.stringify(item.event,null,2)}</pre></details>) : <p className="empty">실행 기록이 없습니다.</p>)}
          {tab==='feedback' && <>
            {snapshot?.tasks[selected]?.state==="SEMANTIC_SUBMITTED" && result?.version &&
              <button onClick={()=>{if (window.confirm("원본과 모든 설명을 대조해 의미 정확성을 직접 확인했습니까?")) {
                action(async()=>{
                  await request('/api/verify',{revision,profile:snapshot.profile,unit:selected,version:result.version})
                  setRefresh(value=>value+1)
                })
              }}}>독립 검증 완료로 표시</button>}
            <form className="feedback" onSubmit={event=>{event.preventDefault();action(async()=>{
              await request('/api/feedback',{revision,profile:snapshot?.profile,unit:selected,category,note})
              setNote('');setRefresh(value=>value+1)
            })}}>
              <label>피드백 유형<select value={category} onChange={event=>setCategory(event.target.value)}>{categoryOptions.map(value=><option key={value}>{value}</option>)}</select></label>
              <label>원본과 비교한 검수 메모<textarea value={note} maxLength={4000} onChange={event=>setNote(event.target.value)}/></label>
              <button className="primary" disabled={busy || !result || !note.trim()}>저장</button>
            </form>
            {snapshot?.feedback.filter(item=>item.unit===selected).map((item,i)=><article className="edge" key={i}><strong>{item.category}</strong><p>{item.note}</p><small>{item.time}</small></article>)}
          </>}
        </div>
      </section>
    </div>
  </main>
}
