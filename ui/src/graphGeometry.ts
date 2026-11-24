import type {GraphNode} from './api'
import type {Point} from './treeLayout'

export const clamp=(value:number,min:number,max:number)=>Math.min(max,Math.max(min,value))
const tau=2*Math.PI
type Screen = {x:number; y:number}
type Face = {vertices:Screen[]; shade:number}
export type Projected = GraphNode & {sx:number; sy:number; radius:number; depth:number; alpha:number;
  view:Point; faces:Face[]}

const cube = {
  vertices: [
    [-1,-1,-1], [1,-1,-1], [1,1,-1], [-1,1,-1],
    [-1,-1,1], [1,-1,1], [1,1,1], [-1,1,1]
  ].map(([x,y,z])=>({x:x/Math.sqrt(3),y:y/Math.sqrt(3),z:z/Math.sqrt(3)})),
  faces: [[0,3,2,1], [4,5,6,7], [0,1,5,4], [3,7,6,2], [0,4,7,3], [1,2,6,5]]
}
const octahedron = {
  vertices: [
    {x:1,y:0,z:0}, {x:-1,y:0,z:0}, {x:0,y:1,z:0},
    {x:0,y:-1,z:0}, {x:0,y:0,z:1}, {x:0,y:0,z:-1}
  ],
  faces: [[0,2,4], [2,1,4], [1,3,4], [3,0,4], [2,0,5], [1,2,5], [3,1,5], [0,3,5]]
}

const subtract=(a:Point,b:Point):Point=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z})
const cross=(a:Point,b:Point):Point=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x})
const dot=(a:Point,b:Point)=>a.x*b.x+a.y*b.y+a.z*b.z
const length=(p:Point)=>Math.hypot(p.x,p.y,p.z)
const normalized=(p:Point):Point=>{
  const size=length(p)
  return {x:p.x/size,y:p.y/size,z:p.z/size}
}
const light=normalized({x:-.45,y:.65,z:-1})

export function cameraProjection(yaw:number,pitch:number,distance:number,focal:number,x:number,y:number) {
  const sinY=Math.sin(yaw),cosY=Math.cos(yaw),sinX=Math.sin(pitch),cosX=Math.cos(pitch)
  const rotate=({x,y,z}:Point):Point=>{
    const rz=x*sinY+z*cosY
    return {x:x*cosY-z*sinY,y:y*cosX-rz*sinX,z:y*sinX+rz*cosX}
  }
  const project=(p:Point):Screen=>({x:x+p.x*focal/p.z,y:y-p.y*focal/p.z})
  return {rotate,project,distance,focal}
}
type Projection=ReturnType<typeof cameraProjection>

export function nodeRadius(degree:number,zoom:number) {
  return (18-13.5/Math.sqrt(1+degree*.9))*clamp(Math.sqrt(zoom),.58,1.55)
}

export function projectNode(node:GraphNode,point:Point,target:Point,radius:number,alpha:number,
                            camera:Projection):Projected|null {
  const view=camera.rotate(subtract(point,target))
  view.z+=camera.distance
  if (view.z<50) return null
  const {x:sx,y:sy}=camera.project(view)
  const faces:Face[]=[]
  const mesh=node.kind==='module'?cube:node.kind==='class'?octahedron:null
  if (mesh) {
    const worldRadius=radius*view.z/camera.focal
    const vertices=mesh.vertices.map(vertex=>{
      const p=camera.rotate(vertex)
      return {x:view.x+p.x*worldRadius,y:view.y+p.y*worldRadius,z:view.z+p.z*worldRadius}
    })
    const screen=vertices.map(camera.project)
    for (const indices of mesh.faces) {
      const [a,b,c]=indices.map(index=>vertices[index])
      const normal=normalized(cross(subtract(b,a),subtract(c,a)))
      if (dot(normal,a)<0) {
        faces.push({vertices:indices.map(index=>screen[index]),shade:dot(normal,light)})
      }
    }
  }
  return {...node,sx,sy,radius,depth:view.z,view,alpha,faces}
}

export function hitsNode(node:Projected,x:number,y:number) {
  if (Math.hypot(x-node.sx,y-node.sy)>node.radius+4) return false
  if (!node.faces.length) return true
  return node.faces.some(({vertices})=>vertices.every((start,i)=>{
    const end=vertices[(i+1)%vertices.length]
    const dx=end.x-start.x,dy=end.y-start.y
    return dx*(y-start.y)-dy*(x-start.x)>=-3*Math.hypot(dx,dy)
  }))
}

// Sample two opposed 3D strands around the edge's straight axis. Pixel endpoints
// become world-space fractions before sampling so trimming survives perspective.
export function helix(a:Projected,b:Projected,camera:Projection,start:number,end:number,
                      lane:Screen,screenLength:number) {
  const axis=subtract(b.view,a.view)
  const tangent=normalized(axis)
  const other=normalized(cross(tangent,{x:b.sy-a.sy,y:b.sx-a.sx,z:0}))
  const side=cross(other,tangent)
  const fraction=(s:number)=>s*a.depth/(b.depth*(1-s)+s*a.depth)
  const begin=fraction(start), finish=fraction(end)
  const turns=clamp(Math.round(screenLength/38),1,7)
  const samples=10*turns
  const halfWidth=clamp(screenLength/11,2.5,4.5)
  const amplitude=halfWidth*(a.depth+b.depth)/2/camera.focal
  const strands:[Screen[],Screen[]]=[[],[]]
  for (let step=0;step<=samples;step++) {
    const phase=tau*turns*step/samples
    const along=begin+(finish-begin)*step/samples
    const cos=Math.cos(phase)*amplitude,sin=Math.sin(phase)*amplitude
    const center={x:a.view.x+axis.x*along,y:a.view.y+axis.y*along,z:a.view.z+axis.z*along}
    for (const strand of [0,1] as const) {
      const sign=strand===0?1:-1
      const p=camera.project({
        x:center.x+sign*(side.x*cos+other.x*sin),
        y:center.y+sign*(side.y*cos+other.y*sin),
        z:center.z+sign*other.z*sin
      })
      strands[strand].push({x:p.x+lane.x,y:p.y+lane.y})
    }
  }
  return strands
}
