import {themeChoices} from './theme'
import type {Theme} from './theme'

export default function ThemePicker({value,disabled,onChange}:{
  value:Theme; disabled:boolean; onChange:(value:Theme)=>void
}) {
  return <fieldset className="theme-picker" disabled={disabled}>
    <legend>디자인 테마</legend>
    <p>설정을 저장하면 열려 있는 모든 창에 적용됩니다.</p>
    <div className="theme-options">
      {themeChoices.map(theme=><label className="theme-option" key={theme.id}>
        <input type="radio" name="appearance" value={theme.id} checked={value===theme.id}
          onChange={()=>onChange(theme.id)}/>
        <span className="theme-preview" data-theme={theme.id} aria-hidden="true">
          <span className="preview-toolbar"><b/><i/><i/></span>
          <span className="preview-workspace"><span className="preview-explorer"><i/><i/><i/></span>
            <span className="preview-stage"><i/><i/><i/></span></span>
        </span>
        <strong>{theme.name}</strong>
        <small>{theme.description}</small>
      </label>)}
    </div>
  </fieldset>
}
