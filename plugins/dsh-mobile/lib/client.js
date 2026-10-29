window.__ModuleLoader__.load({id:"dsh-mobile",factory:(require)=>{
var module={exports:{}}; var exports=module.exports;
/* Browser half of the mobile web plugin. Uses only installed rc.2 services. */
const React=require('react')
const h=React.createElement
const MOBILE_CSS="/* Accepted v6 compact messenger language, scoped to the opt-in surface. */\n.dsh-mobile{position:absolute;inset:0;z-index:100;pointer-events:auto;display:flex;justify-content:center;align-items:center;overflow:hidden;background:#f5f9f5;color:#284e39;font:13px/1.45 -apple-system,BlinkMacSystemFont,\"Segoe UI\",Arial,sans-serif}\n.dsh-mobile *{box-sizing:border-box}\n.dsh-mobile button,.dsh-mobile input,.dsh-mobile select,.dsh-mobile textarea{font:inherit;color:inherit}\n.dsh-mobile button{cursor:pointer}\n.dsh-mobile button:disabled{opacity:.5;cursor:not-allowed}\n.dsh-mobile a{color:#1d7151;overflow-wrap:anywhere}\n.dsh-mobile .m-icon{height:20px;width:20px;flex-shrink:0;display:inline-block}\n.dsh-mobile .m-shell{height:100%;min-height:0;max-width:580px;width:100%;display:flex;flex-direction:column;overflow:hidden;background:#f5f9f5}\n.dsh-mobile .m-page{height:100%;min-height:0;width:100%;display:flex;flex-direction:column;flex:1;overflow:hidden}\n.dsh-mobile .m-scroll{min-height:0;flex:1;overflow-y:auto;overscroll-behavior:contain;padding:0 12px 12px}\n.dsh-mobile .m-topline{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:10px 0 8px}\n.dsh-mobile .m-topline h1{font-size:21px;font-weight:850;letter-spacing:-.5px;margin:0;line-height:1.3}\n.dsh-mobile .m-topline small{font-size:10px;color:#819b8a}\n.dsh-mobile .m-square,.dsh-mobile .m-send{height:44px;width:44px;min-height:44px;min-width:44px;display:inline-grid;place-items:center;flex-shrink:0;background:#e9f4eb;border:1px solid #cfe3d6;border-radius:11px;color:#296a4c;padding:0}\n.dsh-mobile .m-square.m-quiet{background:transparent;border-color:transparent}\n.dsh-mobile .m-square.m-add,.dsh-mobile .m-send{background:#286f4c;color:white;border-color:#286f4c}\n.dsh-mobile .m-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:44px;padding:8px 12px;border-radius:11px;border:1px solid #d4e4d8;background:white;color:#426b51;font-size:12px;font-weight:750;text-align:center}\n.dsh-mobile .m-btn .m-icon{width:18px;height:18px}\n.dsh-mobile .m-btn.m-primary{color:white;background:#246e49;border-color:#246e49}\n.dsh-mobile .m-btn.m-soft,.dsh-mobile .m-square.m-soft{background:#e7f3e9;border-color:#c7e3ce}\n.dsh-mobile .m-btn.m-danger{color:white;background:#a84d43;border-color:#a84d43}\n.dsh-mobile .m-btn.m-full{width:100%}\n.dsh-mobile .m-nav{flex-shrink:0;height:calc(60px + env(safe-area-inset-bottom));padding:4px 7px calc(4px + env(safe-area-inset-bottom));display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:3px;background:#fff;border-top:1px solid #dfebe2}\n.dsh-mobile .m-nav button{border:0;border-radius:10px;min-height:48px;background:transparent;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:3px;color:#84a38f;font-size:10px;font-weight:750}\n.dsh-mobile .m-nav button.selected{background:#eaf4eb;color:#2c6b48}\n.dsh-mobile .m-nav .m-icon{width:19px;height:19px}\n.dsh-mobile .m-search{height:44px;display:flex;align-items:center;gap:8px;border:1px solid #d9e8de;border-radius:11px;background:white;margin:0 0 7px;padding:0 11px}\n.dsh-mobile .m-search .m-icon{width:17px;height:17px;color:#9eb5a3}\n.dsh-mobile .m-search input{width:100%;flex:1;min-width:0;height:44px;outline:none;border:0;background:transparent;font-size:13px}\n.dsh-mobile .m-filters{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px;margin-bottom:8px}\n.dsh-mobile .m-filters button{min-height:44px;border:1px solid #d5e6da;background:#fff;border-radius:10px;font-size:11px;font-weight:760}\n.dsh-mobile .m-filters button.active{color:#2c734c;background:#e1f1e5;border-color:#afd2b9}\n.dsh-mobile .m-project{margin-bottom:10px}\n.dsh-mobile .m-project-heading{display:flex;flex-direction:column;gap:1px;padding:0 3px;margin:9px 0 5px}\n.dsh-mobile .m-project-heading h2{font-size:11px;font-weight:850;display:flex;align-items:center;gap:6px;color:#5f8168;margin:0}\n.dsh-mobile .m-project-heading h2 .m-icon{height:13px;width:13px}\n.dsh-mobile .m-project-heading code{font:9px/1.4 Consolas,monospace;color:#7f9585;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}\n.dsh-mobile .m-chat-rows{border:1px solid #dbe8df;background:white;border-radius:12px;overflow:hidden}\n.dsh-mobile .m-chat-row{width:100%;min-height:77px;display:flex;align-items:flex-start;gap:9px;text-align:left;border:0;border-bottom:1px solid #e4eee6;padding:9px 10px;background:white;color:inherit}\n.dsh-mobile .m-chat-row:last-child{border-bottom:0}\n.dsh-mobile .m-chat-row:active,.dsh-mobile .m-file-row:active{background:#edf5ef}\n.dsh-mobile .m-avatar{width:37px;height:37px;display:grid;place-items:center;flex-shrink:0;margin-top:2px;border-radius:50%;background:#e2f2e7;color:#37845a}\n.dsh-mobile .m-avatar .m-icon{height:19px;width:19px}\n.dsh-mobile .m-chat-copy{flex:1;min-width:0;display:block}\n.dsh-mobile .m-chat-head{display:flex;align-items:baseline;justify-content:space-between;gap:6px;min-width:0}\n.dsh-mobile .m-chat-head strong{font-size:12px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:0;flex:1}\n.dsh-mobile .m-chat-head small{font-size:10px;color:#96a99a;flex-shrink:0}\n.dsh-mobile .m-chat-excerpt{display:block;color:#789280;font-size:11px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.dsh-mobile .m-chat-meta{display:flex;align-items:center;gap:5px;color:#879b8b;font-size:10px;margin-top:4px}\n.dsh-mobile .m-dot{width:6px;height:6px;border-radius:50%;background:#a7b8a9}\n.dsh-mobile .m-dot.working{background:#32a46b}\n.dsh-mobile .m-dot.waiting{background:#dba348}\n.dsh-mobile .m-pagebar{display:flex;align-items:center;gap:6px;min-height:53px;padding:5px 9px;background:#fff;border-bottom:1px solid #e0ebe3;flex-shrink:0}\n.dsh-mobile .m-page-title{min-width:0;flex:1;display:flex;flex-direction:column;justify-content:center}\n.dsh-mobile .m-page-title strong{font-size:13px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.dsh-mobile .m-page-title small{font-size:10px;color:#819786}\n.dsh-mobile .m-new{padding-top:11px}\n.dsh-mobile .m-field{margin-bottom:13px}\n.dsh-mobile .m-field>label,.dsh-mobile .m-field>h2{display:block;font-size:11px;font-weight:800;margin:0 0 6px;color:#537961}\n.dsh-mobile .m-textfield{height:44px;width:100%;background:white;padding:0 11px;border:1px solid #d5e6db;border-radius:11px;font-size:13px}\n.dsh-mobile .m-folder-card{border:1px solid #dae9df;background:white;padding:9px;border-radius:12px}\n.dsh-mobile .m-path{display:block;min-height:38px;max-height:95px;overflow:auto;padding:8px 9px;border-radius:9px;color:#6a8775;background:#f3f7f4;font:11px/1.4 Consolas,monospace;overflow-wrap:anywhere}\n.dsh-mobile .m-actions{display:flex;align-items:stretch;gap:7px;margin-top:8px}\n.dsh-mobile .m-actions>.m-btn{flex:1;min-width:0}\n.dsh-mobile .m-presets{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}\n.dsh-mobile .m-preset{min-height:70px;min-width:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:5px;padding:6px 4px;border:1px solid #d6e7db;border-radius:11px;background:#fff}\n.dsh-mobile .m-preset .m-icon{height:24px;width:24px;color:#3a8458}\n.dsh-mobile .m-preset strong{font-size:10px;line-height:1.2;overflow-wrap:anywhere}\n.dsh-mobile .m-preset.active{background:#e7f4ea;border-color:#83b99b}\n.dsh-mobile .m-tuning{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin:0 0 7px}\n.dsh-mobile .m-tuning label{display:flex;align-items:center;gap:5px;padding:0 6px;border:1px solid #d4e5d9;background:#f2f7f3;border-radius:10px;height:44px;min-width:0;color:#6b8e79;font-size:10px}\n.dsh-mobile .m-tuning select{border:0;background:transparent;outline:0;height:44px;flex:1;min-width:0;width:100%;font-size:11px;color:#285b40}\n.dsh-mobile .m-sticky{padding:8px 11px calc(9px + env(safe-area-inset-bottom));border-top:1px solid #e1eae3;background:#fff}\n.dsh-mobile .m-chat-path{flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#8b9f90;font:10px/1.3 Consolas,monospace;background:#f4f9f5;padding:6px 12px}\n.dsh-mobile .m-task-route{display:flex;gap:6px;align-items:center;padding:3px 8px;background:#eef6f0;flex-shrink:0}\n.dsh-mobile .m-task-route>span{flex:1;min-width:0}\n.dsh-mobile .m-task-route strong,.dsh-mobile .m-task-route small{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}\n.dsh-mobile .m-task-route strong{font-size:11px}\n.dsh-mobile .m-task-route small{font-size:10px;color:#839b88}\n.dsh-mobile .m-status{min-height:44px;display:flex;align-items:center;gap:7px;margin:1px 11px;color:#658d73;flex-shrink:0}\n.dsh-mobile .m-status>.m-icon{width:25px;height:25px;background:#e7f1e9;border-radius:8px;padding:5px}\n.dsh-mobile .m-status strong{font-size:11px;flex:1}\n.dsh-mobile .m-messages{min-height:0;flex:1;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:12px;padding:9px 12px 13px}\n.dsh-mobile .m-bubble-user{align-self:flex-end;max-width:85%;padding:10px 12px;border-radius:14px 14px 4px 14px;background:#e2efe4;color:#315c41;font-size:12px;overflow-wrap:anywhere}\n.dsh-mobile .m-agent{overflow-wrap:anywhere;max-width:100%;font-size:12px;color:#31553f}\n.dsh-mobile .m-agent-name{display:block;color:#71947a;font-size:10px;font-weight:750;margin:0 0 4px}\n.dsh-mobile .m-live{opacity:.82}\n.dsh-mobile .m-markdown{overflow-wrap:anywhere}\n.dsh-mobile .m-markdown p{line-height:1.5;margin:0 0 7px;white-space:pre-wrap}\n.dsh-mobile .m-markdown p:last-child{margin-bottom:0}\n.dsh-mobile .m-markdown h1,.dsh-mobile .m-markdown h2,.dsh-mobile .m-markdown h3{margin:8px 0 5px;font-size:14px}\n.dsh-mobile .m-markdown ul{padding-left:19px;margin:5px 0}\n.dsh-mobile .m-markdown li{line-height:1.5}\n.dsh-mobile .m-markdown code{background:#e5eee7;padding:1px 3px;border-radius:4px;font:11px Consolas,monospace}\n.dsh-mobile .m-markdown pre,.dsh-mobile .m-tool pre{max-width:100%;overflow:auto;white-space:pre-wrap;word-break:break-word;background:#eaf0e9;border-radius:9px;padding:10px;font:11px/1.5 Consolas,monospace}\n.dsh-mobile .m-tool{border:1px solid #dde9df;border-radius:10px;background:white;padding:8px 10px;font-size:11px}\n.dsh-mobile .m-note{color:#819a88;font-size:11px;line-height:1.4;text-align:center;margin:5px 0}\n.dsh-mobile .m-error{font-size:11px;color:#a14939;background:#fff0e9;border-radius:8px;padding:7px 9px}\n.dsh-mobile .m-empty{border:1px solid #e1eae3;border-radius:12px;background:#fff;color:#839b8a;padding:22px 10px;text-align:center;font-size:12px}\n.dsh-mobile .m-readonly{padding:13px;text-align:center;color:#799182;background:#fff;border-top:1px solid #dae8dc}\n.dsh-mobile .m-composer{flex-shrink:0;border-top:1px solid #deebe1;background:#fff;padding:5px 9px calc(8px + env(safe-area-inset-bottom))}\n.dsh-mobile .m-composer-top{display:flex;align-items:center;gap:6px;min-height:44px;margin-bottom:4px}\n.dsh-mobile .m-recipient{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#60806d;font-size:11px}\n.dsh-mobile .m-usage{min-height:32px;padding:6px 8px;border:1px solid #dbe6de;border-radius:9px;background:#f5f8f5;font-size:11px;font-weight:750;white-space:nowrap}\n.dsh-mobile .m-send-row{display:flex;align-items:flex-end;gap:6px}\n.dsh-mobile .m-send-row textarea{flex:1;min-height:44px;max-height:108px;min-width:0;resize:vertical;border-radius:11px;border:1px solid #d5e5db;background:#f9fbf9;padding:10px 12px;font-size:13px}\n.dsh-mobile .m-tree-children{padding-left:14px;margin:6px 0 8px 14px;border-left:1px solid #bedaca}\n.dsh-mobile .m-tree-entry{margin:0 0 5px}\n.dsh-mobile .m-tree-card{display:flex;align-items:center;gap:2px;min-height:54px;padding:2px;border:1px solid #d9e5db;border-radius:12px;background:#fff}\n.dsh-mobile .m-tree-card.m-root{max-width:300px;margin:0 auto 7px}\n.dsh-mobile .m-tree-card.selected{box-shadow:inset 0 0 0 1px #83bda0}\n.dsh-mobile .m-tree-main{display:flex;align-items:center;gap:7px;flex:1;min-width:0;min-height:48px;padding:5px 6px;border:0;background:transparent;text-align:left}\n.dsh-mobile .m-tree-main>.m-icon{width:26px;height:26px;color:#368153;background:#eaf4eb;border-radius:8px;padding:5px}\n.dsh-mobile .m-tree-main>span{flex:1;min-width:0}\n.dsh-mobile .m-tree-main strong,.dsh-mobile .m-tree-main small{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}\n.dsh-mobile .m-tree-main strong{font-size:11px}\n.dsh-mobile .m-tree-main small{font-size:9px;color:#8eaa94}\n.dsh-mobile .m-tree-main em{flex-shrink:0;font-style:normal;font-size:9px;color:#759d82}\n.dsh-mobile .m-questions{padding-top:8px}\n.dsh-mobile .m-question{padding:9px 0;margin:0 0 12px;border:0;min-width:0}\n.dsh-mobile .m-question legend{font-size:10px;color:#71947b}\n.dsh-mobile .m-question h2{font-size:18px;margin:0 0 10px}\n.dsh-mobile .m-answer{min-height:48px;padding:8px 10px;display:flex;align-items:center;gap:10px;margin:6px 0;border:1px solid #d7e6db;border-radius:11px;background:#fff}\n.dsh-mobile .m-answer input{width:18px;height:18px;accent-color:#2e8055}\n.dsh-mobile .m-answer span{font-size:12px}\n.dsh-mobile .m-answer small{display:block;font-size:10px;color:#8c9c8f}\n.dsh-mobile .m-question textarea{width:100%;padding:10px;border:1px solid #d7e6da;background:#fff;border-radius:11px;margin-top:6px}\n.dsh-mobile .m-tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px;padding:4px;border-radius:11px;background:#eaf3ec;margin:5px 0 12px}\n.dsh-mobile .m-tabs button{min-height:44px;border:0;background:transparent;border-radius:9px;font-size:11px;font-weight:800}\n.dsh-mobile .m-tabs button.active{background:#fff;color:#34724e;box-shadow:0 1px 4px #1b3d2218}\n.dsh-mobile .m-result-caption{font-size:11px;color:#638970;margin:6px 0;overflow-wrap:anywhere}\n.dsh-mobile .m-file-row{display:flex;align-items:center;gap:10px;text-align:left;min-height:55px;width:100%;padding:8px 5px;border:0;border-bottom:1px solid #e5eee6;background:#fff;border-radius:0;color:#2d5c42}\n.dsh-mobile .m-file-row span{flex:1;min-width:0;overflow-wrap:anywhere;font-size:12px}\n.dsh-mobile .m-file-row .m-icon:last-child{color:#7da188}\n.dsh-mobile .m-result-list,.dsh-mobile .m-preview{border:1px solid #d9e9de;background:#fff;padding:10px;border-radius:12px}\n.dsh-mobile .m-preview-title{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;font-weight:850;margin-bottom:10px}\n.dsh-mobile .m-preview .m-frame{width:100%;min-height:55vh;border:0;background:white}\n.dsh-mobile .m-preview .m-image{max-width:100%;max-height:65vh;object-fit:contain}\n.dsh-mobile .m-web-link{padding:9px 11px;margin-bottom:7px;border-radius:10px;background:#fff;border:1px solid #d9e9dd;font-size:11px;overflow-wrap:anywhere}\n.dsh-mobile .m-action-card{display:flex;align-items:center;gap:9px;min-height:60px;padding:8px 10px;margin-bottom:7px;background:#fff;border:1px solid #d6e6dc;border-radius:12px}\n.dsh-mobile .m-action-card h2{font-size:12px;flex:1;margin:0}\n.dsh-mobile .m-modal-mask{position:absolute;inset:0;z-index:50;display:flex;align-items:flex-end;justify-content:center;padding:9px 9px calc(10px + env(safe-area-inset-bottom));background:rgba(18,46,29,.44)}\n.dsh-mobile .m-sheet{width:100%;max-width:560px;max-height:84vh;overflow:auto;padding:13px;background:#fff;border-radius:19px;box-shadow:0 21px 62px #18382243}\n.dsh-mobile .m-sheet-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px}\n.dsh-mobile .m-sheet-head h2{margin:0;font-size:16px}\n.dsh-mobile .m-toast{position:absolute;z-index:80;bottom:calc(69px + env(safe-area-inset-bottom));left:12px;right:12px;padding:10px 12px;background:#2c523d;color:white;border-radius:10px;box-shadow:0 7px 25px #294d3930;font-size:11px}\n.dsh-mobile button:focus-visible,.dsh-mobile input:focus-visible,.dsh-mobile select:focus-visible,.dsh-mobile textarea:focus-visible,.dsh-mobile a:focus-visible{outline:2px solid #2b8559;outline-offset:2px}\n@media(min-width:600px){.dsh-mobile .m-shell{width:412px;height:min(872px,calc(100dvh - 36px));border:6px solid #e3ebe4;border-radius:32px;box-shadow:0 30px 80px #18402b1d}}\n@media(max-width:359px){.dsh-mobile .m-scroll{padding-left:9px;padding-right:9px}.dsh-mobile .m-chat-row{padding:8px 7px}.dsh-mobile .m-tree-children{padding-left:10px;margin-left:10px}.dsh-mobile .m-tuning label{gap:2px;padding:0 4px}.dsh-mobile .m-tuning select{font-size:10px}}\n@media(prefers-reduced-motion:reduce){.dsh-mobile *{transition:none!important;scroll-behavior:auto!important}}\n"
const EMPTY_SESSIONS=Object.freeze({ids:[],byId:{},subagentsByParent:{}})
const EMPTY_WORKSPACES=Object.freeze({items:[],archivedSessionIds:[]})
const EMPTY_CHAT=Object.freeze({nodes:[],queue:[],pending:[],partial:null,openState:'cold'})
const noop=()=>{}
const ICONS={
  chat:['M20 11.5a8 8 0 0 1-8 8 9 9 0 0 1-3.6-.8L4 20l1.6-4.2A8 8 0 1 1 20 11.5Z'],
  tree:['M12 2v6','M5 21v-8h14v8','M5 13V9h14v4'],
  folder:['M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2-2Z'],
  plus:['M12 5v14','M5 12h14'], back:['m15 5-7 7 7 7'],
  next:['M4 12h16','m13 5 7 7-7 7'],
  search:['M19 19l3 3','M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0'],
  stop:['M6 6h12v12H6z'],power:['M12 2v10','M6 6a9 9 0 1 0 12 0'],
  more:['M5 12h.01','M12 12h.01','M19 12h.01'],
  close:['M5 5l14 14','M19 5L5 19'],
  file:['M7 3h8l4 4v14H5V5a2 2 0 0 1 2-2Z','M15 3v5h4'],
  check:['m5 12 5 5 9-10'],
  layers:['m3 7 9-5 9 5-9 5-9-5Z','m3 12 9 5 9-5','m3 17 9 5 9-5'],
  down:['m6 9 6 6 6-6'], up:['m6 15 6-6 6 6']
}
function ico(id) {
  return h('svg',{className:'m-icon',viewBox:'0 0 24 24',fill:'none',
    stroke:'currentColor',strokeWidth:1.8,strokeLinecap:'round',
    strokeLinejoin:'round','aria-hidden':true},
    ...(ICONS[id]||ICONS.file).map((d,i)=>h('path',{d,key:i})))
}
function btn(title,icon,action,cls='m-square',attrs={}) {
  return h('button',{type:'button',className:cls,title,'aria-label':title,onClick:action,...attrs},
    ico(icon),cls.includes('m-btn')?h('span',null,title):null)
}
function useObs(source,fallback) {
  const subscribe=React.useCallback(listener=>source?.subscribe(listener)||noop,[source])
  const read=React.useCallback(()=>source?.getSnapshot()??fallback,[source,fallback])
  return React.useSyncExternalStore(subscribe,read,read)
}
function valueOf(response) {
  const result=response?.result??response
  if(result?.ok)return result.value
  throw new Error(result?.error?.message||'DSH не ответил')
}
function shortDate(ms) {
  return Number.isFinite(ms)?new Date(ms).toLocaleDateString('ru-RU',{day:'numeric',month:'short'}):''
}
function normalizedPath(value){return String(value||'').replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase()}
function projectOf(workspaces,cwd) {
  const target=normalizedPath(cwd)
  if(!target)return null
  return [...(workspaces.items||[])].sort((a,b)=>b.path.length-a.path.length).find(w=>{
    const root=normalizedPath(w.path)
    return target===root||target.startsWith(root+'/')
  })||null
}
function projectRelative(root,cwd){
  return String(cwd||'').replace(/\\/g,'/').slice(String(root||'').replace(/\\/g,'/').replace(/\/+$/,'').length).replace(/^\//,'')
}
function pathChild(path,name){return path?path+'/'+name:name}
function pathForHost(root,path){
  const windows=/\\/.test(root)
  const separator=windows?'\\':'/'
  return root+(path?separator+path.split('/').join(separator):'')
}
function pressurePercent(value){
  const count=value?.projectedTokens??value?.pressureTokens
  return count===undefined||!value?.contextWindow?'—':
    Math.min(100,Math.round(count/value.contextWindow*100))+'%'
}
function rootOf(byId,id) {
  let root=id,seen=new Set()
  while(root&&byId[root]?.parentId&&byId[root]?.origin==='subagent'&&!seen.has(root)){
    seen.add(root);root=byId[root].parentId
  }
  return root
}
function descendantBranches(catalogs,root) {
  const visited=new Set()
  function visit(id){
    if(!id||visited.has(id))return
    visited.add(id)
    for(const child of catalogs[id]?.entries||[])if(child.kind==='child'&&child.hasChildren)visit(child.id)
  }
  visit(root)
  return [...visited]
}
function catalogModels(groups){
  const models=[]
  for(const group of groups||[])for(const model of group.models||[])
    models.push({
      key:group.id+'\u0000'+model.id,
      provider:group.id,model:model.id,
      label:(group.name||group.id)+' · '+(model.name||model.id),
      efforts:model.reasoning?.efforts||[],
      defaultEffort:model.reasoning?.defaultEffort
    })
  return models
}
function contentText(content){
  return (content||[]).map(part=>part?.type==='text'?part.text:part?.kind==='text'?part.text:'').filter(Boolean).join('\n')
}
/** The rc.2 session list has no last-message field. Show only transcript text
 * already loaded by the normal runtime; never fabricate a status as a snippet. */
function recentTextOf(session){
  const view=session?.getSnapshot?.()
  if(!view||view.openState!=='open')return ''
  const nodes=view.chat?.legacy?.nodes||view.nodes||[]
  for(let i=nodes.length-1;i>=0;i--){
    const node=nodes[i]
    const text=node.kind==='assistant'?node.blocks?.filter(x=>x.kind==='text').map(x=>x.text).join(' '):
      node.kind==='user'?contentText(node.content):''
    if(text?.trim())return text.trim().replace(/\s+/g,' ').slice(0,180)
  }
  return ''
}
function urlIfReachable(text){
  try {
    const url=new URL(text)
    if(!['http:','https:'].includes(url.protocol))return null
    if(/^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])$/i.test(url.hostname))return null
    return url.href
  } catch{return null}
}
/** Markdown is rendered as React text elements, never executable HTML. */
function mdInline(text){
  const result=[]
  const tick=String.fromCharCode(96)
  const regex=new RegExp('\\[([^\\]]+)\\]\\(([^)]+)\\)|\\*\\*([^*]+)\\*\\*|'+tick+'([^'+tick+']+)'+tick,'g')
  let at=0,match
  while((match=regex.exec(text))){
    if(match.index>at)result.push(text.slice(at,match.index))
    if(match[1]!==undefined){
      const url=urlIfReachable(match[2])
      result.push(url?h('a',{href:url,key:match.index,target:'_blank',rel:'noopener noreferrer'},match[1]):
        h('span',{key:match.index,title:'Адрес недоступен на Android'},match[1]))
    }else if(match[3]!==undefined)result.push(h('strong',{key:match.index},match[3]))
    else result.push(h('code',{key:match.index},match[4]))
    at=regex.lastIndex
  }
  if(at<text.length)result.push(text.slice(at))
  return result
}
function Markdown({text}){
  const lines=String(text||'').split('\n'),rows=[]
  const fence=String.fromCharCode(96).repeat(3)
  for(let i=0;i<lines.length;){
    const key=i,line=lines[i]
    if(line.startsWith(fence)){
      const code=[];i++
      while(i<lines.length&&!lines[i].startsWith(fence))code.push(lines[i++])
      if(i<lines.length)i++
      rows.push(h('pre',{key},h('code',null,code.join('\n'))))
    }else if(/^#{1,3} /.test(line)){
      const level=line.match(/^#+/)[0].length
      rows.push(h('h'+level,{key},...mdInline(line.slice(level+1))));i++
    }else if(/^\s*[-*] /.test(line)){
      const list=[]
      while(i<lines.length&&/^\s*[-*] /.test(lines[i]))
        list.push(h('li',{key:i},...mdInline(lines[i++].replace(/^\s*[-*] /,''))))
      rows.push(h('ul',{key},...list))
    }else if(!line.trim())i++
    else {
      const para=[line];i++
      while(i<lines.length&&lines[i].trim()&&!/^(?:#{1,3} |\s*[-*] )/.test(lines[i])&&!lines[i].startsWith(fence))
        para.push(lines[i++])
      rows.push(h('p',{key},...mdInline(para.join('\n'))))
    }
  }
  return h('div',{className:'m-markdown'},...rows)
}
function renderNode(node) {
  if(!node)return null
  if(node.kind==='user'||node.kind==='steering')
    return h('div',{className:'m-bubble-user',key:node.seq},h(Markdown,{text:contentText(node.content)}))
  if(node.kind==='assistant')
    return h('article',{className:'m-agent',key:node.seq},
      h('small',{className:'m-agent-name'},'Агент',node.interrupted?' · остановлен':''),
      ...(node.blocks||[]).filter(x=>x.kind==='text').map((x,i)=>h(Markdown,{key:i,text:x.text})))
  if(node.kind==='tool-result')
    return h('details',{className:'m-tool',key:node.seq},
      h('summary',null,(node.call?.name||'Инструмент')+(node.isError?' · ошибка':'')),
      h('pre',null,contentText(node.content).slice(0,12000)))
  if(node.kind==='turn-error')
    return h('p',{className:'m-error',key:node.seq},node.message)
  if(node.kind==='compaction')
    return h('p',{className:'m-note',key:node.seq},'Контекст сжат',node.shadowedItemCount!=null?' · '+node.shadowedItemCount+' элементов':'')
  if(node.kind==='command')
    return h('p',{className:'m-note',key:node.seq},'/'+(node.name||'команда')+(node.outcome?.text?' · '+node.outcome.text:''))
  return null
}
function externalLinks(nodes){
  const found=new Set()
  for(const node of nodes){
    const str=node.kind==='assistant'?(node.blocks||[]).filter(b=>b.kind==='text').map(b=>b.text).join('\n'):''
    for(const match of str.matchAll(/https?:\/\/[^\s<>"')\]]+/g))
      found.add(match[0].replace(/[.,;]+$/,''))
  }
  return [...found].slice(-25)
}
function QuestionForm({wait,onDone,onError}) {
  const [values,setValues]=React.useState({})
  const [busy,setBusy]=React.useState(false)
  const update=(id,fields)=>setValues(v=>({...v,[id]:{...(v[id]||{}),...fields}}))
  const questions=wait.payload.questions
  async function respond(cancel){
    if(busy)return
    const answers=questions.map(q=>({
      id:q.id,selected:values[q.id]?.selected||[],
      ...(values[q.id]?.custom?.trim()?{custom:values[q.id].custom.trim()}: {})
    }))
    if(!cancel&&answers.some(x=>!x.selected.length&&!x.custom)){
      onError('Ответьте на каждый вопрос');return
    }
    setBusy(true)
    try {
      const result=cancel?
        {ok:false,error:{code:'cancelled',message:'Вопрос закрыт пользователем',details:{}}}:
        {ok:true,value:{sessionId:wait.sessionId,answer:{answers}}}
      const receipt=await wait.respond(result)
      if(!receipt.accepted)throw Error('Вопрос уже не ожидается: '+receipt.reason)
      onDone()
    }catch(e){onError(e.message)}finally{setBusy(false)}
  }
  return h('div',{className:'m-questions'},
    ...questions.map((q,index)=>{
      const chosen=values[q.id]?.selected||[]
      return h('fieldset',{className:'m-question',key:q.id},
        h('legend',null,q.header||'Вопрос '+(index+1)),h('h2',null,q.question),
        q.detail?h(Markdown,{text:q.detail}):null,
        ...(q.options||[]).map(o=>h('label',{key:o.label,className:'m-answer'},
          h('input',{
            type:q.multiSelect?'checkbox':'radio',name:q.id,
            checked:chosen.includes(o.label),
            onChange:()=>{
              const next=q.multiSelect?(chosen.includes(o.label)?chosen.filter(x=>x!==o.label):[...chosen,o.label]):[o.label]
              update(q.id,{selected:next})
            }
          }),h('span',null,o.label,o.description?h('small',null,o.description):null))),
        h('textarea',{rows:2,placeholder:'Другой ответ…','aria-label':'Свой ответ',
          value:values[q.id]?.custom||'',onChange:e=>update(q.id,{custom:e.target.value})}))
    }),
    h('div',{className:'m-actions'},
      h('button',{type:'button',className:'m-btn',disabled:busy,onClick:()=>respond(true)},'Отменить'),
      h('button',{type:'button',className:'m-btn m-primary',disabled:busy,onClick:()=>respond(false)},'Ответить')))
}
function MobileApp({ctx}){
  const sessions=useObs(ctx.sessions.list,EMPTY_SESSIONS)
  const workspaces=useObs(ctx.workspaces.list,EMPTY_WORKSPACES)
  const hostDescription=useObs(ctx.connection.hostDescription,null)
  const [screen,setScreen]=React.useState('chats')
  const [selected,setSelected]=React.useState(null)
  const [selectedAddress,setSelectedAddress]=React.useState(null)
  const [createPending,setCreatePending]=React.useState(null)
  const [filter,setFilter]=React.useState('all')
  const [search,setSearch]=React.useState('')
  const [searchResults,setSearchResults]=React.useState([])
  const [notice,setNotice]=React.useState('')
  const [busy,setBusy]=React.useState(false)
  const [modal,setModal]=React.useState(null)
  const [newTitle,setNewTitle]=React.useState('')
  const [newFolder,setNewFolder]=React.useState(null)
  const [newPreset,setNewPreset]=React.useState('')
  const [newModel,setNewModel]=React.useState('')
  const [newEffort,setNewEffort]=React.useState('')
  const [presets,setPresets]=React.useState([])
  const [catalog,setCatalog]=React.useState([])
  const [sessionModels,setSessionModels]=React.useState(null)
  const [draft,setDraft]=React.useState('')
  const [browse,setBrowse]=React.useState(null)
  const [collapsed,setCollapsed]=React.useState({})
  const [resultTab,setResultTab]=React.useState('md')
  const [preview,setPreview]=React.useState(null)
  const [restart,setRestart]=React.useState('idle')
  const endRef=React.useRef(null)
  const selectedSummary=sessions.byId?.[selected]
  const rootId=rootOf(sessions.byId||{},selected||sessions.current)
  const binding=ctx.sessions.binding(selected||'')
  const snapshot=useObs(binding?.session,EMPTY_CHAT)
  const projection=React.useMemo(()=>binding?.session.projections?.faceOf('contextPressure'),[binding])
  const pressure=useObs(projection,null)
  const childAddress=selectedAddress||ctx.sessions.subagentAddress?.(selected||'')||snapshot.subagent?.address
  const child=!!childAddress||selectedSummary?.origin==='subagent'
  const oneShot=childAddress?.mode==='one-shot'
  const readOnly=oneShot||snapshot.removed===true||(child&&(!childAddress||snapshot.subagent?.parentAvailable===false))
  const waiting=snapshot.pending?.find(x=>x.kind==='question')
  const archived=new Set(workspaces.archivedSessionIds||[])
  const modelChoices=catalogModels(sessionModels?.groups)
  const modelChoicesNew=catalogModels(catalog)
  const currentModelKey=modelChoices.find(x=>x.provider===sessionModels?.current?.provider&&x.model===sessionModels?.current?.model)?.key||''
  const currentChoice=modelChoices.find(x=>x.key===currentModelKey)
  const newChoice=modelChoicesNew.find(x=>x.key===newModel)
  const nodes=snapshot.chat?.legacy?.nodes||snapshot.nodes||[]

  const notify=React.useCallback(message=>setNotice(String(message||'Ошибка')),[])
  async function execute(fn) {
    if(busy)return
    setBusy(true)
    try{await fn()}catch(error){notify(error?.message||String(error))}
    finally{setBusy(false)}
  }
  React.useEffect(()=>{
    if(!selected&&sessions.current)setSelected(sessions.current)
    if(createPending&&sessions.byId[createPending]){
      navigateChat(createPending)
      setCreatePending(null)
    }
  },[selected,sessions.current,createPending,sessions.byId])
  React.useEffect(()=>{
    if(!notice)return
    const timer=setTimeout(()=>setNotice(''),4500)
    return()=>clearTimeout(timer)
  },[notice])
  React.useEffect(()=>{
    if(!search.trim()){setSearchResults([]);return}
    const controller=new AbortController()
    const timer=setTimeout(async()=>{
      try{
        const result=await ctx.sessions.search(search.trim(),controller.signal)
        if(!controller.signal.aborted)setSearchResults(result.ok?result.value.items.map(x=>x.sessionId):[])
      }catch{if(!controller.signal.aborted)setSearchResults([])}
    },260)
    return()=>{clearTimeout(timer);controller.abort()}
  },[ctx,search])
  React.useEffect(()=>{
    let keep=true
    Promise.all([
      ctx.connection.api.agentPresets.list({}),
      ctx.connection.api.llm.models({})
    ]).then(([presetsResponse,modelsResponse])=>{
      if(!keep)return
      const available=valueOf(presetsResponse).presets.filter(p=>!p.broken)
      setPresets(available)
      setNewPreset(old=>old||available[0]?.id||'')
      setCatalog(valueOf(modelsResponse).groups)
    }).catch(error=>{if(keep)notify('Не удалось загрузить агенты или модели: '+error.message)})
    return()=>{keep=false}
  },[ctx,notify])
  React.useEffect(()=>{
    if(!selected||child){setSessionModels(null);return}
    let alive=true
    ctx.connection.api.sessions.models({sessionId:selected}).then(result=>{
      if(alive)setSessionModels(valueOf(result))
    }).catch(error=>{if(alive){setSessionModels(null);notify('Модели: '+error.message)}})
    return()=>{alive=false}
  },[ctx,selected,child,notify])
  React.useEffect(()=>{
    if(screen!=='task'||!rootId)return
    const targets=descendantBranches(sessions.subagentsByParent||{},rootId)
    for(const id of targets){
      ctx.sessions.setSubagentCatalogOpen(id,true)
      if(!sessions.subagentsByParent?.[id])void ctx.sessions.refreshSubagents(id).catch(()=>{})
    }
    return()=>{for(const id of targets)ctx.sessions.setSubagentCatalogOpen(id,false)}
  },[ctx,screen,rootId,sessions.subagentsByParent])
  React.useEffect(()=>{
    if(screen==='chat')endRef.current?.scrollIntoView?.({block:'end'})
  },[screen,selected,snapshot.nodes?.length,snapshot.partial])
  React.useEffect(()=>{
    if(restart==='requested'&&!hostDescription)setRestart('disconnected')
    else if(restart==='disconnected'&&hostDescription)setRestart('unknown')
  },[restart,hostDescription])
  React.useEffect(()=>{
    if(restart!=='requested')return
    const timeout=setTimeout(()=>setRestart('unknown'),20000)
    return()=>clearTimeout(timeout)
  },[restart])

  function navigateChat(id,address){
    try{
      if(address)ctx.sessions.openSubagent(address)
      else ctx.sessions.open(id)
      setSelected(id);setSelectedAddress(address||null)
      setDraft('');setPreview(null)
      setScreen('chat')
    }catch(error){notify('Не удалось открыть чат: '+error.message)}
  }
  function navigateParent(){
    const id=childAddress?.parentSessionId||selectedSummary?.parentId
    if(!id)return setScreen('task')
    navigateChat(id,ctx.sessions.subagentAddress?.(id))
  }
  function chooseBrowse(id,path,mode='folder') {
    setBrowse({id,path,mode,loading:true,entries:[]})
    fetch('/mobile/api/list?'+new URLSearchParams({workspaceId:id,path})).then(async response=>{
      const body=await response.json()
      if(!response.ok||!body.ok)throw Error(body.error||'Ошибка папки')
      return body.value
    }).then(data=>{
      setBrowse(old=>old?.id===id&&old.path===path?{...data,id,mode,loading:false}:old)
    }).catch(error=>{
      setBrowse(old=>old?.id===id&&old.path===path?{...old,mode,loading:false,error:error.message}:old)
    })
  }
  async function createSession(){
    if(!newPreset)throw Error('Агент не выбран')
    const request={agentPreset:newPreset}
    if(newFolder){
      if(newFolder.path)request.cwd=newFolder.absolute
      else request.workspaceId=newFolder.id
    }
    const created=valueOf(await ctx.connection.api.sessions.create(request))
    let configError=''
    try{
      const route=modelChoicesNew.find(m=>m.key===newModel)
      if(route)valueOf(await ctx.connection.api.sessions.selectModel({
        sessionId:created.sessionId,provider:route.provider,model:route.model,
        ...(newEffort?{reasoningEffort:newEffort}:{})
      }))
      if(newTitle.trim())valueOf(await ctx.connection.api.sessions.rename({
        sessionId:created.sessionId,title:newTitle.trim()
      }))
    }catch(error){configError=error.message}
    setCreatePending(created.sessionId)
    setScreen('chats')
    setNewTitle('')
    setNewFolder(null)
    if(configError)notify('Чат создан, но параметры не установлены: '+configError)
  }
  async function changeModel(key,effort) {
    const route=modelChoices.find(x=>x.key===key)
    if(!route||child||!selected)throw Error('Модель недоступна')
    const updated=valueOf(await ctx.connection.api.sessions.selectModel({
      sessionId:selected,provider:route.provider,model:route.model,
      ...(effort?{reasoningEffort:effort}:{})
    }))
    // rc.2 wire is { selected: ModelSelection }, not ModelSelection itself.
    setSessionModels(old=>old?{...old,current:updated.selected}:old)
  }
  async function sendMessage(text){
    if(!selected||readOnly||!text.trim())return
    const content=[{type:'text',text:text.trim()}]
    if(child){
      if(childAddress?.mode!=='continuable')throw Error('Дочерний агент только для чтения')
      valueOf(await ctx.connection.api.subagents.prompt({
        ...childAddress,content,clientTimeZone:Intl.DateTimeFormat().resolvedOptions().timeZone
      },new AbortController().signal))
    }else{
      if(!binding)throw Error('Чат не загружен')
      valueOf(await binding.session.prompt(content,snapshot.running?'steer':'queue'))
    }
    setDraft('')
  }
  async function stop(){
    if(!selected)return
    if(child){
      if(childAddress?.mode!=='continuable')throw Error('Этот Task нельзя остановить')
      valueOf(await ctx.connection.api.subagents.interrupt(childAddress))
    }else if(binding)valueOf(await binding.session.cancel())
  }
  async function compact(){
    if(child||!binding)throw Error('Сжатие недоступно для этого Task')
    const result=valueOf(await binding.session.command('/compact'))
    if(!result?.matched)throw Error('Команда /compact недоступна в этом агенте')
    notify('Команда /compact принята')
  }
  async function archive(){
    if(child||!selected)throw Error('Архивирование доступно для основного чата')
    await ctx.workspaces.archiveSession(selected)
    setModal(null);setFilter('archive');setScreen('chats')
  }
  async function unarchive(id){
    const response=await fetch('/mobile/api/unarchive',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({sessionId:id})
    })
    const payload=await response.json()
    if(!response.ok||!payload.ok)throw Error(payload.error||'Не удалось восстановить')
    notify('Чат возвращён из архива')
  }
  async function restartHost(){
    const response=await fetch('/api/dsh-restart',{method:'POST'})
    if(response.status!==202)throw Error('Запрос отклонён: HTTP '+response.status)
    setRestart('requested');setModal(null)
  }
  function openResults(){
    setScreen('results');setPreview(null)
    const owner=projectOf(workspaces,selectedSummary?.cwd)
    if(owner)chooseBrowse(owner.workspaceId,projectRelative(owner.path,selectedSummary.cwd),'result')
    else setBrowse(null)
  }
  async function openFile(filename){
    if(!browse)throw Error('Сначала выберите проект')
    const filenamePath=pathChild(browse.path,filename)
    const url='/mobile/project/'+[browse.id,...filenamePath.split('/')].map(encodeURIComponent).join('/')
    const ext=filename.split('.').pop()?.toLowerCase()||''
    if(['md','markdown','txt','json'].includes(ext)){
      const response=await fetch(url)
      if(!response.ok)throw Error('Не удалось открыть файл')
      setPreview({kind:'text',title:filename,text:await response.text()})
    }else if(['html','htm'].includes(ext))setPreview({kind:'html',title:filename,url})
    else if(['png','jpg','jpeg','gif','ico','webp','svg'].includes(ext))setPreview({kind:'image',title:filename,url})
    else if(ext==='pdf')setPreview({kind:'pdf',title:filename,url})
    else throw Error('Этот тип файла нельзя просмотреть')
  }
  function pageHeader(title,back){
    return h('header',{className:'m-pagebar'},
      btn('Назад','back',back,'m-square m-quiet'),
      h('div',{className:'m-page-title'},h('strong',null,title)))
  }
  const nav=h('nav',{className:'m-nav','aria-label':'Основные разделы'},
    ...[['chats','chat','Чаты'],['task','tree','Task'],['results','file','Результаты'],['actions','power','Действия']].map(([key,glyph,label])=>
      h('button',{key,type:'button','aria-label':label,className:screen===key?'selected':'',
        onClick:()=>key==='results'?openResults():setScreen(key)},
        ico(glyph),h('span',null,label))))
  const groups=new Map()
  const query=search.trim().toLocaleLowerCase()
  const ordinary=(sessions.ids||[]).map(id=>sessions.byId[id]).filter(x=>x&&x.origin!=='subagent')
  for(const item of ordinary){
    if(filter==='archive'?!archived.has(item.id):archived.has(item.id))continue
    if(filter==='question'&&!item.pendingInteraction)continue
    if(query){
      const match=[item.displayTitle,item.cwd,item.agentPreset,item.id].some(s=>String(s||'').toLocaleLowerCase().includes(query))
      if(!match&&!searchResults.includes(item.id))continue
    }else if(item.blank&&filter!=='archive')continue
    const group=item.cwd||'Без проекта'
    if(!groups.has(group))groups.set(group,[])
    groups.get(group).push(item)
  }
  const listGroups=[...groups].map(([cwd,items])=>{
    const cards=items.map(s=>{
      const excerpt=recentTextOf(ctx.sessions.binding(s.id)?.session)
      return h('button',{key:s.id,type:'button',className:'m-chat-row',
      'aria-label':s.displayTitle+(archived.has(s.id)?' · Вернуть из архива':''),
      onClick:()=>archived.has(s.id)?void execute(()=>unarchive(s.id)):navigateChat(s.id)},
      h('span',{className:'m-avatar'},ico('chat')),
      h('span',{className:'m-chat-copy'},
        h('span',{className:'m-chat-head'},h('strong',null,s.displayTitle||s.id),
          h('small',null,shortDate(s.updatedAt))),
        excerpt?h('span',{className:'m-chat-excerpt'},excerpt):null,
        h('span',{className:'m-chat-meta'},
          h('span',{className:'m-dot '+(s.running?'working':s.pendingInteraction?'waiting':'')}),
          s.agentPreset||'Агент',' · ',s.pendingInteraction?'Ожидает':s.running?'Работает':'Готово')))
    })
    return h('section',{className:'m-project',key:cwd},
      h('div',{className:'m-project-heading'},
        h('h2',null,ico('folder'),cwd==='Без проекта'?'Без проекта':cwd.split(/[\\/]/).filter(Boolean).pop()),
        h('code',{title:cwd},cwd==='Без проекта'?'':cwd)),
      h('div',{className:'m-chat-rows'},...cards))
  })
  const chatList=h('section',{className:'m-page','aria-label':'Чаты'},
    h('div',{className:'m-scroll'},
      h('div',{className:'m-topline'},h('h1',null,'Чаты'),
        btn('Создать чат','plus',()=>setScreen('new'),'m-square m-add')),
      h('label',{className:'m-search'},ico('search'),
        h('input',{type:'search',placeholder:'Поиск','aria-label':'Поиск по чатам',
          value:search,onChange:e=>setSearch(e.target.value)})),
      h('div',{className:'m-filters'},
        ...[['all','Все'],['question','Ожидают'],['archive','Архив']].map(([id,label])=>
          h('button',{type:'button',key:id,className:filter===id?'active':'',
            onClick:()=>setFilter(id)},label))),
      !listGroups.length?h('p',{className:'m-empty'},createPending?'Создание переписки…':'Нет чатов'):null,
      ...listGroups),
    nav)

  const presetsToShow=presets.slice(0,3)
  const newChat=h('section',{className:'m-page','aria-label':'Новый чат'},
    pageHeader('Новый чат',()=>setScreen('chats')),
    h('div',{className:'m-scroll m-new'},
      h('div',{className:'m-field'},
        h('label',{htmlFor:'mobile-title'},'Название'),
        h('input',{id:'mobile-title',className:'m-textfield',maxLength:72,
          value:newTitle,onChange:e=>setNewTitle(e.target.value),
          placeholder:'Новый разговор'})),
      h('div',{className:'m-field'},
        h('h2',null,'Папка проекта'),
        h('div',{className:'m-folder-card'},
          h('code',{className:'m-path'},newFolder?.absolute||'Без проекта'),
          h('div',{className:'m-actions'},
            btn('Папка','folder',()=>{setBrowse(null);setModal('folders')},'m-btn m-soft'),
            h('button',{type:'button',className:'m-btn',onClick:()=>setNewFolder(null)},'Без проекта')))),
      h('div',{className:'m-field'},h('h2',null,'Агент'),
        h('div',{className:'m-presets',role:'radiogroup','aria-label':'Агент'},
          ...presetsToShow.map(p=>h('button',{key:p.id,type:'button',
            className:'m-preset '+(newPreset===p.id?'active':''),
            role:'radio','aria-checked':newPreset===p.id,onClick:()=>setNewPreset(p.id)},
            ico('chat'),h('strong',null,p.name||p.id))))),
      h('div',{className:'m-field'},h('h2',null,'Параметры'),
        h('div',{className:'m-tuning'},
          h('label',null,'Модель',h('select',{'aria-label':'Модель',
            value:newModel,onChange:e=>{setNewModel(e.target.value);setNewEffort('')}},
            h('option',{value:''},'По умолчанию'),
            ...modelChoicesNew.map(x=>h('option',{value:x.key,key:x.key},x.label)))),
          h('label',null,'Уровень',h('select',{'aria-label':'Уровень рассуждений',
            value:newEffort,disabled:!newChoice?.efforts.length,
            onChange:e=>setNewEffort(e.target.value)},
            h('option',{value:''},'Авто'),
            ...(newChoice?.efforts||[]).map(x=>h('option',{value:x.id,key:x.id},x.name))))))),
    h('div',{className:'m-sticky'},
      h('button',{type:'button',className:'m-btn m-primary m-full',disabled:busy||!newPreset,
        onClick:()=>void execute(createSession)},ico('plus'),'Создать')))

  const stopped=!snapshot.running&&nodes.some(x=>x.kind==='assistant'&&x.interrupted)
  const status=snapshot.pending?.length?'Ожидает ответа':
    snapshot.running?'Работает':stopped?'Остановлен':'Готово'
  const questionButton=waiting?btn('Ответить на вопрос','next',
    ()=>setScreen('question'),'m-btn m-soft m-full'):null
  const chat=h('section',{className:'m-page','aria-label':'Переписка с агентом'},
    h('header',{className:'m-pagebar'},
      btn('Назад','back',()=>setScreen('chats'),'m-square m-quiet'),
      h('div',{className:'m-page-title'},
        h('strong',null,selectedSummary?.displayTitle||'Переписка'),
        h('small',null,selectedSummary?.agentPreset||'Агент')),
      btn('Task','tree',()=>setScreen('task')),
      btn('Меню чата','more',()=>setModal('menu'))),
    h('div',{className:'m-chat-path',title:selectedSummary?.cwd||''},
      selectedSummary?.cwd||'Без проекта'),
    child?h('div',{className:'m-task-route'},
      h('span',null,h('strong',null,selectedSummary?.displayTitle||'Task'),
        h('small',null,'Родитель: '+(sessions.byId?.[childAddress?.parentSessionId]?.displayTitle||childAddress?.parentSessionId||'—'))),
      btn('К родителю','tree',navigateParent)):null,
    h('div',{className:'m-status'},ico('chat'),h('strong',null,status),
      snapshot.running&&!readOnly?btn('Остановить','stop',()=>void execute(stop)):null,
      stopped&&!readOnly?btn('Продолжить','next',()=>void execute(()=>sendMessage('Продолжи с места остановки.'))):null),
    h('div',{className:'m-messages','aria-label':'Сообщения'},
      snapshot.openState==='cold'||snapshot.openState==='loading'?h('p',{className:'m-note'},'Загрузка переписки…'):null,
      snapshot.openError?h('p',{className:'m-error'},snapshot.openError.message):null,
      snapshot.hasMore?h('button',{type:'button',className:'m-btn m-full',
        disabled:snapshot.loadingOlder,onClick:()=>void execute(()=>binding?.session.loadOlder())},
        snapshot.loadingOlder?'Загрузка…':'Ранние сообщения'):null,
      ...nodes.map(renderNode).filter(Boolean),
      snapshot.partial?h('article',{className:'m-agent m-live'},
        h('small',{className:'m-agent-name'},'Агент · пишет…'),
        h(Markdown,{text:(snapshot.partial.blocks||[]).filter(x=>x.kind==='text').map(x=>x.text).join('\n')})):null,
      ...(snapshot.queue||[]).filter(x=>x.placement!=='context').map(x=>
        h('p',{className:'m-note',key:x.id},'В очереди: '+(x.preview||x.text||'Сообщение'))),
      questionButton,
      h('div',{ref:endRef})),
    readOnly?h('div',{className:'m-readonly'},oneShot?'Одноразовый Task · только чтение':
      snapshot.subagent?.parentAvailable===false?'Родитель недоступен · только чтение':'Только чтение'):null,
    !readOnly?h('form',{className:'m-composer',
      onSubmit:e=>{e.preventDefault();if(draft.trim())void execute(()=>sendMessage(draft))}},
      h('div',{className:'m-composer-top'},
        h('span',{className:'m-recipient'},child?'Task: '+(selectedSummary?.displayTitle||'Агент'):
          selectedSummary?.agentPreset||'Агент'),
        btn('Сжать контекст /compact','layers',()=>void execute(compact),'m-square m-soft',
          {disabled:child||busy}),
        h('span',{className:'m-usage',title:'Контекст'},pressurePercent(pressure))),
      !child?h('div',{className:'m-tuning'},
        h('label',null,'Модель',h('select',{'aria-label':'Модель',value:currentModelKey,
          disabled:busy||!modelChoices.length,onChange:e=>void execute(()=>changeModel(e.target.value,''))},
          !currentModelKey?h('option',{value:''},sessionModels?.current?.model||'Нет данных'):null,
          ...modelChoices.map(x=>h('option',{key:x.key,value:x.key},x.label)))),
        h('label',null,'Уровень',h('select',{'aria-label':'Уровень рассуждений',
          value:sessionModels?.current?.reasoningEffort||'',
          disabled:busy||!currentChoice?.efforts.length,
          onChange:e=>void execute(()=>changeModel(currentModelKey,e.target.value))},
          h('option',{value:''},'Авто'),
          ...(currentChoice?.efforts||[]).map(x=>h('option',{key:x.id,value:x.id},x.name))))):null,
      h('div',{className:'m-send-row'},
        h('textarea',{'aria-label':'Сообщение выбранному агенту',
          placeholder:'Сообщение…',rows:1,maxLength:24000,value:draft,
          onChange:e=>setDraft(e.target.value)}),
        h('button',{type:'submit',className:'m-send',disabled:busy||!draft.trim(),
          'aria-label':'Отправить',title:'Отправить'},ico('next')))):null)

  const treeRows=(id,seen=new Set())=>{
    if(seen.has(id))return null
    const visited=new Set(seen);visited.add(id)
    const catalog=sessions.subagentsByParent?.[id]
    return h('div',{className:'m-tree-children',role:'group'},
      ...(catalog?.entries||[]).map(row=>{
        if(row.kind!=='child')
          return h('p',{className:'m-note',key:row.id},row.id+' · недоступен')
        const address={parentSessionId:id,childSessionId:row.id,mode:row.mode}
        return h('div',{className:'m-tree-entry',key:row.id},
          h('div',{className:'m-tree-card '+(selected===row.id?'selected':'')},
            h('button',{type:'button',className:'m-tree-main',
              onClick:()=>navigateChat(row.id,address)},
              ico('chat'),
              h('span',null,h('strong',null,row.label||sessions.byId?.[row.id]?.displayTitle||row.id),
                h('small',null,row.mode==='one-shot'?'Одноразовый':'Продолжаемый')),
              h('em',null,row.activity==='running'?'Работает':'Готово')),
            row.hasChildren?btn(collapsed[row.id]?'Раскрыть':'Свернуть',
              collapsed[row.id]?'down':'up',
              ()=>setCollapsed(old=>({...old,[row.id]:!old[row.id]})),'m-square'):null),
          row.hasChildren&&!collapsed[row.id]?treeRows(row.id,visited):null)
      }))
  }
  const task=h('section',{className:'m-page','aria-label':'Дерево Task'},
    h('div',{className:'m-scroll'},
      h('div',{className:'m-topline'},h('h1',null,'Task'),h('small',null,'Дерево агентов')),
      rootId?h('div',{className:'m-tree-entry'},
        h('div',{className:'m-tree-card m-root '+(rootId===selected?'selected':'')},
          h('button',{type:'button',className:'m-tree-main',
            onClick:()=>navigateChat(rootId,ctx.sessions.subagentAddress?.(rootId))},
            ico('tree'),
            h('span',null,h('strong',null,sessions.byId?.[rootId]?.displayTitle||'Основной агент'),
              h('small',null,'Корень Task')),
            h('em',null,sessions.byId?.[rootId]?.running?'Работает':'Готово'))),
        treeRows(rootId)):
        h('p',{className:'m-empty'},'Выберите чат для просмотра Task')),
    nav)

  const question=h('section',{className:'m-page','aria-label':'Вопрос агента'},
    pageHeader('Вопрос агента',()=>setScreen('chat')),
    h('div',{className:'m-scroll'},
      waiting?h(QuestionForm,{key:waiting.key,wait:waiting,onDone:()=>setScreen('chat'),onError:notify}):
        h('p',{className:'m-empty'},'Вопрос больше не ожидается')))

  const resultEntries=(browse?.entries||[]).filter(entry=>{
    if(entry.directory)return true
    const ext=entry.name.split('.').pop()?.toLowerCase()
    return resultTab==='md'?['md','markdown','txt','json'].includes(ext):
      resultTab==='html'?['html','htm','png','jpg','jpeg','svg','webp','gif','ico','pdf'].includes(ext):
      false
  })
  const links=externalLinks(nodes)
  const previewBox=preview?h('div',{className:'m-preview'},
    h('div',{className:'m-preview-title'},preview.title,
      btn('Назад к файлам','back',()=>setPreview(null),'m-square')),
    preview.kind==='text'?h(Markdown,{text:preview.text}):
    preview.kind==='html'?h('iframe',{title:preview.title,src:preview.url,
      sandbox:'allow-scripts',referrerPolicy:'no-referrer',className:'m-frame'}):
    preview.kind==='image'?h('img',{alt:preview.title,src:preview.url,className:'m-image'}):
    h('a',{href:preview.url,target:'_blank',rel:'noopener noreferrer'},'Открыть PDF')):null
  const results=h('section',{className:'m-page','aria-label':'Результаты'},
    h('div',{className:'m-scroll'},
      h('div',{className:'m-topline'},h('h1',null,'Результаты')),
      h('div',{className:'m-tabs',role:'tablist','aria-label':'Формат результата'},
        ...[['md','MD'],['html','HTML'],['web','Сайт']].map(([id,label])=>
          h('button',{type:'button',key:id,role:'tab','aria-selected':resultTab===id,
            className:resultTab===id?'active':'',
            onClick:()=>{setResultTab(id);setPreview(null)}},label))),
      previewBox,
      !preview&&resultTab==='web'?h('div',null,
        links.length===0?h('p',{className:'m-empty'},'Нет веб-адресов в ответе'):null,
        ...links.map(url=>{
          const safe=urlIfReachable(url)
          return h('div',{key:url,className:'m-web-link'},
            safe?h('a',{href:safe,target:'_blank',rel:'noopener noreferrer'},url):
              h('span',null,url+' · Android localhost не является Host'))
        })):null,
      !preview&&resultTab!=='web'?h('div',{className:'m-result-list'},
        h('p',{className:'m-result-caption'},browse?.root||'Файлы зарегистрированного проекта'),
        browse?.path?h('div',{className:'m-path'},browse.path,
          btn('К родительской папке','back',
            ()=>chooseBrowse(browse.id,browse.path.split('/').slice(0,-1).join('/'),'result'),'m-square')):null,
        !browse? h('div',null,
          h('p',{className:'m-empty'},'Выберите проект'),
          ...(workspaces.items||[]).map(item=>
            h('button',{className:'m-file-row',type:'button',key:item.workspaceId,
              onClick:()=>chooseBrowse(item.workspaceId,'','result')},
              ico('folder'),h('span',null,item.title||item.path),ico('next')))):
        browse.loading?h('p',{className:'m-note'},'Загрузка…'):
        browse.error?h('p',{className:'m-error'},browse.error):
        resultEntries.length===0?h('p',{className:'m-empty'},'В этой папке нет подходящих файлов'):
        resultEntries.map(row=>h('button',{className:'m-file-row',type:'button',key:row.name,
          onClick:()=>row.directory?chooseBrowse(browse.id,pathChild(browse.path,row.name),'result'):
            void execute(()=>openFile(row.name))},
          ico(row.directory?'folder':'file'),h('span',null,row.name),ico('next')))):null),
    nav)

  const actions=h('section',{className:'m-page','aria-label':'Действия'},
    h('div',{className:'m-scroll'},
      h('div',{className:'m-topline'},h('h1',null,'Действия')),
      h('div',{className:'m-action-card'},h('h2',null,'/compact'),
        btn('Открыть сжатие в чате','layers',
          ()=>selected?setScreen('chat'):notify('Выберите чат'),'m-btn m-soft')),
      h('div',{className:'m-action-card'},h('h2',null,'Перезапуск Harness'),
        btn('Перезапуск','power',()=>setModal('restart'),'m-btn m-danger')),
      restart!=='idle'?h('p',{className:'m-note'},
        restart==='requested'?'Запрос перезапуска принят. Ответы могут прерваться.':
        restart==='disconnected'?'Соединение потеряно. Ожидание восстановления.':
          'Состояние перезапуска неизвестно.'):null),
    nav)

  let modalBody=null
  if(modal==='folders'){
    const choices=(!browse)?(workspaces.items||[]).map(item=>
      h('button',{key:item.workspaceId,className:'m-file-row',type:'button',
        onClick:()=>chooseBrowse(item.workspaceId,'','folder')},
        ico('folder'),h('span',null,item.title||item.path),ico('next'))):
      [h('code',{className:'m-path',key:'selected'},browse.root||'',browse.path?'/'+browse.path:''),
        browse.path?btn('На уровень выше','back',
          ()=>chooseBrowse(browse.id,browse.path.split('/').slice(0,-1).join('/'),'folder'),'m-btn'):null,
        browse.loading?h('p',{className:'m-note',key:'loading'},'Загрузка…'):null,
        browse.error?h('p',{className:'m-error',key:'error'},browse.error):null,
        ...(browse.entries||[]).filter(x=>x.directory).map(x=>
          h('button',{className:'m-file-row',type:'button',key:x.name,
            onClick:()=>chooseBrowse(browse.id,pathChild(browse.path,x.name),'folder')},
            ico('folder'),h('span',null,x.name),ico('next'))),
        h('div',{className:'m-actions',key:'actions'},
          h('button',{type:'button',className:'m-btn',onClick:()=>setBrowse(null)},'Проекты'),
          h('button',{type:'button',className:'m-btn m-primary',disabled:busy||browse.loading||!!browse.error,
            onClick:()=>{
              setNewFolder({id:browse.id,path:browse.path,absolute:pathForHost(browse.root,browse.path)})
              setModal(null);setScreen('new')
            }},'Выбрать'))]
    modalBody=h('div',null,...choices)
  }else if(modal==='restart')
    modalBody=h('div',null,h('p',null,'Перезапустить Harness? Ответы могут прерваться.'),
      h('div',{className:'m-actions'},
        h('button',{type:'button',className:'m-btn',onClick:()=>setModal(null)},'Отмена'),
        h('button',{type:'button',className:'m-btn m-danger',disabled:busy,
          onClick:()=>void execute(restartHost)},'Перезапустить')))
  else if(modal==='menu')
    modalBody=h('div',{className:'m-actions'},
      h('button',{type:'button',className:'m-btn',onClick:()=>{setModal(null);openResults()}},'Результаты'),
      h('button',{type:'button',className:'m-btn m-danger',disabled:busy||child,
        onClick:()=>void execute(archive)},'В архив'))
  const modalFrame=modal?h('div',{className:'m-modal-mask',onMouseDown:e=>{if(e.target===e.currentTarget)setModal(null)}},
    h('div',{className:'m-sheet',role:'dialog','aria-modal':true,'aria-label':modal==='folders'?'Папка проекта':modal==='restart'?'Перезапуск':'Меню чата'},
      h('div',{className:'m-sheet-head'},
        h('h2',null,modal==='folders'?'Папка Windows':modal==='restart'?'Перезапуск Harness':'Меню чата'),
        btn('Закрыть','close',()=>setModal(null),'m-square m-quiet')),
      modalBody)):null
  const page=screen==='new'?newChat:screen==='chat'?chat:screen==='task'?task:
    screen==='question'?question:screen==='results'?results:screen==='actions'?actions:chatList
  return h('div',{className:'dsh-mobile',role:'application','aria-label':'Рядом — мобильный DSH'},
    h('main',{className:'m-shell'},page),
    modalFrame,
    notice?h('div',{className:'m-toast',role:'status','aria-live':'polite'},notice):null)
}
function apply(ctx){
  // Never shade or replace the desktop page when the mobile mode was not requested.
  if(new URLSearchParams(location.search).get('mobile')!=='1')return
  if(!document.querySelector('style[data-dsh-mobile]')){
    const style=document.createElement('style')
    style.setAttribute('data-dsh-mobile','')
    style.textContent=MOBILE_CSS
    document.head.appendChild(style)
    ctx.effect(()=>()=>style.remove(),'dsh-mobile: styles')
  }
  ctx.slots.inject('shell.overlay',()=>ctx.slots.register({
    name:'shell.overlay',id:'dsh-mobile',order:500
  },()=>h(MobileApp,{ctx})))
}
module.exports={apply,inject:['slots','sessions','workspaces','connection'],
  testing:{pressurePercent,rootOf,descendantBranches,catalogModels,urlIfReachable,QuestionForm,Markdown}}


return module.exports;}});