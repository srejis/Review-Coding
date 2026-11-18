export type NodeIdentity = { root: string; revision: string; profile: string; unit: string }

declare global {
  interface Window {
    reviewDesktop?: {
      openDetail: (identity:NodeIdentity)=>Promise<void>
      openManagement: (identity?:NodeIdentity)=>Promise<void>
      pickFolder: ()=>Promise<string|null>
      login: (account?:string)=>Promise<void>
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
