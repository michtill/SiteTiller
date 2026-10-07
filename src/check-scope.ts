// Only existing presentation values may take the fast path. Markup, selectors,
// assets, scripts, imports and layout behavior still require browser checks.
export function smallStyleChange(before:Record<string,string>,after:Record<string,string>){
 const changed=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(p=>before[p]!==after[p]);
 if(!changed.length||changed.length>3)return false;
 let edits=0;
 const css=(text:string)=>text.replace(/(^|[;{])\s*(width|height|min-width|max-width|min-height|max-height|margin(?:-(?:top|right|bottom|left))?|padding(?:-(?:top|right|bottom|left))?|color|background-color|font-size|line-height|border-radius|border-color)\s*:\s*([^;{}]*)(?=[;}])/gi,(full,start,property,value)=>{
  // No URLs, functions, custom properties, CSS escapes or injected rules.
  if(!/^[\s\dA-Za-z#.%+\-]+$/.test(value))return full;
  return start+property.toLowerCase()+':<presentation-value>';
 });
 const normalize=(path:string,text:string)=>path.endsWith('.css')?css(text):text.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi,(_,attrs,body)=>'<style'+attrs+'>'+css(body)+'</style>').replace(/\bstyle\s*=\s*(["'])(.*?)\1/gi,(_,quote,body)=>'style='+quote+css(body+';').slice(0,-1)+quote);
 for(const path of changed){
  if(!Object.hasOwn(before,path)||!Object.hasOwn(after,path)||!/^site\/.*\.(css|html)$/.test(path)||normalize(path,before[path])!==normalize(path,after[path]))return false;
  const oldValues=before[path].match(/[^;{}]+(?=[;}])/g)||[],newValues=after[path].match(/[^;{}]+(?=[;}])/g)||[];
  edits+=Math.max(oldValues.length,newValues.length)-oldValues.filter((value,i)=>value===newValues[i]).length;
 }
 return edits<=12;
}
