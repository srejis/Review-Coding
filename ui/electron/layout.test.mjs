import assert from 'node:assert/strict'
import {test} from 'node:test'
import {emptyLayout, REST, solveLayout, uniquePairs, validPoint} from '../src/incrementalLayout.ts'

const solve=(ids,pairs=[],prior=emptyLayout())=>solveLayout({ids,pairs,prior})
const point=(x,y=0,z=0)=>({x,y,z})
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)

test('zero, one, and disconnected nodes have stable finite positions',()=>{
  assert.equal(Object.keys(solve([]).positions).length,0)
  const first=solve(['a'])
  assert.deepEqual(first.positions.a,point(0))
  const extended=solve(['a','b','c'],[],first)
  assert.deepEqual(extended.positions.a,first.positions.a)
  assert.ok(distance(extended.positions.b,extended.positions.c)>0)
  assert.equal(extended.iterations,0)
  const corrupt=solve(['a'],[],{positions:{a:{x:Infinity}},pairs:[]})
  assert.deepEqual(corrupt.positions.a,point(0))
})

test('chain, tree, hub, cycle and dense layout remain deterministic and finite',()=>{
  const ids=Array.from({length:22},(_,i)=>'u'+i)
  const chain=ids.slice(1).map((id,i)=>[ids[i],id])
  const cases=[chain,ids.slice(1).map((id,i)=>[ids[Math.floor(i/2)],id]),
    ids.slice(1).map(id=>[ids[0],id]),[...chain,[ids.at(-1),ids[0]]],
    ids.flatMap((a,i)=>ids.slice(i+1).map(b=>[a,b]))]
  for (const pairs of cases) {
    const result=solve(ids,pairs)
    assert.ok(Object.values(result.positions).every(validPoint))
    assert.ok(result.iterations<=44)
    assert.deepEqual(solve([...ids].reverse(),[...pairs].reverse()).positions,result.positions)
    const repeat=solve(ids,pairs,result)
    assert.equal(repeat.iterations,0)
    assert.deepEqual(repeat.positions,result.positions)
  }
  assert.deepEqual(uniquePairs([['a','a'],['a','b'],['b','a']]),[['a','b']])
})

test('merging distant components reduces bridge length while preserving members',()=>{
  const prior={positions:{a:point(0),b:point(REST),c:point(900),d:point(900+REST)},
    pairs:[['a','b'],['c','d']]}
  const ids=['a','b','c','d']
  const merged=solve(ids,[...prior.pairs,['b','c']],prior)
  assert.ok(distance(merged.positions.b,merged.positions.c)<distance(prior.positions.b,prior.positions.c))
  for (const [a,b] of prior.pairs) assert.ok(Math.abs(distance(merged.positions[a],merged.positions[b])-REST)<70)
  const split=solve(ids,prior.pairs,merged)
  assert.equal(split.iterations,0)
  assert.deepEqual(split.positions,merged.positions)
})
