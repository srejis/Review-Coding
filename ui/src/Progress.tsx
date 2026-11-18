import {useEffect, useState} from 'react'
import {request} from './api'
import type {ActiveRun, Project} from './api'
import {openSettings, startAnalysis} from './desktop'

const revision=new URLSearchParams(location.search).get('revision') || ''
const statuses:Record<string,string>={
  running:'분석 중', finished:'분석 완료', partial:'부분 완료', failed:'분석 실패',
  cancelled:'중단됨', unit_limit:'단위 한도 도달', time_limit:'시간 한도 도달',
  phase_limit:'단계 한도 도달'
}

export default function Progress() {
  const [project,setProject]=useState<Project>()
  const [run,setRun]=useState<ActiveRun|null>(null)
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const [stopping,setStopping]=useState(false)

  useEffect(()=>{
    document.title='분석 진행 · Review-Coding'
    let alive=true
    let timer:number|undefined
    const poll=async()=>{
      try {
        const value=await request<ActiveRun|null>('/api/run')
        if (alive) {
          setRun(value)
          if (value?.state!=='running') setStopping(false)
        }
      } catch (error) {if (alive) setError(String(error))}
      if (alive) timer=window.setTimeout(poll,1100)
    }
    request<Project[]>('/api/projects').then(items=>{
      if (alive) setProject(items.find(item=>item.id===revision))
    }).catch(error=>{if (alive) setError(String(error))})
    void poll()
    return ()=>{alive=false;window.clearTimeout(timer)}
  },[])

  const current=run?.revision===revision ? run : null
  const active=current?.state==='running'
  async function act(cancel:boolean) {
    setError('');setBusy(true)
    try {
      if (cancel) {
        await request('/api/cancel',{revision})
        setStopping(true)
      } else await startAnalysis(revision)
      setRun(await request<ActiveRun|null>('/api/run'))
    } catch (error) {setError(String(error))}
    finally {setBusy(false)}
  }

  return <main className="detail-shell progress-shell">
    <div className="detail-file">{revision.slice(0,8)}</div>
    <h1>분석 진행</h1>
    <p className="progress-project">{project?.root || '프로젝트 확인 중…'}</p>
    <section className="detail-section" aria-label="분석 진행 상태">
      <h2 role="status">{current ? statuses[current.state] || current.state : '대기 중'}</h2>
      {current && <dl className="progress-stats">
        <dt>모델</dt><dd>{current.model} · {current.effort}</dd>
        <dt>현재 코드 단위</dt><dd>{current.current_unit || '—'}</dd>
        <dt>단계</dt><dd>{current.phase==='CONNECTING'?'연결 조사':current.phase==='SEMANTICIZING'?'의미화':'—'}</dd>
        <dt>제출된 단위</dt><dd>{current.submitted}</dd>
        <dt>남은 단위</dt><dd>{current.left}</dd>
      </dl>}
      {(error || current?.error) && <p role="alert" className="detail-notice">{error || current?.error}</p>}
      {run?.revision!==revision && run?.state==='running' && <p>다른 프로젝트에서 분석이 진행 중입니다.</p>}
    </section>
    <footer className="detail-footer progress-actions">
      {active ? <button disabled={busy || stopping} onClick={()=>act(true)}>{stopping?'중단 요청됨':'분석 중단'}</button> :
        <button className="primary" disabled={!project || busy || run?.state==='running'} onClick={()=>act(false)}>분석 재개</button>}
      <button onClick={()=>openSettings().catch(error=>setError(String(error)))}>설정</button>
    </footer>
    <p className="muted">이 창을 닫으면 분석은 메인 앱에서 계속 실행됩니다.</p>
  </main>
}
