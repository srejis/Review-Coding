import themes from '../electron/themes.json'

export type Theme=keyof typeof themes
export const isTheme=(value:unknown):value is Theme=>typeof value==='string' && Object.hasOwn(themes,value)
export function currentTheme() {
  const id=document.documentElement.dataset.theme
  return themes[isTheme(id)?id:'editorial']
}
export const motionPreference=()=>matchMedia('(prefers-reduced-motion: reduce)')

export const themeChoices:ReadonlyArray<{id:Theme; name:string; description:string}>=[
  {id:'engineering',name:'Precision',description:'정밀한 그래프와 촘촘한 도구 배치'},
  {id:'editorial',name:'Editorial',description:'따뜻한 작업 공간과 넉넉한 읽기 여백'},
  {id:'spatial',name:'Spatial',description:'깊은 인디고 공간과 은은한 선택광'}
]
