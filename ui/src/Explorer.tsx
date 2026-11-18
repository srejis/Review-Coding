import {useMemo, useState} from 'react'
import {pathTree} from './treeLayout'
import type {PathEntry} from './treeLayout'
import type {Snapshot} from './api'

export default function Explorer({snapshot,selected,select}:{
  snapshot?:Snapshot; selected:ReadonlySet<string>; select:(ids:string[])=>void
}) {
  const [search,setSearch]=useState('')
  const [expanded,setExpanded]=useState<ReadonlySet<string>>(new Set())
  const root=useMemo(()=>pathTree(Object.values(snapshot?.units || {}),snapshot?.file_paths),[snapshot])
  const query=search.trim().toLowerCase()
  const basename=(path:string)=>path.split(/[\\/]/).at(-1) || path
  function toggle(path:string) {
    setExpanded(old=>{
      const next=new Set(old)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  function matches(entry:PathEntry):boolean {
    return entry.path.toLowerCase().includes(query) ||
      [...entry.files.keys()].some(file=>file.toLowerCase().includes(query)) ||
      [...entry.folders.values()].some(matches)
  }
  function tree(entry:PathEntry, depth:number) {
    const folders=[...entry.folders.values()].filter(matches)
    const files=[...entry.files].filter(([file])=>file.toLowerCase().includes(query))
    return <ul className={depth ? 'file-branch' : 'file-tree'}>
      {folders.map(folder=>{
        const open=Boolean(query) || expanded.has(folder.path)
        return <li key={folder.path}>
          <div className="tree-row">
            <button className="tree-disclosure" aria-expanded={open} aria-label={folder.path+' 폴더 펼치기·접기'}
              disabled={Boolean(query)} onClick={()=>toggle(folder.path)}>{open?'▾':'▸'}</button>
            <button className="tree-entry" title={folder.path}
              aria-pressed={folder.ids.length>0 && folder.ids.every(id=>selected.has(id))}
              onClick={()=>select(folder.ids)}>{folder.name}</button>
          </div>
          {open && tree(folder,depth+1)}
        </li>
      })}
      {files.map(([file,units])=><li key={file} className="tree-row">
        <span aria-hidden="true" className="tree-file-icon">◇</span>
        <button className="tree-entry" title={file}
          aria-pressed={units.length>0 && units.every(unit=>selected.has(unit.id))}
          onClick={()=>select(units.map(unit=>unit.id))}>{basename(file)}</button>
      </li>)}
    </ul>
  }
  return <aside className="file-explorer" aria-label="파일 탐색기">
    <h2>파일 탐색기</h2>
    <input type="search" aria-label="파일·폴더 검색" placeholder="파일·폴더 검색"
      value={search} onChange={event=>setSearch(event.target.value)}/>
    {snapshot && <div className="file-scroll">
      <button className="tree-entry tree-root" onClick={()=>select(root.ids)} title={snapshot.root}
        aria-pressed={root.ids.length>0 && root.ids.every(id=>selected.has(id))}>{basename(snapshot.root)}</button>
      {tree(root,0)}
    </div>}
  </aside>
}
