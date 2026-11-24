import {useEffect, useState} from 'react'
import {request} from './api'
import type {AnalysisStatus} from './api'
import {openSettings, startAnalysis, usePreferences} from './desktop'

const query=new URLSearchParams(location.search)
const revision=query.get('revision') || ''
const historical=query.get('profile') || ''
const unit=query.get('unit') || undefined
const labels:Record<string,string>={
  missing_sites:'원본 구문 누락', unresolved_meaning:'의미 미해결', invalid_connection_evidence:'연결 근거 오류',
  partial_dependency:'하위 의미 부분 제출', partial_block:'분할 블록 부분 제출',
  external:'외부 경계', candidate:'연결 후보', unresolved:'연결 미확정',
  cycle:'순환 의존성', blocked_dependency:'하위 분석 실패', agent_limit:'단위 모델 한도',
  timeout:'응답 시간 초과', transient_provider:'일시적인 연결 오류', rejected_submission:'제출 검증 오류'
}

export default function Progress() {
  const [status,setStatus]=useState<AnalysisStatus>()
  const [profile,setProfile]=useState(historical)
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const [stopping,setStopping]=useState(false)
  const [reasonFilter,setReasonFilter]=useState('')
  const preferences=usePreferences(setError)

  useEffect(()=>{
    document.title='분석 관리 · Review-Coding'
    let active=true
    let timer:number|undefined
    async function poll() {
      try {
        const state=await request<AnalysisStatus>('/api/analysis?'+new URLSearchParams({revision,profile}))
        if (active) {
          setStatus(state)
          if (state.state!=='running') setStopping(false)
        }
      } catch (error) {if (active) setError(String(error))}
      if (active) timer=window.setTimeout(poll,950)
    }
    void poll()
    return ()=>{active=false;window.clearTimeout(timer)}
  },[profile])

  async function act(action:'stop'|'resume'|'start') {
    setBusy(true);setError('')
    try {
      if (action==='stop') {
        await request('/api/cancel',{revision})
        setStopping(true)
      } else {
        await startAnalysis(revision,unit,action==='resume'?status?.profile || undefined:undefined)
        setProfile('')
      }
      setStatus(await request<AnalysisStatus>('/api/analysis?'+new URLSearchParams({revision})))
    } catch (error) {setError(error instanceof Error?error.message:String(error))}
    finally {setBusy(false)}
  }

  function review(unit?:string) {
    if (!status) return
    const value={revision,profile:status.profile,unit}
    if (window.reviewDesktop) void window.reviewDesktop.openReview(value).catch(error=>setError(String(error)))
    else window.open('/?'+new URLSearchParams({mode:'management',revision,profile:status.profile,unit:unit || ''}),'_blank','noopener')
  }

  const counts=status?.counts
  const running=status?.state==='running'
  const cancelled=status?.state==='cancelled'
  const resolved=counts && counts.complete===counts.total && counts.total>0 && !Object.keys(status?.issues || {}).length
  const hasWork=Boolean(counts && (counts.unprocessed || status?.repairable))
  const previous=status?.profile ? JSON.parse(status.profile) : null
  const newSettings=previous && previous.model!==undefined &&
    (previous.model!==preferences.model || previous.effort!==preferences.effort)
  const issueCounts=new Map<string,number>()
  for (const item of status?.outstanding || []) for (const code of new Set(item.reasons.map(reason=>reason.code))) {
    issueCounts.set(code,(issueCounts.get(code) || 0)+1)
  }
  const activeReason=issueCounts.has(reasonFilter)?reasonFilter:''
  const outstanding=status?.outstanding.filter(item=>!activeReason || item.reasons.some(reason=>reason.code===activeReason))
  const title=running?'분석 중':cancelled?'중단됨':status?.state==='failed'?'실행 오류':resolved?'분석 완료':
    status?.state==='partial' || counts?.partial || counts?.failed?'검토할 결과가 남아 있습니다.':'실행 대기'

  return <main className="detail-shell progress-shell">
    <header className="manager-heading"><div><h1>분석 관리</h1>
      <p className="progress-project">{status?.root || '프로젝트 확인 중…'}</p></div>
      <button className="icon-button" aria-label="설정" title="설정" onClick={()=>openSettings().catch(error=>setError(String(error)))}>⚙</button>
    </header>
    <section className="detail-section" aria-label="분석 진행 상태">
      <h2 role="status">{title}</h2>
      {counts && <dl className="analysis-counts">
        {([['전체',counts.total],['완전 제출',counts.complete],['부분 제출',counts.partial],['실패',counts.failed],
          ['미처리',counts.unprocessed],['보완 시도',status?.retries]] as const).map(([label,value])=>
          <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>}
      {running && <dl className="progress-stats">
        <dt>현재 코드 단위</dt><dd>{status?.live?.current_name || status?.live?.current_unit || '준비 중'}</dd>
        <dt>진행 단계</dt><dd>{status?.live?.phase==='CONNECTING'?'연결 조사':status?.live?.phase==='SEMANTICIZING'?'의미화':'실행 준비'}
          {status?.live?.attempt ? ` · 자동 보완 ${status.live.attempt}회차` : ''}</dd>
      </dl>}
      {(error || status?.error) && <p role="alert" className="detail-notice">{error || status?.error}</p>}
      {status?.other_running && <p>다른 프로젝트에서 분석이 진행 중입니다.</p>}
      {status && Object.keys(status.issues).length>0 && <details><summary>원본을 읽지 못한 파일</summary>
        <ul>{Object.entries(status.issues).map(([file,issue])=><li key={file}>{file} · {issue}</li>)}</ul></details>}
      <div className="manager-actions">
        {running ? <button disabled={busy || stopping} onClick={()=>void act('stop')}>{stopping?'중단 요청됨':'분석 중단'}</button> :
          status && (hasWork || cancelled || status.state==='failed') &&
          <button className="primary" disabled={busy || status.other_running}
            onClick={()=>void act(status.resumable?'resume':'start')}>
            {cancelled && status.resumable?'분석 재개':unit?'선택 단위 분석':status.resumable && (counts?.partial || counts?.failed)?
              '보완 분석':'분석 시작'}</button>}
        {status?.profile && <button onClick={()=>review()}>검수·실행 기록·내보내기</button>}
      </div>
      {!running && (newSettings || (previous && !status?.resumable && !hasWork)) &&
        <details className="code-history"><summary>현재 설정으로 별도 실행</summary>
        <p className="muted">현재 설정을 적용한 새 실행은 별도 분석 이력에 저장됩니다.</p>
        <button disabled={busy || status?.other_running} onClick={()=>void act('start')}>새 설정으로 분석 시작</button>
      </details>}
    </section>
    {!!status?.outstanding.length && <section className="detail-section">
      <div className="manager-heading"><h2>부분 제출과 실패 원인</h2>
        <select aria-label="원인 선택" value={activeReason} onChange={event=>setReasonFilter(event.target.value)}>
          <option value="">모든 원인</option>
          {[...issueCounts].sort((a,b)=>b[1]-a[1]).map(([code,count])=>
            <option key={code} value={code}>{labels[code] || code} · {count}개</option>)}
        </select>
      </div>
      {outstanding?.map(item=><details className="analysis-issue" key={item.unit}>
        <summary><strong>{item.name}</strong> <span className="muted">{item.file}:{item.line} · {item.state==='SEMANTIC_PARTIAL'?'부분 제출':'실패'}</span></summary>
        <ul>{item.reasons.map((reason,i)=>
          <li key={i}>{labels[reason.code] || reason.code}{reason.detail && ` · ${reason.detail}`}
            {[...(reason.sites || []),...(reason.details || []),...(reason.units || []),...(reason.unit?[reason.unit]:[])]
              .map((detail,index)=><div className="muted" key={index}>{detail}</div>)}</li>)}</ul>
        {item.retries.length>0 && <p>저장된 보완 시도 {item.retries.length}회 · {item.retries.map(retry=>
          retry.phase==='connection'?'연결 조사':'의미화').join(', ')}</p>}
        <button onClick={()=>review(item.unit)}>원본과 결과 검수</button>
      </details>)}
    </section>}
    {running && <p className="muted">이 창을 닫아도 분석은 계속됩니다.</p>}
  </main>
}
