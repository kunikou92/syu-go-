// Build a self-contained Sites Worker from the already validated Vite output.
// No environment files or server credentials are read or included.
import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {pathToFileURL} from 'node:url';

export async function buildHosting(root=process.cwd()) {
  const dist=resolve(root,'dist'), assets={};
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'};
  async function collect(relative) {
    const filename=resolve(dist,relative);
    const data=await readFile(filename);
    assets['/'+relative.replaceAll('\\','/')]=[data.toString('base64'),types[extname(filename)]??'application/octet-stream'];
  }
  await collect('index.html');
  async function directory(relative) {
    for(const entry of await readdir(resolve(dist,relative),{withFileTypes:true})) {
      const name=relative+'/'+entry.name;
      if(entry.isDirectory()) await directory(name);
      else if(entry.isFile()) await collect(name);
      else throw Error('Unsupported asset entry');
    }
  }
  await directory('assets'); await directory('images');
  const headers={};
  for(const line of (await readFile(resolve(dist,'_headers'),'utf8')).split(/\r?\n/)) {
    if(!line.trim()||line.trim()==='/*') continue;
    const match=line.match(/^\s+([^:]+):\s*(.+)$/);
    if(!match) throw Error('Unsupported security header directive');
    headers[match[1].toLowerCase()]=match[2];
  }
  if(headers['x-frame-options']!=='DENY'||!headers['content-security-policy']?.includes("frame-ancestors 'none'")) throw Error('Required framing protection is missing');
  const source=`const assets=${JSON.stringify(assets)};\nconst security=${JSON.stringify(headers)};\nexport default {fetch(request) {
    const headers=new Headers(security);
    headers.set('Cache-Control','no-cache');
    if(request.method!=='GET'&&request.method!=='HEAD') {headers.set('Allow','GET, HEAD');return new Response(null,{status:405,headers});}
    const path=new URL(request.url).pathname;
    const asset=Object.hasOwn(assets,path==='/'?'/index.html':path)?assets[path==='/'?'/index.html':path]:null;
    if(!asset) return new Response(request.method==='HEAD'?null:'Not found',{status:404,headers});
    headers.set('Content-Type',asset[1]);
    const body=request.method==='HEAD'?null:Uint8Array.from(atob(asset[0]),c=>c.charCodeAt(0));
    return new Response(body,{headers});
  }};\n`;
  // Parse and execute the actual generated Worker, including GET/HEAD/error responses.
  const worker=(await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).default;
  for(const [method,path,status] of [['GET','/',200],['HEAD','/',200],['GET','/missing',404],['POST','/',405]]) {
    const response=worker.fetch(new Request('https://check.invalid'+path,{method}));
    if(response.status!==status||response.headers.get('X-Frame-Options')!=='DENY') throw Error('Worker response validation failed');
    if(method==='HEAD'&&(await response.text())!=='') throw Error('HEAD returned a body');
  }
  for(const [path,asset] of Object.entries(assets)) {
    const response=worker.fetch(new Request('https://check.invalid'+path));
    if(!Buffer.from(await response.arrayBuffer()).equals(Buffer.from(asset[0],'base64'))) throw Error('Asset changed in Worker');
  }
  await mkdir(resolve(dist,'server'),{recursive:true});
  await writeFile(resolve(dist,'server/index.js'),source);
  console.log(`Built and verified Sites Worker (${Object.keys(assets).length} assets, security headers on all responses)`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) await buildHosting();
