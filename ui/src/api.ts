export const LUNA = 'gpt-6-luna'
export type Unit = { id: string; name: string; kind: string; file: string; scope: string;
  parent: string | null; line: number; end: number; sites: { id: string; line: number }[] }
export type Relation = { kind: string; certainty: string; target: string | null; reason: string;
  evidence: { unit: string; line: number }[] }
export type Boundary = { kind:string; unit:string|null; reason:string }
export type Task = { state:string; waiting?:string[]; path?:string[]; cycle?:string[]; stale?:boolean }
export type Result = { status: string; version?:string; relations: Relation[]; boundaries?:Boundary[];
  dependencies?:{unit:string; version:string}[]; meaning: {
  composition?:{schema:string; blocks:{unit:string; version:string; status:string;
    source:{id:string; line:number; end:number}[]}[]};
  role: string; steps: { text: string; sites: string[] }[]; missing: string[]; unresolved: string[] } }
export type GraphNode = {id:string; name:string; version:string; quality:boolean;
  kind:'module'|'class'|'function'|'method'; degree:number}
// Inheritance is stored subclass → base. The renderer reverses it for the flow.
export type GraphEdge = {source:string; target:string; kind:'contains'|'call'|'inheritance';
  evidence:Relation['evidence']}
export type GraphView = {revision:string; nodes:GraphNode[]; edges:GraphEdge[];
  counts:{total:number; completed:number; partial:number}}
export type Snapshot = { root: string; profiles: string[]; profile: string; units: Record<string, Unit>;
  files: Record<string, string>; file_paths?:string[]; results: Record<string, Result>; issues: Record<string, string>;
  graph?:GraphView; tasks: Record<string,Task>; connections: Record<string,{relations:Relation[]}>;
  dependencies: Record<string,string[]>;
  feedback: { unit: string; time: string; category: string; note: string }[] }
export type Account = { auth: string; problem?: string; active?: string; efforts: string[];
  accounts: {id: string; label: string}[]; models: { id: string; name: string }[] }
export type Run = { state: string; error?: string; remaining?: number }
export type ActiveRun = Run & {revision:string; model:string; effort:string;
  current_unit:string|null; current_name?:string; phase:string|null; submitted:number; left:number;
  attempt?:number; profile?:string}
export type Project = { id: string; root: string }
export type QualityCounts={total:number; complete:number; partial:number; failed:number; unprocessed:number}
export type ProfileHistory={id:string; time:string|null; counts:QualityCounts}
export type CodeHistory={id:string; registered:string|null; last:string|null; changed:number|null;
  count:number; parse_errors:number; profiles:ProfileHistory[]; default_profile:string}
export type ProjectRecord=Project & {name:string; latest:string; last:string|null; snapshots:CodeHistory[]}
export type AnalysisReason={code:string; detail?:string; details?:string[]; unit?:string; units?:string[]; sites?:string[]}
export type AnalysisStatus={root:string; profile:string; state:string; counts:QualityCounts; issues:Record<string,string>;
  outstanding:{unit:string;name:string;file:string;line:number;state:string;reasons:AnalysisReason[];
    retries:{attempt:number;phase:string;reasons:AnalysisReason[]}[]}[];
  live:ActiveRun|null; retries:number; error?:string; other_running:boolean; repairable:boolean; resumable:boolean}
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

export function meaningSites(unit:Unit|undefined, result:Result|undefined) {
  return [...(unit?.sites || []), ...(result?.meaning.composition?.blocks.flatMap(block=>block.source) || [])]
}
