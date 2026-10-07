import {websitePolicy} from './site-policy.ts';
import {previewVersion,versionReferences} from './preview-version.ts';
import {previewDocument} from './preview-document.ts';
import {raster,imageMime} from './images.ts';
import http from 'node:http';
import { extname } from 'node:path';
import { Project } from './project.ts';
import {resolveSiteFile} from './core.ts';
const project=new Project((process.env.SITETILLER_DATA_DIR||'/data')+'/project');
const mime:any={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.txt':'text/plain','.json':'application/json'};
http.createServer(async(req,res)=>{try{
  res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
  const url=new URL(req.url||'/','http://localhost');
  if(url.pathname==='/health'){res.writeHead(200);return res.end('ok');}
  if(url.pathname==='/robots.txt'){res.writeHead(200,{'Content-Type':'text/plain'});return res.end('User-agent: *\nDisallow: /\n');}
  const version=await previewVersion(project,url);if(!version){res.writeHead(404);return res.end('Verze nenalezena');}
  const {commit,relative,prefix}=version,selected=version.project||project,files=await selected.committedFiles(commit);
  const name=resolveSiteFile('/'+relative,files);
  if(!Object.hasOwn(files,name)){res.writeHead(404);return res.end('Nenalezeno');}
  if(!url.pathname.endsWith('/')&&!Object.hasOwn(files,'site/'+relative)){res.writeHead(302,{Location:url.pathname+'/'+url.search});return res.end();}
  let content:any=raster(name)?await selected.binary(commit,name):files[name];if(/\.(html|css)$/.test(name)&&prefix!=='/')content=versionReferences(content,prefix);if(name.endsWith('.html'))content=previewDocument(content,commit,url.searchParams.get('embedded')==='1');
  res.setHeader('Content-Security-Policy',websitePolicy);
  res.writeHead(200,{'Content-Type':raster(name)?imageMime(name):(mime[extname(name)]||'text/plain')});res.end(content);
}catch{res.writeHead(503);res.end('Náhled se připravuje.');}}).listen(Number(process.env.PORT||8080),'0.0.0.0');
