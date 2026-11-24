import type {GraphEdge} from './api'
import {clamp,helix} from './graphGeometry'
import type {cameraProjection,Projected} from './graphGeometry'
import {currentTheme} from './theme'

const TAU=Math.PI*2
type Screen={x:number; y:number}
type Edge=Pick<GraphEdge,'source'|'target'|'kind'> & {key:string; lane:number}
type Projection=ReturnType<typeof cameraProjection>
type EdgePath={length:number; start:Screen; end:Screen; dx:number; dy:number}

export function prepareEdges(edges:GraphEdge[]):Edge[] {
  const pairs=new Map<string,Edge[]>()
  for (const {source,target,kind} of edges) {
    const pair=JSON.stringify(source<target?[source,target]:[target,source])
    const group=pairs.get(pair) || []
    group.push({source,target,kind,key:JSON.stringify([source,target,kind]),lane:0})
    pairs.set(pair,group)
  }
  return [...pairs.values()].flatMap(group=>group.map((edge,index)=>{
    const from=edge.kind==='inheritance'?edge.target:edge.source
    const to=edge.kind==='inheritance'?edge.source:edge.target
    return {...edge,source:from,target:to,lane:(index-(group.length-1)/2)*(from<to?1:-1)}
  }))
}

function appendLine(ctx:CanvasRenderingContext2D,start:Screen,end:Screen) {
  ctx.moveTo(start.x,start.y)
  ctx.lineTo(end.x,end.y)
}

function arrow(ctx:CanvasRenderingContext2D,x:number,y:number,dx:number,dy:number,size:number) {
  ctx.moveTo(x-size*dx-size*.7*dy,y-size*dy+size*.7*dx)
  ctx.lineTo(x,y)
  ctx.lineTo(x-size*dx+size*.7*dy,y-size*dy-size*.7*dx)
}

function paintCall(ctx:CanvasRenderingContext2D,path:EdgePath,alpha:number,seconds:number) {
  const {start,end,dx,dy,length}=path
  ctx.beginPath()
  appendLine(ctx,start,end)
  ctx.globalAlpha=alpha*.3
  ctx.lineWidth=.9
  ctx.stroke()
  ctx.beginPath()
  const count=clamp(Math.floor(length/13),1,24)
  for (let i=0;i<count;i++) {
    const offset=((i+.65+seconds*1.8)%count)/count
    const at=5+offset*Math.max(0,length-7)
    arrow(ctx,start.x+at*dx,start.y+at*dy,dx,dy,Math.min(4.5,length*.35))
  }
  ctx.globalAlpha=alpha
  ctx.lineWidth=1.45
  ctx.stroke()
}

function paintLoop(ctx:CanvasRenderingContext2D,node:Projected,alpha:number,seconds:number) {
  const r=clamp(node.radius*.72,7,12)
  const x=node.sx+node.radius*.78,y=node.sy-node.radius*.68
  ctx.beginPath()
  ctx.arc(x,y,r,0,TAU)
  ctx.globalAlpha=alpha*.4
  ctx.lineWidth=1
  ctx.stroke()
  ctx.beginPath()
  for (let i=0;i<4;i++) {
    const angle=i*TAU/4+seconds*1.8
    arrow(ctx,x+r*Math.cos(angle),y+r*Math.sin(angle),-Math.sin(angle),Math.cos(angle),3.5)
  }
  ctx.globalAlpha=alpha
  ctx.lineWidth=1.45
  ctx.stroke()
}

function paintContains(ctx:CanvasRenderingContext2D,path:EdgePath,alpha:number,seconds:number) {
  ctx.globalAlpha=alpha*.32
  ctx.lineWidth=5.5
  ctx.beginPath()
  appendLine(ctx,path.start,path.end)
  ctx.stroke()
  ctx.globalAlpha=alpha
  ctx.lineWidth=1.55
  ctx.setLineDash([3,5])
  ctx.lineDashOffset=-(seconds*27)%8
  ctx.stroke()
  ctx.setLineDash([])
}

function paintInheritance(ctx:CanvasRenderingContext2D,strands:[Screen[],Screen[]],length:number,
                          alpha:number,seconds:number) {
  ctx.globalAlpha=alpha
  ctx.lineWidth=1.15
  ctx.beginPath()
  for (const strand of strands) {
    ctx.moveTo(strand[0].x,strand[0].y)
    for (let i=1;i<strand.length;i++) ctx.lineTo(strand[i].x,strand[i].y)
  }
  ctx.stroke()
  const count=clamp(Math.round(length/35),1,7)
  ctx.beginPath()
  for (const [side,strand] of strands.entries()) {
    const end=strand.length-1
    for (let i=0;i<count;i++) {
      const step=((i+.36+side*.45+seconds*.9)%count)/count*end
      const index=Math.floor(step), mix=step-index
      const a=strand[index],b=strand[index+1]
      const x=a.x+(b.x-a.x)*mix,y=a.y+(b.y-a.y)*mix
      ctx.moveTo(x+1.65,y)
      ctx.arc(x,y,1.65,0,TAU)
    }
  }
  ctx.globalAlpha=Math.min(1,alpha*1.45)
  ctx.fill()
}

const colors={contains:'#8fb2de',call:'#72d7c6',inheritance:'#daa9f0'}

export function paintEdge(ctx:CanvasRenderingContext2D, edge:Edge,a:Projected,b:Projected,
                          camera:Projection,alpha:number,seconds:number) {
  ctx.strokeStyle=ctx.fillStyle=colors[edge.kind]
  if (a===b) {
    if (edge.kind==='call') paintLoop(ctx,a,alpha,seconds)
    return
  }
  const dx=b.sx-a.sx,dy=b.sy-a.sy,len=Math.hypot(dx,dy)
  const trimA=a.radius+2,trimB=b.radius+2
  const length=len-trimA-trimB
  if (length<6) return
  const ux=dx/len,uy=dy/len
  const lane={x:-uy*edge.lane*9,y:ux*edge.lane*9}
  const start={x:a.sx+ux*trimA+lane.x,y:a.sy+uy*trimA+lane.y}
  const end={x:b.sx-ux*trimB+lane.x,y:b.sy-uy*trimB+lane.y}
  const path={start,end,length,dx:ux,dy:uy}
  if (edge.kind==='contains') paintContains(ctx,path,alpha,seconds)
  if (edge.kind==='call') paintCall(ctx,path,alpha,seconds)
  if (edge.kind==='inheritance') {
    const strands=helix(a,b,camera,trimA/len,1-trimB/len,lane,length)
    paintInheritance(ctx,strands,length,alpha,seconds)
  }
}

export function readMaterial(element:HTMLElement) {
  const css=getComputedStyle(element)
  const token=(name:string)=>css.getPropertyValue('--'+name).trim()
  return {theme:currentTheme(),node:token('node'),quality:token('node-quality'),
    stroke:token('node-stroke'),ring:token('ring'),text:token('stage-bright'),font:token('sans')}
}

export function paintNode(ctx:CanvasRenderingContext2D,node:Projected,label:boolean,selected:boolean,
                          material:ReturnType<typeof readMaterial>) {
  const {sx,sy,radius}=node
  const color=node.quality?material.quality:material.node
  ctx.globalAlpha=node.alpha
  ctx.strokeStyle=material.stroke
  ctx.lineWidth=.85
  if (node.faces.length) {
    for (const face of node.faces) {
      ctx.beginPath()
      ctx.moveTo(face.vertices[0].x,face.vertices[0].y)
      for (const vertex of face.vertices.slice(1)) ctx.lineTo(vertex.x,vertex.y)
      ctx.closePath()
      ctx.fillStyle=color
      ctx.fill()
      ctx.fillStyle=face.shade>0?`rgba(255,255,255,${face.shade*.32})`:
        `rgba(0,0,0,${-face.shade*.49})`
      ctx.fill()
      ctx.stroke()
    }
  } else {
    const gradient=ctx.createRadialGradient(sx-radius*.34,sy-radius*.4,0,sx,sy,radius)
    gradient.addColorStop(0,'#eaf7ff')
    gradient.addColorStop(.47,color)
    gradient.addColorStop(1,material.stroke)
    ctx.beginPath()
    ctx.arc(sx,sy,radius,0,TAU)
    ctx.fillStyle=gradient
    ctx.fill()
    ctx.stroke()
  }
  if (selected) {
    ctx.beginPath()
    ctx.arc(sx,sy,radius+4,0,TAU)
    ctx.strokeStyle=material.ring
    ctx.lineWidth=1.5
    if (material.theme.shape==='halo') {
      ctx.shadowColor=material.ring
      ctx.shadowBlur=10
    }
    ctx.stroke()
    ctx.shadowBlur=0
  }
  if (label) {
    ctx.font='600 13px '+material.font
    ctx.textAlign='center'
    const y=sy-radius-10
    ctx.strokeStyle=material.stroke
    ctx.lineWidth=4
    ctx.lineJoin='round'
    ctx.strokeText(node.name,sx,y)
    ctx.lineJoin='miter'
    ctx.fillStyle=material.text
    ctx.fillText(node.name,sx,y)
  }
}
