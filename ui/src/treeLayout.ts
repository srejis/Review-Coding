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
