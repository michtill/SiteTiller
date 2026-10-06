// Legacy results remain strict. Structured results distinguish evidence from preferences.
export function assessCriteria(acceptance:any, result:any) {
 const blockers:string[]=[],warnings:string[]=[];
 if(Array.isArray(acceptance)&&acceptance.some(c=>typeof c==='object')&&(!Array.isArray(result.criteria)||!Array.isArray(result.findings)))return {passed:false,blockers:['Chybí strukturované vyhodnocení kritérií.'],warnings};
 if(!Array.isArray(result.criteria)||!Array.isArray(result.findings))return {passed:result.passed===true,blockers:result.passed===true?[]:(result.issues||['Kontrola nepotvrdila výsledek.']),warnings};
 const expected=Array.isArray(acceptance)?acceptance:[];
 if(expected.some(c=>typeof c==='string'))return {passed:result.passed===true,blockers:result.passed===true?[]:(result.issues||['Kontrola nepotvrdila výsledek.']),warnings};
 for(const c of expected){
  const matches=result.criteria.filter((r:any)=>r.id===c.id);
  if(!c.id||!['required','preference'].includes(c.category)||typeof c.basis!=='string'||!c.basis.trim()||matches.length!==1){blockers.push('Neplatné nebo neúplné vyhodnocení kritéria: '+(c.id||'?'));continue;}
  const r=matches[0];
  if(r.category!==c.category||!['passed','failed','unverified'].includes(r.status)){blockers.push('Neplatné vyhodnocení kritéria: '+c.id);continue;}
  if(r.status!=='passed')(c.category==='required'&&r.status==='failed'?blockers:warnings).push(c.id+': '+(r.summary||c.description));
 }
 if(result.criteria.some((r:any)=>!expected.some(c=>c.id===r.id)))blockers.push('Kontrola vrátila neznámé kritérium.');
 for(const r of result.findings){
  if(!['required','preference'].includes(r.category)||!['failed','unverified'].includes(r.status)||typeof r.summary!=='string'){blockers.push('Neplatný výsledek kontroly.');continue;}
  (r.category==='required'&&r.status==='failed'?blockers:warnings).push(r.summary);
 }
 return {passed:blockers.length===0,blockers,warnings};
}
