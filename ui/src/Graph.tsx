import {useEffect, useMemo, useRef} from 'react'
import type {GraphView} from './api'
import type {LayoutScope} from './desktop'
import {useGraphLayout} from './useGraphLayout'
import type {Point} from './treeLayout'

type Node = {id:string; name:string; color:string}
type Projected = Node & {sx:number; sy:number; radius:number; depth:number}
const initialCamera=()=>({pitch:.12,yaw:-.35,distance:950,zoom:1,panX:0,panY:0,target:{x:0,y:0,z:0}})
const clamp=(value:number,min:number,max:number)=>Math.min(max,Math.max(min,value))

function fit(points:Point[]) {
  if (!points.length) return null
  const low={x:Infinity,y:Infinity,z:Infinity}, high={x:-Infinity,y:-Infinity,z:-Infinity}
  for (const point of points) for (const axis of ['x','y','z'] as const) {
    low[axis]=Math.min(low[axis],point[axis])
    high[axis]=Math.max(high[axis],point[axis])
  }
  const target={x:(low.x+high.x)/2,y:(low.y+high.y)/2,z:(low.z+high.z)/2}
  const radius=Math.max(20,Math.hypot(high.x-low.x,high.y-low.y,high.z-low.z)/2)
  const distance=Math.max(950,radius*2.4)
  return {target,distance,zoom:clamp(255*(distance-radius)/(950*radius),.1,2.2),panX:0,panY:0}
}

export default function Graph({scope,graph,selected,focus,reset,choose,open,report}:{
  scope:LayoutScope; graph?:GraphView; selected:ReadonlySet<string>; focus:number; reset:number;
  choose:(id:string|null,toggle:boolean)=>void; open:(id:string)=>void; report:(message:string)=>void
}) {
  const canvas=useRef<HTMLCanvasElement>(null)
  const projected=useRef<Projected[]>([])
  const draw=useRef(()=>{})
  const camera=useRef(initialCamera())
  const interaction=useRef<{x:number;y:number;startX:number;startY:number;pan:boolean}|null>(null)
  const cameraTouched=useRef(false)
  const nodes=useMemo(()=>graph?.nodes.map(node=>({
    id:node.id,name:node.name,color:node.quality?'#a3f1d3':'#42d6a0'
  })) || [],[graph])
  const edges=useMemo(()=>graph?.edges.map(edge=>({
    from:edge.source,to:edge.target,dependency:edge.dependency,
    certain:edge.certainty==='confirmed',kind:edge.kind
  })) || [],[graph])
  const layout=useGraphLayout(scope,graph,()=>draw.current(),positions=>{
    const view=fit(Object.values(positions))
    if (view && !cameraTouched.current) Object.assign(camera.current,view)
  },report)
  const latest=useRef({nodes,edges,selected,choose,open})
  latest.current={nodes,edges,selected,choose,open}

  const lastClick=useRef<string|null>(null)
  const priorReset=useRef(reset)
  const priorFocus=useRef(focus)
  const release=useRef<number|undefined>(undefined)
  function resumeAfterClick() {
    window.clearTimeout(release.current)
    release.current=window.setTimeout(()=>{if (!interaction.current) layout.resume.current()},180)
  }

  useEffect(()=>{
    const el=canvas.current
    if (!el) return
    const ctx=el.getContext('2d')
    if (!ctx) return
    let frame=0
    const paint=()=>{
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
      const {yaw,pitch,zoom,panX,panY,target,distance}=camera.current
      const {nodes,edges,selected}=latest.current
      const sinY=Math.sin(yaw),cosY=Math.cos(yaw),sinX=Math.sin(pitch),cosX=Math.cos(pitch)
      const scale=Math.min(width,height)/710
      const points=nodes.flatMap(node=>{
        const point=layout.coordinates.current[node.id]
        if (!point) return []
        const x=point.x-target.x,y=point.y-target.y,z=point.z-target.z
        const rx=x*cosY-z*sinY, rz=x*sinY+z*cosY
        const ry=y*cosX-rz*sinX, depth=distance+y*sinX+rz*cosX
        const perspective=950*scale*zoom/depth
        if (depth<50) return []
        return [{...node,depth,sx:width/2+rx*perspective+panX,sy:height/2-ry*perspective+panY,
          radius:clamp((nodes.length>250?6:10)*perspective,3,16)}]
      }).sort((a,b)=>b.depth-a.depth)
      projected.current=points
      const position=new Map(points.map(node=>[node.id,node]))
      for (const edge of edges) {
        const a=position.get(edge.from),b=position.get(edge.to)
        if (!a || !b) continue
        const important=selected.has(edge.from) || selected.has(edge.to)
        const color=edge.dependency?'#bc9ef0':edge.kind==='call'?'#74c7bf':'#829ca6'
        const dx=b.sx-a.sx,dy=b.sy-a.sy,len=Math.hypot(dx,dy)
        const shorten=b.radius+4
        ctx.globalAlpha=important?.9:.34
        ctx.strokeStyle=color
        ctx.lineWidth=edge.dependency?2:1.3
        ctx.setLineDash(edge.dependency?[3,4]:edge.certain?[]:[7,5])
        ctx.beginPath()
        if (a===b) ctx.arc(a.sx+a.radius,a.sy-a.radius,a.radius+5,0,Math.PI*2)
        else if (len>shorten) {
          ctx.moveTo(a.sx,a.sy)
          ctx.lineTo(b.sx-dx*shorten/len,b.sy-dy*shorten/len)
        }
        ctx.stroke()
        ctx.setLineDash([])
        if (len>shorten+10) {
          const angle=Math.atan2(dy,dx), tx=b.sx-dx*shorten/len, ty=b.sy-dy*shorten/len
          ctx.beginPath()
          ctx.moveTo(tx-6*Math.cos(angle-.55),ty-6*Math.sin(angle-.55))
          ctx.lineTo(tx,ty)
          ctx.lineTo(tx-6*Math.cos(angle+.55),ty-6*Math.sin(angle+.55))
          ctx.stroke()
        }
      }
      ctx.globalAlpha=1
      const labels=nodes.length<45 || (nodes.length<160 && zoom>1.65)
      for (const node of points) {
        const active=selected.has(node.id)
        paintNode(ctx,node,labels || (active && selected.size<=18),active)
      }
    }
    draw.current=()=>{if (!frame) frame=requestAnimationFrame(paint)}
    const observer=new ResizeObserver(draw.current)
    observer.observe(el)
    let wheel:number|undefined
    const zoom=(event:WheelEvent)=>{
      event.preventDefault()
      cameraTouched.current=true
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
    camera.current=initialCamera()
    const points=latest.current.nodes.flatMap(node=>layout.coordinates.current[node.id] || [])
    Object.assign(camera.current,fit(points))
    draw.current()
  },[reset])
  useEffect(()=>{
    if (priorFocus.current===focus) return
    priorFocus.current=focus
    cameraTouched.current=true
    const points=latest.current.nodes.flatMap(node=>
      latest.current.selected.has(node.id) ? (layout.coordinates.current[node.id] || []) : [])
    const view=fit(points)
    if (!view) return
    cameraTouched.current=true
    Object.assign(camera.current,view)
    draw.current()
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
        if (Math.hypot(node.sx-x,node.sy-y)<=node.radius+4 &&
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

function paintNode(ctx:CanvasRenderingContext2D,node:Projected,label:boolean,selected:boolean) {
  ctx.beginPath()
  ctx.arc(node.sx,node.sy,node.radius,0,Math.PI*2)
  ctx.fillStyle=node.color
  ctx.fill()
  ctx.lineWidth=selected?2.5:1
  ctx.strokeStyle=selected?'#fff4ce':'#14242a'
  ctx.stroke()
  if (selected) {
    ctx.beginPath()
    ctx.arc(node.sx,node.sy,node.radius+4,0,Math.PI*2)
    ctx.lineWidth=1.5
    ctx.stroke()
  }
  if (label) {
    ctx.font=selected?'600 15px Geist, Segoe UI, sans-serif':'12px Geist, Segoe UI, sans-serif'
    ctx.textAlign='center'
    const y=node.sy-node.radius-(selected?12:6)
    ctx.strokeStyle='#10191e'
    ctx.lineWidth=4
    ctx.strokeText(node.name,node.sx,y)
    ctx.fillStyle=selected?'#fff4ce':'#d9e9ec'
    ctx.fillText(node.name,node.sx,y)
  }
}
