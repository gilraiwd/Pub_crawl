// Node 18+, no dependencies. Run: node build-data.mjs
// Writes data/XX.json ([name, lat, lon, opening_hours] per venue) and data/index.json.
import {mkdir,readFile,writeFile} from "node:fs/promises";

const STATES="AL,AZ,AR,CA,CO,CT,DE,DC,FL,GA,ID,IL,IN,IA,KS,KY,LA,ME,MD,MA,MI,MN,MS,MO,MT,NE,NV,NH,NJ,NM,NY,NC,ND,OH,OK,OR,PA,RI,SC,SD,TN,TX,UT,VT,VA,WA,WV,WI,WY".split(",");
const URLS=["https://overpass-api.de/api/interpreter","https://overpass.kumi.systems/api/interpreter"];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function pull(st){
  const q=`[out:json][timeout:300];area["ISO3166-2"="US-${st}"]->.a;nwr["amenity"~"^(bar|pub)$"](area.a);out center tags;`;
  for(let attempt=0;attempt<4;attempt++){
    try{
      const r=await fetch(URLS[attempt%2],{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:"data="+encodeURIComponent(q),signal:AbortSignal.timeout(330000)});
      if(!r.ok)throw new Error("HTTP "+r.status);
      return (await r.json()).elements;
    }catch(e){console.warn(st,"attempt",attempt+1,e.message);await sleep(30000*(attempt+1));}
  }
  return null;
}

await mkdir("data",{recursive:true});
let idx={built:"",states:{}};
try{idx=JSON.parse(await readFile("data/index.json","utf8"));}catch{}

for(const st of STATES){
  const els=await pull(st);
  if(!els){console.error("Keeping previous data for",st);continue;}
  const seen=new Set(),out=[];
  for(const e of els){
    const lat=e.lat??e.center?.lat,lon=e.lon??e.center?.lon;if(lat==null||lon==null)continue;
    const t=e.tags||{},name=t.name||`Unnamed ${t.amenity||"bar"}`,k=`${name}|${lat.toFixed(4)},${lon.toFixed(4)}`;
    if(seen.has(k))continue;seen.add(k);
    out.push([name,+lat.toFixed(5),+lon.toFixed(5),t.opening_hours||""]);
  }
  await writeFile(`data/${st}.json`,JSON.stringify(out));
  idx.states[st]=out.length;console.log(st,out.length);
  await sleep(10000); // be polite to the Overpass servers
}
idx.built=new Date().toISOString();
await writeFile("data/index.json",JSON.stringify(idx));
