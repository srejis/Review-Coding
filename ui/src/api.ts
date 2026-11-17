export const LUNA = 'gpt-6-luna'
export type Unit = { id: string; name: string; kind: string; file: string; scope: string;
  parent: string | null; line: number; end: number; sites: { id: string; line: number }[] }
export type Relation = { kind: string; certainty: string; target: string | null; reason: string;
  evidence: { unit: string; line: number }[] }
export type Boundary = { kind:string; unit:string|null; reason:string }
export type Task = { state:string; waiting?:string[]; path?:string[]; cycle?:string[]; stale?:boolean }
export type Result = { status: string; version?:string; relations: Relation[]; boundaries?:Boundary[];
  dependencies?:{unit:string; version:string}[]; meaning: {
  role: string; steps: { text: string; sites: string[] }[]; missing: string[]; unresolved: string[] } }
export type Snapshot = { root: string; profiles: string[]; profile: string; units: Record<string, Unit>;
  files: Record<string, string>; results: Record<string, Result>; issues: Record<string, string>;
  tasks: Record<string,Task>; connections: Record<string,{relations:Relation[]}>;
  dependencies: Record<string,string[]>;
  feedback: { unit: string; time: string; category: string; note: string }[] }
export type Account = { auth: string; problem?: string; active?: string; efforts: string[];
  accounts: {id: string; label: string}[]; models: { id: string; name: string }[] }
export type Run = { state: string; error?: string; remaining?: number }
export type Project = { id: string; root: string }
export type Trace = { id: number; time: string; profile: Record<string,unknown>; event: { state?: string; tool?: string; unit?: string; path?:string[]; waiting?:string[]; cycle?:string[]; target?:string; version?:string } }

export async function request<T>(path: string, payload?: object): Promise<T> {
  const response = await fetch(path, payload ? {
    method: 'POST', headers: {'Content-Type': 'application/json', 'X-Review-Local': '1'},
    body: JSON.stringify(payload)
  } : undefined)
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || response.statusText)
  return value
}
