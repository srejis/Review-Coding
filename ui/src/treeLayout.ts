import type {Unit} from './api'

export type Point = {x:number; y:number; z:number}
export type PathEntry = {path:string; name:string; folders:Map<string,PathEntry>; files:Map<string,Unit[]>; ids:string[]}

export function pathTree(units:Unit[], paths:string[]=[]):PathEntry {
  const entry=(path:string,name:string):PathEntry=>({path,name,folders:new Map(),files:new Map(),ids:[]})
  const root=entry('','')
  const files=new Map<string,Unit[]>(paths.map(file=>[file,[]]))
  for (const unit of units) {
    const group=files.get(unit.file) || []
    group.push(unit)
    files.set(unit.file,group)
  }
  for (const [file,group] of [...files].sort(([a],[b])=>a.localeCompare(b))) {
    const parts=file.split(/[\\/]/).filter(Boolean)
    let folder=root
    const ids=group.map(unit=>unit.id)
    folder.ids.push(...ids)
    for (const part of parts.slice(0,-1)) {
      let child=folder.folders.get(part)
      if (!child) {
        child=entry(folder.path ? folder.path+'/'+part : part,part)
        folder.folders.set(part,child)
      }
      child.ids.push(...ids)
      folder=child
    }
    folder.files.set(file,group)
  }
  return root
}

export function treeCoordinates(units:Unit[]):Map<string,Point> {
  const positions=new Map<string,Point>()
  let nextLeaf=0

  function fileCoordinates(group:Unit[], depth:number, z:number) {
    const ordered=[...group].sort((a,b)=>a.line-b.line || a.id.localeCompare(b.id))
    const ids=new Set(ordered.map(unit=>unit.id))
    const indexed=new Map<string|null,Unit[]>()
    for (const unit of ordered) {
      const parent=unit.parent && ids.has(unit.parent) && unit.parent!==unit.id ? unit.parent : null
      const siblings=indexed.get(parent) || []
      siblings.push(unit)
      indexed.set(parent,siblings)
    }
    function place(unit:Unit, level:number, branchZ:number):number {
      const existing=positions.get(unit.id)
      if (existing) return existing.x
      positions.set(unit.id,{x:nextLeaf,y:-(depth+level)*62,z:branchZ})
      const children=indexed.get(unit.id) || []
      const xs=children.map((child,i)=>place(child,level+1,
        branchZ+(i-(children.length-1)/2)*Math.min(27,84/Math.max(1,children.length-1))
          +(level%2===0?16:-12)))
      const x=xs.length ? (xs[0]+xs[xs.length-1])/2 : (nextLeaf+=39)-39
      positions.set(unit.id,{x,y:-(depth+level)*62,z:branchZ})
      return x
    }
    const roots=indexed.get(null) || []
    roots.forEach((unit,i)=>place(unit,0,z+(i%2?18:-18)))
    // A malformed parent cycle cannot omit nodes from the viewport.
    for (const unit of ordered) if (!positions.has(unit.id)) place(unit,0,z)
    nextLeaf+=48
  }

  function visit(folder:PathEntry, depth:number, z:number) {
    const folders=[...folder.folders.values()]
    const siblings=folders.length+folder.files.size
    const branch=(i:number)=>(i-(siblings-1)/2)*Math.min(88,310/Math.max(1,siblings-1))
    folders.forEach((child,i)=>visit(child,depth+1,z+branch(i)+(depth%2===0?37:-27)))
    for (const [i,group] of [...folder.files.values()].entries()) {
      fileCoordinates(group,depth,z+branch(i+folders.length)+(i%2?26:-26))
    }
  }
  visit(pathTree(units),0,0)
  if (!positions.size) return positions
  let low={x:Infinity,y:Infinity,z:Infinity}, high={x:-Infinity,y:-Infinity,z:-Infinity}
  const axes=['x','y','z'] as const
  for (const point of positions.values()) for (const axis of axes) {
    low[axis]=Math.min(low[axis],point[axis])
    high[axis]=Math.max(high[axis],point[axis])
  }
  // Center the forest and cap each axis independently to preserve visible depth.
  for (const point of positions.values()) for (const axis of axes) {
    const span=high[axis]-low[axis]
    const room=axis==='x'?630:axis==='y'?450:440
    point[axis]=(point[axis]-(low[axis]+high[axis])/2)*Math.min(1,room/(span || 1))
  }
  return positions
}
