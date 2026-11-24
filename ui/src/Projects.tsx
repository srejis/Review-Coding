import {useEffect, useState} from 'react'
import {request} from './api'
import type {ActiveRun, ProjectRecord} from './api'
import {chooseProject, formatDate, profileLabel, projectSelectionKey, readProjectSelection, signalProjectChange} from './desktop'

export default function Projects() {
  const [projects,setProjects]=useState<ProjectRecord[]>([])
  const [selected,setSelected]=useState(readProjectSelection)
  const [folder,setFolder]=useState('')
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [confirm,setConfirm]=useState<ProjectRecord>()
  const [run,setRun]=useState<ActiveRun|null>(null)

  async function refresh() {
    setProjects(await request<ProjectRecord[]>('/api/project-catalog'))
  }

  useEffect(()=>{
    document.title='프로젝트 관리 · Review-Coding'
    let stopped=false
    let timer:number|undefined
    void refresh().catch(error=>{if (!stopped) setError(String(error))})
    async function status() {
      try {
        const value=await request<ActiveRun|null>('/api/run')
        if (!stopped) setRun(value)
      } catch (error) {if (!stopped) setError(String(error))}
      if (!stopped) timer=window.setTimeout(status,1400)
    }
    void status()
    return ()=>{stopped=true;window.clearTimeout(timer)}
  },[])

  const select=(project:string, revision?:string, profile?:string)=>{
    const value={project,revision,profile}
    setSelected(value);chooseProject(value)
    void window.reviewDesktop?.focusGraph().catch(error=>setError(String(error)))
  }

  async function action(work:()=>Promise<void>) {
    setBusy(true);setError('')
    try {await work()} catch (error) {setError(error instanceof Error?error.message:String(error))}
    finally {setBusy(false)}
  }

  function register() {
    void action(async()=>{
      const root=window.reviewDesktop ? await window.reviewDesktop.pickFolder() : folder.trim()
      if (!root) return
      const {id}=await request<{id:string}>('/api/register',{root})
      const list=await request<ProjectRecord[]>('/api/project-catalog')
      setProjects(list)
      const project=list.find(item=>item.snapshots.some(snapshot=>snapshot.id===id))
      if (project) select(project.id)
      setFolder('')
    })
  }

  function remove(project:ProjectRecord) {
    void action(async()=>{
      const result=window.reviewDesktop ? await window.reviewDesktop.deleteProject(project.id) :
        await request<{revisions:string[]}>('/api/delete-project',{project:project.id})
      localStorage.setItem('review-coding-deleted-revisions',JSON.stringify(result.revisions))
      if (readProjectSelection()?.project===project.id) {
        localStorage.removeItem(projectSelectionKey)
        setSelected(null)
      }
      signalProjectChange()
      setConfirm(undefined)
      await refresh()
    })
  }

  return <main className="detail-shell projects-shell">
    <header className="manager-heading"><div><h1>프로젝트 관리</h1><p className="muted">등록된 코드 폴더와 분석 이력</p></div>
      {window.reviewDesktop && <button className="primary" disabled={busy} onClick={register}>프로젝트 등록</button>}
    </header>
    {!window.reviewDesktop && <form className="manager-actions" onSubmit={event=>{event.preventDefault();register()}}>
      <input aria-label="Python 폴더 경로" placeholder="Python 폴더 경로" value={folder} onChange={event=>setFolder(event.target.value)}/>
      <button className="primary" disabled={busy || !folder.trim()}>프로젝트 등록</button>
    </form>}
    {error && <p role="alert" className="detail-notice">{error}</p>}
    {!projects.length && <p className="muted">등록된 프로젝트가 없습니다.</p>}
    {projects.map(project=>{
      const active=run?.state==='running' && project.snapshots.some(item=>item.id===run.revision)
      const current=selected ? selected.project===project.id : projects[0]?.id===project.id
      const latest=project.snapshots[0]
      const quality=latest.profiles.find(item=>item.id===latest.default_profile)?.counts
      const status=active?'분석 중':!quality?'미분석':latest.parse_errors?'검토 필요':
        quality.complete===quality.total?'분석 완료':
        quality.partial || quality.failed?'보완 필요':'분석 대기'
      return <section className="detail-section project-card" key={project.id}>
        <div className="manager-heading">
          <div><h2>{project.name}</h2><p className="project-path">{project.root}</p>
            <p className="muted">{status} · 최근 분석 {formatDate(project.last)}</p></div>
          <div className="manager-actions">
            <button disabled={busy} onClick={()=>select(project.id)}>{current && !selected?.revision?'현재 프로젝트':'프로젝트 열기'}</button>
            <button disabled={busy || active} onClick={()=>setConfirm(project)}>프로젝트 삭제</button>
          </div>
        </div>
        <details><summary>코드 및 분석 이력 · {project.snapshots.length}개 버전</summary>
          {project.snapshots.map((code,index)=><div className="code-history" key={code.id}>
            <div className="manager-heading"><div>
              <strong>{index===0?'최신 코드':'이전 코드'} · {formatDate(code.registered || code.last)}</strong>
              <p className="muted">{code.count}개 단위{code.changed!==null && ` · 파일 ${code.changed}개 변경`}</p>
            </div><button onClick={()=>select(project.id,code.id)}>이 코드 보기</button></div>
            {code.profiles.map(profile=><div className="history-row" key={profile.id}>
              <div><strong>{profileLabel(profile.id)}</strong><p className="muted">{formatDate(profile.time)} · 완료 {profile.counts.complete} · 부분 {profile.counts.partial} · 실패 {profile.counts.failed}</p></div>
              <button onClick={()=>select(project.id,code.id,profile.id)}>결과 보기</button>
              <details><summary>고급 정보</summary><pre>{JSON.stringify(JSON.parse(profile.id),null,2)}</pre></details>
            </div>)}
            <details><summary>코드 식별 정보</summary><code>{code.id}</code></details>
          </div>)}
        </details>
      </section>
    })}
    {confirm && <section className="detail-section delete-confirm" role="alertdialog" aria-labelledby="delete-title"
      onKeyDown={event=>{if (event.key==='Escape' && !busy) setConfirm(undefined)}}>
      <h2 id="delete-title">{confirm.name} 프로젝트를 삭제할까요?</h2>
      <p className="project-path">{confirm.root}</p>
      <p>이 앱의 등록 정보, 코드 스냅샷, 분석 결과, 실행 기록과 피드백을 삭제합니다. 원본 폴더와 소스 파일은 보존됩니다.</p>
      <div className="manager-actions"><button autoFocus disabled={busy} onClick={()=>setConfirm(undefined)}>취소</button>
        <button className="danger-button" disabled={busy} onClick={()=>remove(confirm)}>앱 데이터 삭제</button></div>
    </section>}
  </main>
}
