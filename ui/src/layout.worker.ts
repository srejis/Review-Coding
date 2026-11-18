import {solveLayout} from './incrementalLayout'
import type {LayoutRequest} from './incrementalLayout'

self.onmessage=({data}:{data:LayoutRequest & {generation:number}})=>{
  self.postMessage({...solveLayout(data),generation:data.generation})
}
