import {useEffect, useRef} from 'react'
import {currentTheme,motionPreference} from './theme'
import {emptyLayout, uniquePairs, validPoint} from './incrementalLayout'
import type {LayoutCache} from './incrementalLayout'
import type {LayoutScope} from './desktop'
import type {Point} from './treeLayout'
import type {GraphView} from './api'

function browserKey(scope:LayoutScope) {return 'review-layout:'+JSON.stringify(scope)}

async function loadCache(scope:LayoutScope):Promise<LayoutCache> {
  const cache=window.reviewDesktop ? await window.reviewDesktop.loadLayout(scope) :
    JSON.parse(localStorage.getItem(browserKey(scope)) || 'null') as LayoutCache|null
  if (!cache?.positions || !Array.isArray(cache.pairs)) return emptyLayout()
  const positions=Object.fromEntries(Object.entries(cache.positions).filter(([,point])=>validPoint(point)))
  const pairs=cache.pairs.filter(pair=>Array.isArray(pair) && pair.length===2 &&
    pair.every(id=>typeof id==='string' && Object.hasOwn(positions,id)))
  return {positions,pairs}
}

async function saveCache(scope:LayoutScope,cache:LayoutCache) {
  if (window.reviewDesktop) await window.reviewDesktop.saveLayout(scope,cache)
  else localStorage.setItem(browserKey(scope),JSON.stringify(cache))
}

type Topology = {ids:string[]; pairs:[string,string][]; signature:string; generation:number}

export function useGraphLayout(scope:LayoutScope, graph:GraphView|undefined, update:()=>void,
                               restored:(positions:Record<string,Point>)=>void, report:(message:string)=>void) {
  const coordinates=useRef<Record<string,Point>>({})
  const invalidate=useRef<(graph:GraphView|undefined)=>void>(()=>{})
  const pause=useRef(()=>{})
  const resume=useRef(()=>{})
  const callbacks=useRef({update,restored,report})
  callbacks.current={update,restored,report}
  const {root,revision,profile,version}=scope

  useEffect(()=>{
    const storageScope={root,revision,profile,version}
    const worker=new Worker(new URL('./layout.worker.ts',import.meta.url),{type:'module'})
    let active=true, ready=false, running=false, paused=false
    let prior=emptyLayout(), generation=0, frame=0
    let wanted:Topology|undefined
    let received:LayoutCache|undefined
    let interpolation:{from:Record<string,Point>; to:Record<string,Point>; elapsed:number; last:number; duration:number}|undefined
    let writes=Promise.resolve()
    const motion=motionPreference()

    function animate(now:number) {
      frame=0
      if (paused || !active) return
      if (received) {
        const from=coordinates.current,to=received.positions
        received=undefined
        const moves=Object.entries(to).some(([id,end])=>{
          const start=from[id]
          return start && (start.x!==end.x || start.y!==end.y || start.z!==end.z)
        })
        if (!moves) {
          coordinates.current=to
          callbacks.current.update()
          return
        }
        interpolation={from,to,elapsed:0,last:now,duration:currentTheme().move}
      }
      if (!interpolation) return
      const {from,to}=interpolation
      interpolation.elapsed+=now-interpolation.last
      interpolation.last=now
      const progress=motion.matches?1:Math.min(1,interpolation.elapsed/interpolation.duration)
      const completed=progress===1
      const factor=1-(1-progress)**3
      coordinates.current=completed ? to : Object.fromEntries(Object.entries(to).map(([id,target])=>{
        const previous=from[id] || target
        return [id,{
          x:previous.x+(target.x-previous.x)*factor,
          y:previous.y+(target.y-previous.y)*factor,
          z:previous.z+(target.z-previous.z)*factor
        }]
      }))
      if (completed) interpolation=undefined
      callbacks.current.update()
      schedule()
    }

    function schedule() {
      if (active && !paused && !frame && (received || interpolation)) frame=requestAnimationFrame(animate)
    }

    function submit() {
      if (!ready || !active || running || !wanted) return
      running=true
      const previous={...prior.positions,...coordinates.current}
      worker.postMessage({ids:wanted.ids,pairs:wanted.pairs,generation:wanted.generation,
                          prior:{positions:previous,pairs:prior.pairs}})
    }

    invalidate.current=value=>{
      if (!value) return
      const ids=value.nodes.map(node=>node.id).sort()
      const pairs=uniquePairs(value.edges.map(edge=>[edge.source,edge.target]))
      const signature=JSON.stringify([ids,pairs])
      if (wanted?.signature===signature) return
      wanted={ids,pairs,signature,generation:++generation}
      received=interpolation=undefined
      submit()
    }
    pause.current=()=>{paused=true}
    resume.current=()=>{
      paused=false
      if (interpolation) interpolation.last=performance.now()
      schedule()
    }
    worker.onmessage=({data}:MessageEvent<LayoutCache & {generation:number}>)=>{
      if (!active) return
      running=false
      if (data.generation!==wanted?.generation) {submit();return}
      prior={positions:data.positions,pairs:data.pairs}
      received=prior
      const saved=prior
      writes=writes.then(()=>{
        if (active && wanted?.generation===data.generation) return saveCache(storageScope,saved)
      }).catch(error=>{
        if (active) callbacks.current.report('3D 좌표를 저장하지 못했습니다. '+String(error))
      })
      schedule()
    }
    worker.onerror=()=>{if (active) callbacks.current.report('3D 위치 계산에 실패했습니다. 그래프를 다시 열어 주세요.')}

    // Positions are restored only for IDs present in the current server reply.
    loadCache(storageScope).catch(()=>emptyLayout()).then(cache=>{
      if (!active) return
      prior=cache
      ready=true
      const ids=new Set(wanted?.ids || [])
      const positions=Object.fromEntries(Object.entries(cache.positions).filter(([id])=>ids.has(id)))
      if (Object.keys(positions).length) {
        if (paused) received={positions,pairs:cache.pairs}
        else {
          coordinates.current=positions
          callbacks.current.restored(positions)
          callbacks.current.update()
        }
      }
      submit()
    })
    return ()=>{
      active=false
      worker.terminate()
      cancelAnimationFrame(frame)
      coordinates.current={}
    }
  },[root,revision,profile,version])
  useEffect(()=>invalidate.current(graph),[graph,root,revision,profile,version])
  return {coordinates,pause,resume}
}
