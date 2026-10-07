export type Release={id:string;number:number;commit:string;publishedAt:string|null;previousCommit:string|null;tag?:string;description?:string;summary?:string;legacy?:boolean;minor?:number;revision?:number;replacesCommit?:string};
export type CommitEntry={commit:string;message:string;date:string};
export function initialReleases(publishedCommit:string|null,events:any[]):Release[]{
  if(!publishedCommit)return [];
  const event=events.findLast(e=>e.stage==='published'&&e.commit===publishedCommit);
  return [{id:'legacy-'+publishedCommit,number:0,commit:publishedCommit,publishedAt:event?.at||null,previousCommit:null,legacy:true}];
}
export function publicationIntent(releases:Release[],pending:Release|null,commit:string,description?:string,summary?:string,createSubversion=false):Release{
  if(pending?.commit===commit&&!pending.replacesCommit&&(pending.minor!==undefined)===createSubversion){if(description!==undefined)pending.description=description;if(summary!==undefined)pending.summary=summary;return pending;}
  if(createSubversion){const latest=releases.at(-1);if(!latest||latest.legacy)throw Error('Zatím není aktuální verze pro vytvoření podverze.');const minor=Math.max(0,...releases.filter(r=>r.number===latest.number).map(r=>r.minor||0))+1;return {id:'release-'+latest.number+'.'+minor,number:latest.number,minor,commit,publishedAt:null,description:description||'',summary:summary||'',previousCommit:latest.commit,tag:'sitetiller/published/v'+latest.number+'-s'+minor};}
  const number=Math.max(0,...releases.map(r=>r.number))+1;
  return {id:'release-'+number,number,commit,publishedAt:null,description:description||'',summary:summary||'',previousCommit:releases.at(-1)?.commit||null,tag:'sitetiller/published/v'+number};
}
export function groupHistory(history:CommitEntry[],releases:Release[]){
  const positions=new Map(history.map((item,i)=>[item.commit,i]));
  const known=releases.filter(r=>positions.has(r.commit));
  const latest=known.at(-1),boundary=latest?positions.get(latest.commit)!:history.length;
  const groups:any[]=[{id:'unpublished',title:'Nepublikované změny',release:null,changes:history.slice(0,boundary)}];
  for(let i=known.length-1;i>=0;i--){const release=known[i],start=positions.get(release.commit)!,end=i?positions.get(known[i-1].commit)!:history.length;groups.push({id:release.id,title:release.legacy?'Dříve publikovaná verze':'Verze '+release.number,release,changes:history.slice(start,end)});}
  for(const release of releases.filter(r=>!positions.has(r.commit)))groups.push({id:release.id,title:release.legacy?'Dříve publikovaná verze':'Verze '+release.number,release,changes:[],unavailable:true});
  return groups;
}
export async function completePublication(project:any,releases:Release[],intent:Release){
  if(!intent.tag||!/^sitetiller\/published\/v(?:0|[1-9]\d*)(?:-[rs][1-9]\d*)?$/.test(intent.tag)||! /^[a-f0-9]{40}$/.test(intent.commit))throw new Error('Neplatná publikovaná verze.');
  if(intent.minor!==undefined){const latest=releases.at(-1);if(!latest||latest.number!==intent.number||latest.commit!==intent.previousCommit)throw Error('Aktuální publikovaná verze se změnila. Obnovte seznam verzí.');}
  let existing:string|null=null;
  try{existing=await project.git(['rev-parse','--verify','refs/tags/'+intent.tag+'^{commit}']);}catch{}
  if(existing&&existing!==intent.commit)throw new Error('Značka publikované verze už patří jinému commitu.');
  if(!existing)await project.git(['tag',intent.tag,intent.commit]);
  const release={...intent,publishedAt:new Date().toISOString()};
  return {release,releases:[...releases,release]};
}

