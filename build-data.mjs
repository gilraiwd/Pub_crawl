// Node 18+, no dependencies. Run: node build-data.mjs
// Writes data/XX.json ([name, lat, lon, opening_hours] per venue) and data/index.json.
import {mkdir, readFile, writeFile} from "node:fs/promises";

const STATES = "AL,AZ,AR,CA,CO,CT,DE,DC,FL,GA,ID,IL,IN,IA,KS,KY,LA,ME,MD,MA,MI,MN,MS,MO,MT,NE,NV,NH,NJ,NM,NY,NC,ND,OH,OK,OR,PA,RI,SC,SD,TN,TX,UT,VT,VA,WA,WV,WI,WY".split(",");
const URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Check Overpass slot availability before firing a massive statewide query
async function waitForSlot(baseUrl) {
  const statusUrl = baseUrl.replace("/interpreter", "/status");
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(statusUrl, {signal: AbortSignal.timeout(10000)});
      if (r.ok) {
        const txt = await r.text();
        const m = txt.match(/(\d+)\s+slots?\s+available\s+now/i);
        if (m && parseInt(m[1], 10) > 0) return;
        const waitMatch = txt.match(/Slot available after:.*in\s+(\d+)\s+seconds/i);
        const waitSec = waitMatch ? Math.min(60, Math.max(5, parseInt(waitMatch[1], 10) + 2)) : 15;
        console.log(`Waiting ${waitSec}s for Overpass slot on ${new URL(baseUrl).hostname}...`);
        await sleep(waitSec * 1000);
        continue;
      }
    } catch {}
    return;
  }
}

async function pull(st) {
  // Comprehensive filter matching index.html (bars, pubs, biergartens, nightclubs, breweries, and bar=yes)
  // Using 'out center qt;' for faster spatial sorting and lower memory overhead on Overpass
  const q = `[out:json][timeout:300][maxsize:134217728];
area["ISO3166-2"="US-${st}"]->.a;
(
  nwr["amenity"~"^(bar|pub|biergarten|nightclub)$"](area.a);
  nwr["craft"="brewery"](area.a);
  nwr["bar"="yes"](area.a);
);
out center tags qt;`;

  for (let attempt = 0; attempt < 6; attempt++) {
    const url = URLS[attempt % URLS.length];
    try {
      await waitForSlot(url);
      const r = await fetch(url, {
        method: "POST",
        headers: {"Content-Type": "application/x-www-form-urlencoded"},
        body: "data=" + encodeURIComponent(q),
        signal: AbortSignal.timeout(340000)
      });
      if (r.status === 429 || r.status === 504 || r.status === 503) {
        throw new Error(`HTTP ${r.status} (server busy/timeout)`);
      }
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      if (data.remark && /runtime error|timeout|out of memory/i.test(data.remark)) {
        throw new Error("Overpass remark: " + data.remark);
      }
      if (!Array.isArray(data.elements)) {
        throw new Error("Malformed Overpass JSON response");
      }
      return data.elements;
    } catch (e) {
      const backoff = Math.min(120000, 15000 * (attempt + 1));
      console.warn(`${st} attempt ${attempt + 1}/${6} failed on ${new URL(url).hostname}: ${e.message}. Retrying in ${backoff / 1000}s...`);
      await sleep(backoff);
    }
  }
  return null;
}

await mkdir("data", {recursive: true});
let idx = {built: "", states: {}};
try {
  idx = JSON.parse(await readFile("data/index.json", "utf8"));
} catch {}

for (const st of STATES) {
  const els = await pull(st);
  if (!els) {
    console.error("Failed all attempts; keeping previous data for", st);
    continue;
  }
  const seen = new Set(), out = [];
  for (const e of els) {
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (lat == null || lon == null) continue;
    const t = e.tags || {};
    const name = t.name || `Unnamed ${t.amenity || t.craft || "bar"}`;
    const k = `${name}|${lat.toFixed(4)},${lon.toFixed(4)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([name, +lat.toFixed(5), +lon.toFixed(5), t.opening_hours || ""]);
  }
  await writeFile(`data/${st}.json`, JSON.stringify(out));
  idx.states[st] = out.length;
  // Save index incrementally so progress is preserved even if the GitHub Action hits its 5-hour job limit
  idx.built = new Date().toISOString();
  await writeFile("data/index.json", JSON.stringify(idx));
  console.log(st, out.length);
  await sleep(8000); // be polite to Overpass servers
}
