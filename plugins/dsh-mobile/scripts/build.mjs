// The rc.2 web module loader requires one browser-safe CJS registration factory.
// This package has only one runtime external: the shell's already-present React.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
const root=new URL('../',import.meta.url)
const load=name=>readFile(new URL(name,root),'utf8')
const [host,client,css]=await Promise.all([load('src/index.js'),load('src/client.js'),load('src/mobile.css')])
if(!client.includes('"__MOBILE_CSS_PLACEHOLDER__"')) throw Error('Client CSS replacement anchor missing')
const source=client.replace('"__MOBILE_CSS_PLACEHOLDER__"',JSON.stringify(css))
const bundle=[
  'window.__ModuleLoader__.load({id:"dsh-mobile",factory:(require)=>{',
  'var module={exports:{}}; var exports=module.exports;',
  source,
  'return module.exports;}});'
].join('\n')
await mkdir(new URL('lib/',root),{recursive:true})
await writeFile(new URL('lib/index.js',root),host)
await writeFile(new URL('lib/client.js',root),bundle)
console.log('dsh-mobile: built lib/index.js and lib/client.js')
