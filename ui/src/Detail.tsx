import {useMemo,useEffect, useRef, useState} from 'react'
import {request} from './api'
import type {Run, Snapshot} from './api'
import {detailQuery, openProgress, profileLabel, startAnalysis} from './desktop'
import type {NodeIdentity} from './desktop'

const params=new URLSearchParams(location.search)
const identity:NodeIdentity={
  root:params.get('root') || '', revision:params.get('revision') || '',
  profile:params.get('profile') || '', unit:params.get('unit') || ''
}

const statuses:Record<string,string>={
  submitted:'의미 제출', partial:'부분 제출', stale:'오래된 결과',
  NEW:'연결 조사 대기', CONNECTING:'연결 조사 중', SEMANTICIZING:'의미화 중',
  WAITING_DEPENDENCIES:'하위 의미 대기', READY_TO_SEMANTICIZE:'의미화 준비',
  SEMANTIC_SUBMITTED:'의미 제출', SEMANTIC_PARTIAL:'부분 제출', QUALITY_VERIFIED:'독립 품질 검증 완료'
}

export default function Detail() {
  const [snapshot,setSnapshot]=useState<Snapshot>()
  const [sourceOpen,setSourceOpen]=useState(false)
  const [lines,setLines]=useState<number[]>([])
  const [error,setError]=useState('')
  const [run,setRun]=useState<Run>()
  const [refresh,setRefresh]=useState(0)
  const [busy,setBusy]=useState(false)
  const marked=useRef<HTMLDivElement>(null)

  useEffect(()=>{
    let active=true
    request<Snapshot>('/api/snapshot?'+detailQuery(identity)).then(data=>{
      if (!active) return
      if (data.root!==identity.root || data.profile!==identity.profile || !data.units[identity.unit]) {
        setError('이 창의 스냅샷·프로필에서 코드 단위를 찾을 수 없습니다.')
        return
      }
      setSnapshot(data)
    }).catch(error=>{if (active) setError(error.message)})
    return ()=>{active=false}
  },[refresh])

  useEffect(()=>{
    let timeout:number|undefined
    const stream=new EventSource('/api/events?'+new URLSearchParams({revision:identity.revision}))
    stream.onmessage=({data})=>{
      const {event}=JSON.parse(data)
      if (event.unit!==identity.unit) return
      window.clearTimeout(timeout)
      timeout=window.setTimeout(()=>setRefresh(n=>n+1),250)
    }
    stream.addEventListener('run',event=>setRun(JSON.parse(event.data)))
    const reload=()=>setRefresh(n=>n+1)
    window.addEventListener('focus',reload)
    return ()=>{stream.close();window.clearTimeout(timeout);window.removeEventListener('focus',reload)}
  },[])

  const unit=snapshot?.units[identity.unit]
  useEffect(()=>{if (unit) document.title=unit.name+' · Review-Coding'},[unit?.name])
  useEffect(()=>{if (sourceOpen) marked.current?.scrollIntoView({block:'nearest'})},[sourceOpen,lines])

  const result=snapshot?.results[identity.unit]
  const task=snapshot?.tasks[identity.unit]
  const stale=result?.status==='stale' || task?.stale
  const source=unit ? snapshot?.files[unit.file] : undefined
  const sourceLines=useMemo(()=>highlightPython(source || ''),[source])
  const sites=new Map(unit?.sites.map(site=>[site.id,site]) || [])

  async function openManagement() {
    setError('')
    try {
      if (window.reviewDesktop) await window.reviewDesktop.openManagement(identity)
      else window.open('/?'+new URLSearchParams({...identity,mode:'management'}),'_blank','noopener')
    } catch (error) {setError(String(error))}
  }
  async function analyze() {
    setBusy(true)
    setError('')
    try {
      setRun(await startAnalysis(identity.revision,identity.unit))
      await openProgress(identity.revision)
    } catch (error) {setError(String(error))}
    finally {setBusy(false)}
  }

  const running=run?.state==='running'
  return <main className="detail-shell">
    {error && <div className="alert" role="alert">{error} <button onClick={()=>{setError('');setRefresh(n=>n+1)}}>다시 불러오기</button></div>}
    {!unit ? <p className="empty">{error?'의미 상세를 열 수 없습니다.':'코드 단위를 불러오는 중…'}</p> : <>
      <header className="detail-header">
        <div className="detail-file">{unit.file}:{unit.line} · {unit.kind}</div>
        <h1>{unit.name}</h1>
        <div className="detail-meta">
          <span className={'detail-badge '+(result?.status || '')}>
            {task?.state==='QUALITY_VERIFIED'?statuses.QUALITY_VERIFIED:
              stale?'오래된 결과':result?statuses[result.status] || result.status:
                task?statuses[task.state] || task.state:'미분석'}
          </span>
          <span>{identity.revision.slice(0,8)}{identity.profile && ' · '+profileLabel(identity.profile)}</span>
        </div>
      </header>
      {stale && <p className="detail-notice">이전 분석의 의미입니다. 재분석 전에는 현재 원본의 근거로 연결하지 않습니다.</p>}
      {run?.error && <p role="alert" className="detail-notice">{run.error}</p>}
      {!result ? <section className="detail-section">
        <p>{running?'분석 중입니다.':'이 단위의 의미가 아직 저장되지 않았습니다.'}</p>
        {!identity.profile && <p>분석 결과는 분석 프로필에 저장됩니다. 그래프에서 갱신된 프로필의 노드를 다시 열 수 있습니다.</p>}
        <button className="primary" disabled={busy || running} onClick={()=>analyze()}>이 단위 분석</button>
      </section> : <>
        <section className="detail-section"><h2>역할</h2><p className="detail-role">{result.meaning.role}</p></section>
        <section className="detail-section"><h2>상세 처리</h2>
          <ol className="detail-steps">{result.meaning.steps.map((step,i)=>{
            const refs=[...new Set(step.sites.flatMap(id=>sites.get(id)?.line || []))].sort((a,b)=>a-b)
            return <li key={i}><p>{step.text}</p>
              {!stale && refs.length>0 && <button className="source-link"
                onClick={()=>{setLines(refs);setSourceOpen(true)}}>원본 {refs.map(line=>'L'+line).join(' · ')}</button>}
            </li>
          })}</ol>
          {result.meaning.missing.length>0 && <p className="detail-notice">원본과 아직 대응되지 않은 구문 {result.meaning.missing.length}개</p>}
        </section>
        {(result.meaning.unresolved.length>0 || !!result.boundaries?.length) && <section className="detail-section">
          <h2>미해결 경계</h2><ul className="detail-boundaries">
            {result.meaning.unresolved.map((item,i)=><li key={'u'+i}>{item}</li>)}
            {result.boundaries?.map((item,i)=><li key={'b'+i}><span>{item.kind}</span>{item.reason}</li>)}
          </ul>
        </section>}
      </>}
      {source!==undefined && <section className="detail-section">
        <button aria-expanded={sourceOpen} className="source-toggle"
          onClick={()=>{setLines([unit.line]);setSourceOpen(value=>!value)}}>{sourceOpen?'원본 접기':'원본 펼치기'}</button>
        {sourceOpen && <div className="detail-source">{sourceLines.map((line,i)=>(
          <div key={i} ref={i+1===lines[0]?marked:undefined} className={lines.includes(i+1)?'evidence-line':''}>
            <span>{i+1}</span><code>{line.length ? line.map((token,index)=>token.kind ?
              <span key={index} className={token.kind}>{token.text}</span> : token.text) : ' '}</code>
          </div>
        ))}</div>}
      </section>}
      <footer className="detail-footer"><button onClick={()=>openManagement()}>분석·피드백 및 검수 기록</button></footer>
    </>}
  </main>
}


type SourceToken={text:string; kind?:'syntax'|'comment'}

function highlightPython(source:string) {
  const tokens=/#[^\r\n]*|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield)\b/g
  const lines:SourceToken[][]=[[]]
  function append(text:string,kind?:SourceToken['kind']) {
    text.split(/\r?\n/).forEach((part,index)=>{
      if (index) lines.push([])
      if (part) lines[lines.length-1].push({text:part,kind})
    })
  }
  let cursor=0
  for (const match of source.matchAll(tokens)) {
    append(source.slice(cursor,match.index))
    append(match[0],match[0].startsWith('#')?'comment':'syntax')
    cursor=match.index+match[0].length
  }
  append(source.slice(cursor))
  return lines
}
