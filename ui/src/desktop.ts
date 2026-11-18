import {useEffect, useState} from 'react'
import {LUNA, request} from './api'
import type {Run} from './api'

export type NodeIdentity = { root: string; revision: string; profile: string; unit: string }
export type Preferences = {model:string; effort:string; compactExplorer:boolean}
export const defaults:Preferences={model:LUNA,effort:'medium',compactExplorer:false}

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
      savePreferences: (value:Preferences)=>Promise<void>
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
  const value=localStorage.getItem('review-coding-preferences')
  return value ? JSON.parse(value) : defaults
}

export async function savePreferences(value:Preferences) {
  if (window.reviewDesktop) await window.reviewDesktop.savePreferences(value)
  else localStorage.setItem('review-coding-preferences',JSON.stringify(value))
}

export function usePreferences(report:(message:string)=>void) {
  const [value,setValue]=useState(defaults)
  useEffect(()=>{
    const refresh=()=>readPreferences().then(setValue).catch(error=>report(String(error)))
    void refresh()
    window.addEventListener('focus',refresh)
    return ()=>window.removeEventListener('focus',refresh)
  },[report])
  return value
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
