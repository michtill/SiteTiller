import {raster} from './images.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, writeFile, lstat, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { safeSitePath, validateFiles } from './core.ts';
import {staticChecks} from './checks.ts';
const exec = promisify(execFile);
export class Project {
  root: string;
  constructor(root: string) {this.root = root;}
  async git(args: string[]) {
    const {stdout} = await exec('git', ['-c','safe.directory=' + this.root,'-c','gc.auto=0','-c','maintenance.auto=false', ...args], {cwd:this.root, timeout:30000, maxBuffer:2000000}); return stdout.trim();
  }
  async init(seed: string|null) {
    await mkdir(this.root, {recursive:true});
    try { await lstat(join(this.root,'.git')); } catch {
      if(seed===null){
        await this.git(['init','-b','main']);
        await this.write({'site/index.html':'<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nový web</title></head><body><main><h1>Nový web</h1><p>Vytvořte web zadáním požadavku v AIWE.</p></main></body></html>'});
      }else try {
        await lstat(join(seed,'..','seed.bundle'));
        await this.git(['-c','core.autocrlf=false','clone','-b','main',join(seed,'..','seed.bundle'),'.']);
      } catch(e:any) {
        if(e.code!=='ENOENT')throw e;
        await cp(seed, this.root, {recursive:true});
        await this.git(['init','-b','main']);
      }
      await this.git(['config','core.autocrlf','false']);
      await this.git(['config','user.name','AI Web Editor']); await this.git(['config','user.email','aiwe@localhost']);
      await this.git(['add','.']);
      if(await this.git(['status','--porcelain']))await this.git(['commit','-m','Import existing website']);
    }
  }
  async files() {
    const result: Record<string,string> = {};
    const walk = async (dir: string) => { for (const ent of await readdir(join(this.root,dir), {withFileTypes:true})) {
      if (ent.isSymbolicLink()) throw new Error('Symbolické odkazy nejsou povolené.');
      const name = dir + '/' + ent.name;
      if (ent.isDirectory()) await walk(name); else {safeSitePath(this.root,name); result[name] = raster(name)?'[Binary image asset]':await readFile(join(this.root,name),'utf8');}
    }}; try{await walk('site');}catch(e:any){if(e.code!=='ENOENT')throw e;} return result;
  }
  async write(files: Record<string,string>) {
    for (const [name,text] of Object.entries(files)) {const path=safeSitePath(this.root,name); if(raster(name))continue; await mkdir(join(path,'..'),{recursive:true}); await writeFile(path,text);}
  }
  async writeSnapshot(files:Record<string,string>){
    for(const name of Object.keys(files))safeSitePath(this.root,name);
    const current=await this.files();
    // Remove individual validated site files in the isolated draft; never remove the repository.
    for(const name of Object.keys(current))if(!Object.hasOwn(files,name))await rm(safeSitePath(this.root,name));
    await this.write(files);
  }
  async binary(commit:string,name:string){safeSitePath(this.root,name);if(!/^[a-f0-9]{40}$/.test(commit))throw Error('Neplatný commit.');const {stdout}=await exec('git',['-c','safe.directory='+this.root,'show',commit+':'+name],{cwd:this.root,encoding:'buffer',maxBuffer:6000000});return stdout;}
  async head() {return this.git(['rev-parse','HEAD']);}
  async history(limit:number|null=20) {return (await this.git(['log','--first-parent',...(limit===null?[]:['-'+limit]),'--format=%H%x00%s%x00%cI'])).split('\n').map(s=>{const [commit,message,date]=s.split('\0'); return {commit,message,date};});}
  async commit(message: string) {
    await this.git(['add','site']);
    if (await this.git(['status','--porcelain'])) await this.git(['commit','-m',message.slice(0,150)]);
    return this.head();
  }
  async test() {return staticChecks(await this.files());}
  async rewind(target:string,expectedHead:string,published:string|null){
    if(!/^[a-f0-9]{40}$/.test(target)||!/^[a-f0-9]{40}$/.test(expectedHead))throw Error('Neplatná verze.');
    if(await this.head()!==expectedHead)throw Error('Návrh se mezitím změnil. Obnov seznam úprav.');
    try{await this.git(['merge-base','--is-ancestor',target,expectedHead]);if(published)await this.git(['merge-base','--is-ancestor',published,target]);}catch{throw Error('Na tento krok se nelze vrátit bez změny historie publikování.');}
    if(await this.git(['status','--porcelain','--untracked-files=no'])||await this.git(['status','--porcelain','--','site']))throw Error('Návrh obsahuje neuložené změny.');
    await this.git(['reset','--hard',target]);return {commit:target};
  }
  async restore(target: string, expectedHead: string) {
    if(!/^[a-f0-9]{40}$/.test(target)||!/^[a-f0-9]{40}$/.test(expectedHead))throw new Error('Neplatná verze.');
    if(await this.head()!==expectedHead)throw new Error('Náhled se mezitím změnil. Obnov seznam verzí.');
    try{await this.git(['merge-base','--is-ancestor',target,expectedHead]);}catch{throw new Error('Vybraná verze není v historii tohoto náhledu.');}
    if(target===expectedHead)throw new Error('Tato verze je již aktuální.');
    const temp=join(this.root,'..','restore-'+Date.now());
    await cp(this.root,temp,{recursive:true});
    try {
      const draft=new Project(temp);
      await draft.git(['restore','--source='+target,'--staged','--worktree','--','site']);
      const tests=await draft.test();if(!tests.passed)throw new Error('Vybraná verze neprošla kontrolou: '+tests.errors.join('; '));
      // Commit even when content matches, keeping an explicit restoration record.
      await draft.git(['commit','--allow-empty','-m','Obnovení verze '+target.slice(0,8)]);
      const commit=await draft.head();
      if(await this.head()!==expectedHead)throw new Error('Náhled se mezitím změnil.');
      await this.git(['fetch',temp,'HEAD']);await this.git(['merge','--ff-only','FETCH_HEAD']);
      return {commit,restoredFrom:target,tests};
    } finally {await (await import('node:fs/promises')).rm(temp,{recursive:true,force:true});}
  }
  async committedFiles(commit: string) {
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Neplatný commit.');
    const names=(await this.git(['ls-tree','-r','--name-only',commit,'site'])).split('\n');
    const files: Record<string,string>={}; for (const name of names.filter(Boolean)) {safeSitePath(this.root,name); files[name]=raster(name)?'[Binary image asset]':(await this.binary(commit,name)).toString('utf8');} return files;
  }
}
