/** Restricted synthetic browser fixture, not a DSH Host.
 * Serves only this plugin's test files and installed rc.2 static browser assets.
 * No filesystem browsing, credentials, user profiles, sockets to production DSH.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const installed='C:/Users/Andrew/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules'
const assets=installed+'/@deepseek-ai/dsh-web-frontend/dist/assets'
const base=fileURLToPath(new URL('../../',import.meta.url))
const paths={
  '/':base+'/tests/browser/harness.html',
  '/harness.js':base+'/tests/browser/harness.js',
  '/mobile-client.js':base+'/lib/client.js',
  '/rc2-client-modules.js':installed+'/@deepseek-ai/dsh-client-modules/lib/client.js',
  '/assets/vendor-D22_Mp1f.js':assets+'/vendor-D22_Mp1f.js',
  '/assets/index.js':assets+'/index-ClqxG24t.js'
}
const mime=path=>path==='/'||path.endsWith('.html')?'text/html; charset=utf-8':'text/javascript; charset=utf-8'
const host='127.0.0.1'
const port=Number(process.env.MOBILE_HARNESS_PORT||38651)
const server=createServer(async(req,res)=>{
  const path=new URL(req.url||'/', 'http://127.0.0.1').pathname
  if(req.method!=='GET'||(!(path in paths)&&path!=='/mobile/project/workspace-test/page.html')){
    res.writeHead(404);res.end('Not Found');return
  }
  try{
    if(path==='/mobile/project/workspace-test/page.html'){
      res.writeHead(200,{'content-type':'text/html; charset=utf-8',
        'content-security-policy':"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
        'cache-control':'no-store'})
      res.end('<h1>HTML test file</h1><script>document.body.dataset.untrusted=1</script>')
      return
    }
    let text=await readFile(paths[path],'utf8')
    if(path==='/assets/index.js'){
      const before=text
      text=text.replace(
        /const da=document\.getElementById\("root"\);if\(da===null\)throw new Error\("web app: missing #root"\);new Yd\(da\)\.run\(\);/,
        'export {Jd as dshStaticModules};')
      if(text===before)throw Error('Installed shell extraction anchor changed; stop')
    }
    res.writeHead(200,{'content-type':mime(path),'cache-control':'no-store',
      'x-content-type-options':'nosniff','access-control-allow-origin':'http://127.0.0.1:'+port})
    res.end(text)
  }catch(e){
    res.writeHead(500,{'content-type':'text/plain'})
    res.end('Test harness load failed: '+e.message)
  }
})
server.listen(port,host,()=>console.log('MOBILE_BROWSER_FIXTURE_URL http://'+host+':'+port+'/'))
