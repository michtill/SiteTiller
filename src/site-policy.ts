// Website capabilities are shared by production, dedicated preview and isolated checks.
export const websitePolicy="default-src 'self'; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self' https: wss:; frame-src 'self' https:; media-src 'self' blob: https:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self' https:";
export const productionPolicy=websitePolicy+"; frame-ancestors 'self'";
export const studioPreviewPolicy="sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; "+websitePolicy;
export function hostingPolicyProblems(header:string|null){
 if(!header)return ['Produkční hosting nemá nastavenou společnou bezpečnostní politiku.'];
 const problems:string[]=[];
 for(const policy of header.split(',')){
  const rules=new Map(policy.split(';').map(rule=>rule.trim().split(/\s+/)).filter(parts=>parts[0]).map(([name,...sources])=>[name,sources]));
  for(const clause of websitePolicy.split(';')){
   const [name,...required]=clause.trim().split(/\s+/);if(['object-src','base-uri'].includes(name))continue;
   const actual=rules.get(name)||(['worker-src','frame-src'].includes(name)?rules.get('child-src'):undefined)||rules.get('default-src')||[];
   const absent=required.filter(source=>!actual.includes(source)&&!(actual.includes('*')&&!source.startsWith("'")&&!['blob:','data:'].includes(source)));
   if(absent.length)problems.push(name+' chybí '+absent.join(' '));
  }
  if(rules.has('sandbox'))problems.push('Produkce má sandbox určený pouze pro náhled.');
 }
 return [...new Set(problems)];
}
