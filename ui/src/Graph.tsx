import {useEffect, useMemo, useRef} from 'react'
import type {GraphView} from './api'
import type {LayoutScope} from './desktop'
import {useGraphLayout} from './useGraphLayout'
import {currentTheme,motionPreference} from './theme'
import type {Point} from './treeLayout'
import {cameraProjection,clamp,hitsNode,nodeRadius,projectNode} from './graphGeometry'
import type {Projected} from './graphGeometry'
import {paintEdge,paintNode,prepareEdges,readMaterial} from './graphRender'

const initialCamera=()=>({pitch:.12,yaw:-.35,distance:950,zoom:1,panX:0,panY:0,target:{x:0,y:0,z:0}})
type Camera=ReturnType<typeof initialCamera>

function fit(points:Point[],camera:Camera,canvas:HTMLCanvasElement|null) {
  if (!points.length) return null
  const low={x:Infinity,y:Infinity,z:Infinity}, high={x:-Infinity,y:-Infinity,z:-Infinity}
  for (const point of points) for (const axis of ['x','y','z'] as const) {
    low[axis]=Math.min(low[axis],point[axis])
    high[axis]=Math.max(high[axis],point[axis])
  }
  const target={x:(low.x+high.x)/2,y:(low.y+high.y)/2,z:(low.z+high.z)/2}
  const radius=Math.max(20,Math.hypot(high.x-low.x,high.y-low.y,high.z-low.z)/2)
  const distance=Math.max(950,radius*2.4)
  const width=canvas?.clientWidth || 900,height=canvas?.clientHeight || 650
  const view=cameraProjection(camera.yaw,camera.pitch,distance,950*Math.min(width,height)/710,0,0)
  let spanX=0,spanY=0
  for (const point of points) {
    const p=view.rotate({x:point.x-target.x,y:point.y-target.y,z:point.z-target.z})
    p.z+=distance
    const {x,y}=view.project(p)
    spanX=Math.max(spanX,Math.abs(x))
    spanY=Math.max(spanY,Math.abs(y))
  }
  const zoom=clamp(Math.min(width*.39/(spanX+1),height*.39/(spanY+1)),.1,3.4)
  return {target,distance,zoom,panX:0,panY:0}
}

export default function Graph({scope,graph,selected,focus,reset,choose,open,report}:{
  scope:LayoutScope; graph?:GraphView; selected:ReadonlySet<string>; focus:number; reset:number;
  choose:(id:string|null,toggle:boolean)=>void; open:(id:string)=>void; report:(message:string)=>void
}) {
  const canvas=useRef<HTMLCanvasElement>(null)
  const projected=useRef<Projected[]>([])
  const draw=useRef(()=>{})
  const camera=useRef(initialCamera())
  const flight=useRef<{from:Camera; to:Camera; start:number; duration:number}|undefined>(undefined)
  const interaction=useRef<{x:number;y:number;startX:number;startY:number;pan:boolean}|null>(null)
  const cameraTouched=useRef(false)
  const nodes=useMemo(()=>graph?.nodes || [],[graph])
  const edges=useMemo(()=>prepareEdges(graph?.edges || []),[graph])
  const animatedEdges=useMemo(()=>{
    const prioritized=edges.filter(edge=>selected.has(edge.source) || selected.has(edge.target))
    return new Set([...new Set([...prioritized,...edges].map(edge=>edge.key))].slice(0,120))
  },[edges,selected])
  const layout=useGraphLayout(scope,graph,()=>draw.current(),positions=>{
    const view=fit(Object.values(positions),camera.current,canvas.current)
    if (view && !cameraTouched.current) Object.assign(camera.current,view)
  },report)
  const latest=useRef({nodes,edges,animatedEdges,selected,choose,open})
  latest.current={nodes,edges,animatedEdges,selected,choose,open}

  const lastClick=useRef<string|null>(null)
  const priorReset=useRef(reset)
  const priorFocus=useRef(focus)
  const release=useRef<number|undefined>(undefined)
  function resumeAfterClick() {
    window.clearTimeout(release.current)
    release.current=window.setTimeout(()=>{if (!interaction.current) layout.resume.current()},180)
  }

  function flyTo(next:Camera) {
    if (motionPreference().matches) {flight.current=undefined;camera.current=next}
    else flight.current={from:camera.current,to:next,start:performance.now(),duration:currentTheme().camera}
    draw.current()
  }

  useEffect(()=>{
    const el=canvas.current
    if (!el) return
    const ctx=el.getContext('2d')
    if (!ctx) return
    let frame=0
    const motion=motionPreference()
    let material=readMaterial(el)
    type Reveal={start:number; duration:number}
    const starts=new Map<string,Reveal>(), edgeStarts=new Map<string,Reveal>()
    let previousNodes:typeof nodes|undefined, previousEdges:typeof edges|undefined
    const appearance=new MutationObserver(()=>{material=readMaterial(el);draw.current()})
    appearance.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']})
    const drawForMotion=()=>draw.current()
    motion.addEventListener('change',drawForMotion)
    const paint=(now:number)=>{
      frame=0
      const {width,height}=el.getBoundingClientRect()
      if (!width || !height) return
      const dpr=Math.min(window.devicePixelRatio || 1,2)
      if (el.width!==Math.round(width*dpr) || el.height!==Math.round(height*dpr)) {
        el.width=Math.round(width*dpr)
        el.height=Math.round(height*dpr)
      }
      ctx.setTransform(dpr,0,0,dpr,0,0)
      ctx.clearRect(0,0,width,height)
      let animating=false
      const journey=flight.current
      if (journey) {
        const progress=motion.matches?1:clamp((now-journey.start)/journey.duration,0,1)
        const t=1-(1-progress)**3
        const {from,to}=journey
        const mix=(a:number,b:number)=>a+(b-a)*t
        camera.current={
          pitch:mix(from.pitch,to.pitch),yaw:mix(from.yaw,to.yaw),zoom:mix(from.zoom,to.zoom),
          distance:mix(from.distance,to.distance),panX:mix(from.panX,to.panX),panY:mix(from.panY,to.panY),
          target:{x:mix(from.target.x,to.target.x),y:mix(from.target.y,to.target.y),z:mix(from.target.z,to.target.z)}
        }
        if (progress===1) flight.current=undefined
        else animating=true
      }
      const {yaw,pitch,zoom,panX,panY,target,distance}=camera.current
      const {nodes,edges,animatedEdges,selected}=latest.current
      function prune(known:Map<string,Reveal>,ids:string[]) {
        const current=new Set(ids)
        for (const id of known.keys()) if (!current.has(id)) known.delete(id)
      }
      if (previousNodes!==nodes) {prune(starts,nodes.map(node=>node.id));previousNodes=nodes}
      if (previousEdges!==edges) {prune(edgeStarts,edges.map(edge=>edge.key));previousEdges=edges}
      function reveal(known:Map<string,Reveal>,id:string) {
        let entry=known.get(id)
        if (!entry) {
          entry={start:now,duration:material.theme.enter}
          known.set(id,entry)
        }
        if (motion.matches) entry.duration=0
        if (interaction.current || !entry.duration) return 1
        const progress=clamp((now-entry.start)/entry.duration,0,1)
        if (progress<1) animating=true
        return 1-(1-progress)**2
      }
      const scale=Math.min(width,height)/710
      const view=cameraProjection(yaw,pitch,distance,950*scale*zoom,width/2+panX,height/2+panY)
      const points=nodes.flatMap(node=>{
        const point=layout.coordinates.current[node.id]
        if (!point) return []
        const projected=projectNode(node,point,target,nodeRadius(node.degree,zoom),reveal(starts,node.id),view)
        return projected?[projected]:[]
      }).sort((a,b)=>b.depth-a.depth)
      projected.current=points
      const position=new Map(points.map(node=>[node.id,node]))
      let flowing=false
      const seconds=now/1000
      const edgeOpacity=.72/Math.sqrt(Math.max(1,edges.length/120))
      for (const edge of edges) {
        const a=position.get(edge.source),b=position.get(edge.target)
        if (!a || !b) continue
        if (Math.min(a.sx,b.sx)>width+32 || Math.max(a.sx,b.sx)<-32 ||
            Math.min(a.sy,b.sy)>height+32 || Math.max(a.sy,b.sy)<-32) continue
        const important=selected.has(edge.source) || selected.has(edge.target)
        const moving=!motion.matches && animatedEdges.has(edge.key)
        flowing ||= moving
        const alpha=(important?.98:edgeOpacity)*reveal(edgeStarts,edge.key)
        paintEdge(ctx,edge,a,b,view,alpha,moving?seconds:0)
      }
      for (const node of points) {
        if (node.sx<-36 || node.sx>width+36 || node.sy<-36 || node.sy>height+36) continue
        const active=selected.has(node.id)
        paintNode(ctx,node,active && selected.size<=18,active,material)
      }
      ctx.globalAlpha=1
      if (animating) draw.current()
      else if (flowing) {
        const next=(time:number)=>{
          frame=time-now<33 ? requestAnimationFrame(next) : 0
          if (!frame) paint(time)
        }
        frame=requestAnimationFrame(next)
      }
    }
    let requested=false
    draw.current=()=>{
      if (requested) return
      cancelAnimationFrame(frame)
      requested=true
      frame=requestAnimationFrame(now=>{requested=false;paint(now)})
    }
    const observer=new ResizeObserver(draw.current)
    observer.observe(el)
    let wheel:number|undefined
    const zoom=(event:WheelEvent)=>{
      event.preventDefault()
      cameraTouched.current=true
      flight.current=undefined
      layout.pause.current()
      window.clearTimeout(wheel)
      wheel=window.setTimeout(()=>{if (!interaction.current) layout.resume.current()},130)
      camera.current.zoom=clamp(camera.current.zoom*Math.exp(-event.deltaY*.0015),.1,8)
      draw.current()
    }
    el.addEventListener('wheel',zoom,{passive:false})
    draw.current()
    return ()=>{
      observer.disconnect()
      appearance.disconnect()
      motion.removeEventListener('change',drawForMotion)
      el.removeEventListener('wheel',zoom)
      window.clearTimeout(wheel)
      window.clearTimeout(release.current)
      cancelAnimationFrame(frame)
      draw.current=()=>{}
    }
  },[])
  useEffect(()=>{draw.current()},[nodes,edges,selected])
  useEffect(()=>{
    if (priorReset.current===reset) return
    priorReset.current=reset
    cameraTouched.current=true
    const points=latest.current.nodes.flatMap(node=>layout.coordinates.current[node.id] || [])
    const initial=initialCamera()
    flyTo({...initial,...fit(points,initial,canvas.current)})
  },[reset])
  useEffect(()=>{
    if (priorFocus.current===focus) return
    priorFocus.current=focus
    cameraTouched.current=true
    const points=latest.current.nodes.flatMap(node=>
      latest.current.selected.has(node.id) ? (layout.coordinates.current[node.id] || []) : [])
    const view=fit(points,camera.current,canvas.current)
    if (!view) return
    flyTo({...camera.current,...view})
  },[focus])

  return <canvas ref={canvas} className="graph-canvas" aria-label="Interactive 3D code graph" tabIndex={0}
    onKeyDown={event=>{
      const ids=latest.current.selected
      const visible=latest.current.nodes.filter(node=>ids.has(node.id))
      if (event.key==='Enter' && visible.length===1) latest.current.open(visible[0].id)
    }}
    onContextMenu={event=>event.preventDefault()}
    onPointerDown={event=>{
      if (event.button!==0 && event.button!==1 && event.button!==2) return
      cameraTouched.current=true
      window.clearTimeout(release.current)
      flight.current=undefined
      layout.pause.current()
      event.currentTarget.setPointerCapture(event.pointerId)
      interaction.current={x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,
        pan:event.shiftKey || event.button!==0}
    }}
    onPointerMove={event=>{
      const drag=interaction.current
      if (!drag) return
      const dx=event.clientX-drag.x,dy=event.clientY-drag.y
      if (drag.pan) {
        camera.current.panX+=dx
        camera.current.panY+=dy
      } else {
        camera.current.yaw+=dx*.009
        camera.current.pitch=clamp(camera.current.pitch+dy*.009,-1.54,1.54)
      }
      drag.x=event.clientX
      drag.y=event.clientY
      draw.current()
    }}
    onPointerCancel={()=>{interaction.current=null;layout.resume.current()}}
    onPointerUp={event=>{
      const drag=interaction.current
      interaction.current=null
      resumeAfterClick()
      if (!drag || drag.pan || Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)>5) {
        lastClick.current=null
        return
      }
      const bounds=event.currentTarget.getBoundingClientRect()
      const x=event.clientX-bounds.left,y=event.clientY-bounds.top
      const points=projected.current
      for (let i=points.length-1;i>=0;i--) {
        const node=points[i]
        if (node.alpha>0 && hitsNode(node,x,y) &&
            latest.current.nodes.some(candidate=>candidate.id===node.id)) {
          lastClick.current=node.id
          latest.current.choose(node.id,event.ctrlKey || event.metaKey)
          return
        }
      }
      lastClick.current=null
      latest.current.choose(null,false)
    }}
    onDoubleClick={event=>{
      const id=lastClick.current
      if (!event.ctrlKey && !event.metaKey && id && latest.current.nodes.some(node=>node.id===id)) {
        latest.current.open(id)
      }
    }} />
}
