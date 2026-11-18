import {useEffect, useState} from 'react'
import {LUNA, request} from './api'
import type {Run} from './api'
import {isTheme} from './theme'
import type {Theme} from './theme'
import type {LayoutCache} from './incrementalLayout'

export type NodeIdentity = { root: string; revision: string; profile: string; unit: string }
export type LayoutScope = {root:string; revision:string; profile:string; version:string}
export type Preferences = {model:string; effort:string; compactExplorer:boolean; theme:Theme}
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
      openProgress: (revision:string)=>Promise<void>
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
  return [profile.model, profile.effort, profile.prompt_hash?.slice(0,8)].filter(Boolean).join(' · ')
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

export async function openProgress(revision:string) {
  if (window.reviewDesktop) await window.reviewDesktop.openProgress(revision)
  else window.open('/?'+new URLSearchParams({mode:'progress',revision}),'_blank','noopener')
}

export async function startAnalysis(revision:string, unit?:string) {
  const {model,effort}=await readPreferences()
  return request<Run>('/api/analyze',{revision,unit,model,effort})
}
