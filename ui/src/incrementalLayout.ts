import type {Point} from './treeLayout'

export const LAYOUT_VERSION = 'incremental-v1'
export const REST = 118
const GAP = 58
type Pair = [string,string]
export type LayoutCache = {positions:Record<string,Point>; pairs:Pair[]}
export type LayoutRequest = {ids:string[]; pairs:Pair[]; prior:LayoutCache}
export const emptyLayout=():LayoutCache=>({positions:{},pairs:[]})

export function uniquePairs(edges:Pair[]):Pair[] {
  const pairs=new Map<string,Pair>()
  for (const [from,to] of edges) {
    if (from===to) continue
    const pair:Pair=from<to?[from,to]:[to,from]
    pairs.set(JSON.stringify(pair),pair)
  }
  return [...pairs.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,pair])=>pair)
}

function hash(id:string) {
  let value=2166136261
  for (let i=0;i<id.length;i++) value=Math.imul(value^id.charCodeAt(i),16777619)
  return value>>>0
}

function direction(seed:number):Point {
  const y=(seed%997)/498-1
  const angle=seed*2.39996323
  const radius=Math.sqrt(Math.max(0,1-y*y))
  return {x:Math.cos(angle)*radius,y,z:Math.sin(angle)*radius}
}
const plus=(a:Point,b:Point,k=1):Point=>({x:a.x+k*b.x,y:a.y+k*b.y,z:a.z+k*b.z})
const minus=(a:Point,b:Point)=>plus(a,b,-1)
const length=(p:Point)=>Math.hypot(p.x,p.y,p.z)

export function validPoint(value:unknown):value is Point {
  const p=value as Partial<Point>|null
  return !!p && [p.x,p.y,p.z].every(x=>typeof x==='number' && Number.isFinite(x) && Math.abs(x)<=1e6)
}

function adjacency(ids:string[],pairs:Pair[]) {
  const out=new Map(ids.map(id=>[id,[] as string[]]))
  for (const [a,b] of pairs) {
    out.get(a)?.push(b)
    out.get(b)?.push(a)
  }
  return out
}

function components(ids:string[],pairs:Pair[]) {
  const adj=adjacency(ids,pairs)
  const groups=new Map<string,string[]>()
  for (const id of ids) {
    if (groups.has(id)) continue
    const group=[id]
    groups.set(id,group)
    for (let cursor=0;cursor<group.length;cursor++) for (const next of adj.get(group[cursor]) || []) {
      if (groups.has(next)) continue
      groups.set(next,group)
      group.push(next)
    }
  }
  return groups
}

class Spatial {
  private buckets=new Map<string,string[]>()
  private coordinates:Record<string,Point>
  constructor(coordinates:Record<string,Point>) {
    this.coordinates=coordinates
    for (const id of Object.keys(coordinates)) this.add(id)
  }
  add(id:string) {
    const [x,y,z]=this.cell(this.coordinates[id])
    const key=x+'/'+y+'/'+z
    const items=this.buckets.get(key)
    if (items) items.push(id)
    else this.buckets.set(key,[id])
  }
  private cell(p:Point) {return [Math.floor(p.x/GAP),Math.floor(p.y/GAP),Math.floor(p.z/GAP)]}
  near(p:Point, visit:(id:string)=>void) {
    const [x,y,z]=this.cell(p)
    let visited=0
    for (let i=x-1;i<=x+1;i++) for (let j=y-1;j<=y+1;j++) for (let k=z-1;k<=z+1;k++) {
      for (const id of this.buckets.get(i+'/'+j+'/'+k) || []) {
        visit(id)
        if (++visited>=48) return
      }
    }
  }
}

function lattice(index:number):Point {
  if (!index) return {x:0,y:0,z:0}
  const ring=Math.floor((Math.sqrt(index)+1)/2)
  const offset=index-(2*ring-1)**2
  const side=Math.floor(offset/(2*ring)), step=offset%(2*ring)
  const x=[-ring+step,ring,ring-step,-ring][side]
  const z=[-ring,-ring+step,ring,ring-step][side]
  return {x:x*REST,y:((index*13)%5-2)*GAP,z:z*REST}
}

function seed(ids:string[],adj:Map<string,string[]>,positions:Record<string,Point>) {
  const space=new Spatial(positions)
  const pending=new Set(ids.filter(id=>!positions[id]))
  const queue=[...pending].filter(id=>adj.get(id)!.some(neighbor=>positions[neighbor]))
  const queued=new Set(queue)
  let slot=0,cursor=0, fallback=0
  while (pending.size) {
    let id=queue[cursor++]
    if (id===undefined) {
      cursor--
      while (!pending.has(ids[fallback])) fallback++
      id=ids[fallback++]
    }
    if (!pending.delete(id)) continue
    const existing=adj.get(id)!.filter(other=>positions[other]).map(other=>positions[other])
    const center=existing.reduce((sum,p)=>plus(sum,p,1/existing.length),{x:0,y:0,z:0})
    if (existing.length) {
      let best=Infinity
      for (let i=0;i<16;i++) {
        const p=plus(center,direction(hash(id+'#'+i)),REST*(existing.length===1?1:.55+i%3*.32))
        let score=0
        for (const other of existing) score+=(length(minus(p,other))-REST)**2/existing.length
        space.near(p,other=>{score+=Math.max(0,GAP-length(minus(p,positions[other])))**2*7})
        if (score<best) {best=score;positions[id]=p}
      }
    } else {
      let p:Point, overlapping:boolean
      do {
        p=lattice(slot++)
        overlapping=false
        space.near(p,other=>{if (length(minus(p,positions[other]))<GAP) overlapping=true})
      } while (overlapping)
      positions[id]=p
    }
    space.add(id)
    for (const other of adj.get(id)!) if (pending.has(other) && !queued.has(other)) {
      queued.add(other)
      queue.push(other)
    }
  }
}

export function solveLayout({ids,pairs,prior}:LayoutRequest) {
  ids=[...new Set(ids)].sort()
  const present=new Set(ids)
  pairs=uniquePairs(pairs.filter(([a,b])=>present.has(a)&&present.has(b)))
  const positions:Record<string,Point>=Object.create(null)
  for (const id of ids) if (validPoint(prior.positions[id])) positions[id]={...prior.positions[id]}
  const added=ids.filter(id=>!positions[id])
  const oldIds=Object.keys(positions), oldSet=new Set(oldIds)
  const oldPairs=uniquePairs(prior.pairs.filter(([a,b])=>oldSet.has(a)&&oldSet.has(b)))
  const existingPairs=new Set(oldPairs.map(pair=>JSON.stringify(pair)))
  const newPairs=pairs.filter(pair=>!existingPairs.has(JSON.stringify(pair)))
  const adj=adjacency(ids,pairs)
  const groups=components(oldIds,oldPairs)
  const active=new Set(added.filter(id=>adj.get(id)!.length>0))
  for (const [a,b] of newPairs) {
    active.add(a); active.add(b)
    const left=groups.get(a), right=groups.get(b)
    if (!left || !right || left===right) continue
    const delta=minus(positions[b],positions[a]), distance=length(delta)
    const moving=left.length<=right.length?left:right
    const retained=moving===left?right:left
    if (distance>REST*2) {
      const shift=Math.min((distance-REST)*.68,REST*4)/distance
      for (const id of moving) positions[id]=plus(positions[id],delta,moving===left?shift:-shift)
    }
    for (const id of moving) {groups.set(id,retained);retained.push(id)}
  }
  seed(ids,adj,positions)
  const anchors={...positions}
  if (!active.size) return {positions,pairs,iterations:0}
  const widen=()=>{
    for (const id of [...active]) for (const next of adj.get(id)!) active.add(next)
  }
  widen()
  let iterations=0
  for (;iterations<44;iterations++) {
    if (iterations===13 || iterations===26) widen()
    const space=new Spatial(positions)
    const next=new Map<string,Point>()
    let maximum=0
    const strength=Math.min(1,.22+iterations*.09)
    for (const id of active) {
      const point=positions[id], neighbors=adj.get(id)!
      let force=plus({x:0,y:0,z:0},minus(anchors[id],point),.06)
      for (const other of neighbors) {
        const d=minus(positions[other],point), gap=length(d)
        if (gap>.01) force=plus(force,d,(gap-REST)*.19*strength/(gap*Math.sqrt(neighbors.length)))
      }
      space.near(point,other=>{
        if (id===other) return
        const d=minus(point,positions[other]), gap=length(d)
        if (gap<GAP) force=plus(force,gap>.001?d:direction(hash(id+other)),(GAP-gap)*.31/(gap || 1))
      })
      const magnitude=length(force)
      let candidate=plus(point,force,magnitude>8?8/magnitude:1)
      const drift=minus(candidate,anchors[id]), traveled=length(drift)
      // Rigid component motion is handled above. Limit the subsequent internal drift.
      if (oldSet.has(id) && traveled>REST*.85) candidate=plus(anchors[id],drift,REST*.85/traveled)
      maximum=Math.max(maximum,length(minus(candidate,point)))
      next.set(id,candidate)
    }
    for (const [id,value] of next) positions[id]=value
    if (maximum<.32 && iterations>=10) {iterations++;break}
  }
  return {positions,pairs,iterations}
}
