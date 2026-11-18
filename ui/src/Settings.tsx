import {useEffect, useState} from 'react'
import {request, LUNA} from './api'
import type {Account} from './api'
import {defaults, readPreferences, savePreferences} from './desktop'

export default function Settings() {
  const [tab,setTab]=useState<'general'|'model'>('general')
  const [value,setValue]=useState(defaults)
  const [account,setAccount]=useState<Account>()
  const [accountChoice,setAccountChoice]=useState('')
  const [error,setError]=useState('')
  const [saved,setSaved]=useState(false)
  const [busy,setBusy]=useState(false)
  const [loaded,setLoaded]=useState(false)

  useEffect(()=>{
    document.title='설정 · Review-Coding'
    const refresh=()=>request<Account>('/api/account').then(data=>{
      setAccount(data);setAccountChoice(data.active || '')
    }).catch(error=>setError(error.message))
    readPreferences().then(value=>{setValue(value);setLoaded(true)}).catch(error=>setError(String(error)))
    void refresh()
    window.addEventListener('focus',refresh)
    return ()=>window.removeEventListener('focus',refresh)
  },[])

  async function save() {
    setBusy(true);setError('');setSaved(false)
    try { await savePreferences(value);setSaved(true) }
    catch (error) {setError(String(error))}
    finally {setBusy(false)}
  }

  async function login() {
    setBusy(true);setError('')
    try {
      if (window.reviewDesktop) await window.reviewDesktop.login(accountChoice || undefined)
      else {
        const {url}=await request<{url:string}>('/api/login',{account:accountChoice || undefined})
        location.assign(url)
      }
    } catch (error) {setError(String(error))}
    finally {setBusy(false)}
  }

  const available=account?.models.some(item=>item.id===value.model)
  const models=new Map([[LUNA,'GPT-6 Luna']])
  for (const item of account?.models || []) models.set(item.id,item.name)
  if (!models.has(value.model)) models.set(value.model,value.model)
  return <main className="detail-shell settings-shell">
    <h1>설정</h1>
    <nav className="tabs" aria-label="설정 분류">
      <button aria-pressed={tab==='general'} onClick={()=>setTab('general')}>일반</button>
      <button aria-pressed={tab==='model'} onClick={()=>setTab('model')}>모델</button>
    </nav>
    {tab==='general' ? <section className="desktop-fields">
      <label className="check-field"><input type="checkbox" checked={value.compactExplorer}
        onChange={event=>{setValue({...value,compactExplorer:event.target.checked});setSaved(false)}}/>
        파일 탐색기 줄 간격 줄이기</label>
      <h2>ChatGPT 계정</h2>
      <p>{account?.auth==='chatgpt_plan_oauth'?'구독 사용 권한 연결됨':'계정 연결이 필요합니다.'}</p>
      {!!account?.accounts.length && <select aria-label="ChatGPT 계정" value={accountChoice}
        onChange={event=>setAccountChoice(event.target.value)}>
        {account.accounts.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}
        <option value="">다른 계정 연결</option>
      </select>}
      <button data-oai-siwc-button disabled={busy} onClick={()=>login()}>Continue with ChatGPT</button>
    </section> : <section className="desktop-fields">
      <label>기본 모델<select value={value.model} onChange={event=>{
        setValue({...value,model:event.target.value});setSaved(false)
      }}>
        {[...models].map(([id,name])=><option key={id} value={id}>{name}</option>)}
      </select></label>
      <label>추론 노력<select value={value.effort} onChange={event=>{
        setValue({...value,effort:event.target.value});setSaved(false)
      }}>
        {(account?.efforts || ['none','minimal','low','medium','high','xhigh','max','ultra']).map(effort=>
          <option key={effort} value={effort}>{effort}</option>)}
      </select></label>
      <p role="status">{!account?'모델 목록을 확인하는 중…':available?'현재 계정에서 사용할 수 있습니다.':
        account.problem || '현재 계정에서 선택한 모델을 사용할 수 없습니다.'}</p>
    </section>}
    {error && <p role="alert" className="detail-notice">{error}</p>}
    <footer className="detail-footer">
      <button className="primary" disabled={busy || !loaded} onClick={()=>save()}>설정 저장</button>
      {saved && <span role="status"> 저장했습니다.</span>}
    </footer>
  </main>
}
