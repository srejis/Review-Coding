import {useEffect, useState} from 'react'
import {LUNA, request} from './api'
import type {Run} from './api'
import {isTheme} from './theme'
import type {Theme} from './theme'
import type {LayoutCache} from './incrementalLayout'

export type NodeIdentity = { root: string; revision: string; profile: string; unit: string }
export type LayoutScope = {root:string; revision:string; profile:string; version:string}
export type Preferences = {model:string; effort:string; compactExplorer:boolean; theme:Theme}
export type ProjectSelection={project:string; revision?:string; profile?:string}
export const projectSelectionKey='review-coding-project'
export const projectChangeKey='review-coding-project-change'
export const defaults:Preferences={model:LUNA,effort:'medium',compactExplorer:false,theme:'editorial'}
const storageKey='review-coding-preferences'
const changeEvent='review-preferences-changed'

declare global {
  interface Window {
    reviewDesktop?: {
      openDetail: (identity:NodeIdentity)=>Promise<void>
      openManagement: (identity?:NodeIdentity)=>Promise<void>
      pickFolder: ()=>Promise<string|null>
      login: (account?:string)=>Promise<void>
      openSettings: ()=>Promise<void>
      openProgress: (revision:string,profile?:string,unit?:string)=>Promise<void>
      openProjects: ()=>Promise<void>
      focusGraph: ()=>Promise<void>
      deleteProject: (project:string)=>Promise<{revisions:string[]}>
      openReview: (value:{revision:string;profile:string;unit?:string})=>Promise<void>
      preferences: ()=>Promise<Preferences>
      onPreferences: (listener:(value:Preferences)=>void)=>()=>void
      savePreferences: (value:Preferences)=>Promise<void>
      loadLayout: (scope:LayoutScope)=>Promise<LayoutCache|null>
      saveLayout: (scope:LayoutScope,cache:LayoutCache)=>Promise<void>
    }
  }
}

export function detailQuery(identity:NodeIdentity) {
  return new URLSearchParams({...identity, view:'unit'})
}

export function profileLabel(raw:string) {
  const profile=JSON.parse(raw)
  return [profile.model, profile.effort, profile.recovery ? '보완 분석' : null].filter(Boolean).join(' · ')
}

export function readProjectSelection():ProjectSelection|null {
  try {return JSON.parse(localStorage.getItem(projectSelectionKey) || 'null')}
  catch {return null}
}

export function chooseProject(selection:ProjectSelection) {
  localStorage.setItem(projectSelectionKey,JSON.stringify(selection))
  signalProjectChange()
}

export function signalProjectChange() {
  localStorage.setItem(projectChangeKey,String(Date.now()))
}

export function formatDate(value:string|null) {
  return value ? new Date(value.replace(' ','T')+'Z').toLocaleString('ko-KR') : '기록 없음'
}

export async function openProjects() {
  if (window.reviewDesktop) await window.reviewDesktop.openProjects()
  else window.open('/?mode=projects','_blank','noopener')
}

export async function readPreferences():Promise<Preferences> {
  if (window.reviewDesktop) return window.reviewDesktop.preferences()
  return browserPreferences()
}

export function browserPreferences():Preferences {
  try {
    const value=JSON.parse(localStorage.getItem(storageKey) || 'null')
    return {...defaults,...value,theme:isTheme(value?.theme)?value.theme:defaults.theme}
  } catch {
    return defaults
  }
}

export async function savePreferences(value:Preferences) {
  if (window.reviewDesktop) await window.reviewDesktop.savePreferences(value)
  else {
    localStorage.setItem(storageKey,JSON.stringify(value))
    window.dispatchEvent(new Event(changeEvent))
  }
}

export function usePreferences(report:(message:string)=>void) {
  const [value,setValue]=useState(defaults)
  useEffect(()=>watchPreferences(setValue,report),[report])
  return value
}

export function watchPreferences(apply:(value:Preferences)=>void, report:(message:string)=>void) {
  let generation=0
  const receive=(value:Preferences)=>{generation++;apply(value)}
  const refresh=()=>{
    const current=++generation
    void readPreferences().then(value=>{
      if (current===generation) receive(value)
    }).catch(error=>{if (current===generation) report(String(error))})
  }
  const storage=(event:StorageEvent)=>{if (!event.key || event.key===storageKey) refresh()}
  const unsubscribe=window.reviewDesktop?.onPreferences(receive)
  window.addEventListener('storage',storage)
  window.addEventListener(changeEvent,refresh)
  refresh()
  return ()=>{
    generation++
    unsubscribe?.()
    window.removeEventListener('storage',storage)
    window.removeEventListener(changeEvent,refresh)
  }
}

export async function openSettings() {
  if (window.reviewDesktop) await window.reviewDesktop.openSettings()
  else window.open('/?mode=settings','_blank','noopener')
}

export async function openProgress(revision:string,profile?:string,unit?:string) {
  if (window.reviewDesktop) await window.reviewDesktop.openProgress(revision,profile,unit)
  else window.open('/?'+new URLSearchParams({mode:'progress',revision,profile:profile || '',unit:unit || ''}),'_blank','noopener')
}

export async function startAnalysis(revision:string, unit?:string, previous?:string) {
  const {model,effort}=previous ? JSON.parse(previous) as Preferences : await readPreferences()
  const run=await request<Run>('/api/analyze',{revision,unit,model,effort,previous})
  signalProjectChange()
  return run
}
