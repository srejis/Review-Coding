import {useEffect, useMemo, useRef} from 'react'
import type {Snapshot} from './api'

type Point = {x:number; y:number; z:number}
type Node = Point & {id:string; name:string; color:string}
type Projected = Node & {sx:number; sy:number; radius:number; depth:number}
type Edge = {from:string; to:string; dependency:boolean; certain:boolean; kind:string}

function spherical(index:number, count:number, radius:number):Point {
  const y=1-2*(index+.5)/Math.max(count,1)
  const angle=index*Math.PI*(3-Math.sqrt(5))
  const plane=Math.sqrt(1-y*y)
  return {x:radius*plane*Math.cos(angle),y:radius*y,z:radius*plane*Math.sin(angle)}
}

export function graphData(snapshot?:Snapshot) {
  const units=Object.values(snapshot?.units || {})
  const files=new Map<string,typeof units>()
  for (const unit of units) {
    const group=files.get(unit.file)
    if (group) group.push(unit)
    else files.set(unit.file,[unit])
  }
  const nodes:Node[]=[]
  for (const [index,group] of [...files.values()].entries()) {
    const center=files.size===1 ? {x:0,y:0,z:0} : spherical(index,files.size,files.size<3?155:215)
    const spread=files.size===1 ? 210 : Math.min(66,190/Math.sqrt(files.size))
    group.forEach((unit,i)=>{
      const offset=group.length===1 ? {x:0,y:0,z:0} : spherical(i,group.length,spread)
      const status=snapshot?.results[unit.id]?.status
      const state=snapshot?.tasks[unit.id]?.state
      const color=state==='QUALITY_VERIFIED'?'#a3f1d3':status==='submitted'?'#42d6a0':
        status==='partial'?'#e7b870':status==='stale'?'#ef8e83':'#7f969d'
      nodes.push({id:unit.id,name:unit.name,color,x:center.x+offset.x,y:center.y+offset.y,z:center.z+offset.z})
    })
  }
  const edges:Edge[]=[]
  for (const [from,result] of Object.entries(snapshot?.results || {})) {
    if (result.status==='stale') continue
    for (const edge of result.relations) {
      if (edge.target && edge.target in (snapshot?.units || {})) {
        edges.push({from,to:edge.target,dependency:false,certain:edge.certainty==='confirmed',kind:edge.kind})
      }
    }
  }
  for (const [from,deps] of Object.entries(snapshot?.dependencies || {})) {
    if (snapshot?.results[from]?.status==='stale') continue
    for (const to of deps) edges.push({from,to,dependency:true,certain:true,kind:'dependency'})
  }
  return {nodes,edges}
}

const initialCamera=()=>({pitch:.12,yaw:-.35,zoom:1,panX:0,panY:0,target:{x:0,y:0,z:0}})
const clamp=(value:number,min:number,max:number)=>Math.min(max,Math.max(min,value))

export default function Graph({snapshot,selected,focus,reset,choose}:{
  snapshot?:Snapshot; selected:string; focus:number; reset:number; choose:(id:string)=>void
}) {
  const canvas=useRef<HTMLCanvasElement>(null)
  const projected=useRef<Projected[]>([])
  const draw=useRef(()=>{})
  const camera=useRef(initialCamera())
  const interaction=useRef<{x:number;y:number;startX:number;startY:number;pan:boolean}|null>(null)
  const {nodes,edges}=useMemo(()=>graphData(snapshot),[snapshot])
  const latest=useRef({nodes,edges,selected,choose})
  latest.current={nodes,edges,selected,choose}

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
      const {yaw,pitch,zoom,panX,panY,target}=camera.current
      const {nodes,edges,selected}=latest.current
      const sinY=Math.sin(yaw),cosY=Math.cos(yaw),sinX=Math.sin(pitch),cosX=Math.cos(pitch)
      const scale=Math.min(width,height)/710
      const points=nodes.flatMap(node=>{
        const x=node.x-target.x,y=node.y-target.y,z=node.z-target.z
        const rx=x*cosY-z*sinY, rz=x*sinY+z*cosY
        const ry=y*cosX-rz*sinX, depth=950+y*sinX+rz*cosX
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
        const important=edge.from===selected || edge.to===selected
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
        if (node.id===selected) continue
        paintNode(ctx,node,labels,false)
      }
      const active=position.get(selected)
      if (active) paintNode(ctx,active,true,true)
    }
    draw.current=()=>{if (!frame) frame=requestAnimationFrame(paint)}
    const observer=new ResizeObserver(draw.current)
    observer.observe(el)
    const zoom=(event:WheelEvent)=>{
      event.preventDefault()
      camera.current.zoom=clamp(camera.current.zoom*Math.exp(-event.deltaY*.0015),.42,5)
      draw.current()
    }
    el.addEventListener('wheel',zoom,{passive:false})
    draw.current()
    return ()=>{
      observer.disconnect()
      el.removeEventListener('wheel',zoom)
      cancelAnimationFrame(frame)
      draw.current=()=>{}
    }
  },[])
  useEffect(()=>{draw.current()},[nodes,edges,selected])
  useEffect(()=>{camera.current=initialCamera();draw.current()},[reset])
  useEffect(()=>{
    if (!focus) return
    const node=latest.current.nodes.find(item=>item.id===latest.current.selected)
    if (node) {
      camera.current.target=node
      camera.current.panX=camera.current.panY=0
      draw.current()
    }
  },[focus])

  return <canvas ref={canvas} className="graph-canvas" aria-label="Interactive 3D code graph"
    onContextMenu={event=>event.preventDefault()}
    onPointerDown={event=>{
      if (event.button!==0 && event.button!==1 && event.button!==2) return
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
    onPointerCancel={()=>{interaction.current=null}}
    onPointerUp={event=>{
      const drag=interaction.current
      interaction.current=null
      if (!drag || drag.pan || Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)>5) return
      const bounds=event.currentTarget.getBoundingClientRect()
      const x=event.clientX-bounds.left,y=event.clientY-bounds.top
      const points=projected.current
      for (let i=points.length-1;i>=0;i--) {
        const node=points[i]
        if (Math.hypot(node.sx-x,node.sy-y)<=node.radius+4) {
          latest.current.choose(node.id)
          break
        }
      }
    }} />
}

function paintNode(ctx:CanvasRenderingContext2D,node:Projected,label:boolean,selected:boolean) {
  ctx.beginPath()
  ctx.arc(node.sx,node.sy,node.radius+(selected?4:0),0,Math.PI*2)
  ctx.fillStyle=node.color
  ctx.fill()
  ctx.lineWidth=selected?2.5:1
  ctx.strokeStyle=selected?'#fff4ce':'#14242a'
  ctx.stroke()
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
