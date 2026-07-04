"use strict";
/* ================= config ================= */
const STATION = "44166";                       // AMeDAS Haneda
const LAT = 35.5533, LON = 139.7811;           // RJTT
const MODELS = [
  {key:"jma_seamless",  name:"JMA",   color:"var(--jma)",   hex:"#2C6E8A"},
  {key:"ecmwf_ifs025",  name:"ECMWF", color:"var(--ecmwf)", hex:"#545E92"},
  {key:"gfs_seamless",  name:"GFS",   color:"var(--gfs)",   hex:"#7A8B5E"},
  {key:"icon_seamless", name:"ICON",  color:"var(--icon)",  hex:"#9A6B4F"},
  {key:"ecmwf_aifs025", name:"AIFS·AI", color:"var(--aifs)", hex:"#8C5A7A"},
  {key:"ukmo_seamless", name:"UKMO",  color:"var(--ukmo)", hex:"#B08D3E"},
  {key:"gem_seamless",  name:"GEM",   color:"var(--gem)",  hex:"#4E8A78"},
  {key:"meteofrance_seamless", name:"ARPEGE", color:"#3E7CB1", hex:"#3E7CB1"},
];
// Neighbor AMeDAS stations for spatial / sea-breeze-front context
const NEIGHBORS = [
  {id:"44132", name:"Tokyo · inland"},
  {id:"46106", name:"Yokohama · SW coast"},
  {id:"45212", name:"Chiba · E bay"},
];
const DIR_NAMES = ["CALM","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW","N"];
const ONSHORE = new Set([4,5,6,7,8,9]);      // E–SSW: off Tokyo Bay into RJTT
const INLAND  = new Set([11,12,13,14,15,16]); // WSW–N: across the Tokyo metro (UHI)
const BIAS_DECAY_H = 6;
// Climatological normal daily-MAX temperature for Tokyo (°C), by month (Jan..Dec).
// Standard Tokyo normals; used only as a seasonal sanity bound, interpolated by date.
const NORMAL_MAX = [9.8,10.9,14.2,19.4,23.6,26.1,29.9,31.3,27.5,22.0,16.7,12.0];
function normalHigh(){
  const t = jstParts();
  const m = t.mo - 1;
  const daysIn = new Date(Date.UTC(t.y, t.mo, 0)).getUTCDate();
  const frac = (t.da - 1) / Math.max(1, daysIn - 1);   // 0..1 through the month
  const next = (m + 1) % 12;
  return NORMAL_MAX[m] + (NORMAL_MAX[next] - NORMAL_MAX[m]) * frac;  // linear toward next month
}
const REFRESH_MS = 5*60*1000;

/* ================= time helpers (JST) ================= */
function jst(){ return new Date(Date.now() + 9*3600*1000); } // read with getUTC*
function jstParts(){
  const d = jst();
  return {
    y:d.getUTCFullYear(), mo:d.getUTCMonth()+1, da:d.getUTCDate(),
    h:d.getUTCHours(), mi:d.getUTCMinutes(), s:d.getUTCSeconds(),
    dec: d.getUTCHours() + d.getUTCMinutes()/60
  };
}
const p2 = n => String(n).padStart(2,"0");
function todayKey(){ const t=jstParts(); return `${t.y}${p2(t.mo)}${p2(t.da)}`; }
function todayISO(){ const t=jstParts(); return `${t.y}-${p2(t.mo)}-${p2(t.da)}`; }
function tomorrowISO(){
  const d = new Date(jst().getTime() + 24*3600*1000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth()+1)}-${p2(d.getUTCDate())}`;
}
function yesterdayISO(){
  const d = new Date(jst().getTime() - 24*3600*1000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth()+1)}-${p2(d.getUTCDate())}`;
}
function yesterdayKey(){ return yesterdayISO().replaceAll("-",""); }
function d2ISO(){
  const d = new Date(jst().getTime() - 48*3600*1000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth()+1)}-${p2(d.getUTCDate())}`;
}
function d2Key(){ return d2ISO().replaceAll("-",""); }
function hhmm(dec){ const h=Math.floor(dec), m=Math.round((dec-h)*60); return `${p2(h)}:${p2(m)}`; }
const fmt1 = v => (v==null||!isFinite(v)) ? "—" : v.toFixed(1);

/* ================= state ================= */
let S = { obs:[], obsMax:null, obsMaxT:null, cur:null, curT:null, winds:[], hum:null,
          metars:[], metarMax:null, dewp:null, metarWind:null, taf:null, suns:[], press:[], rains:[], cloud:null, models:{}, tomorrow:{}, ok:{},
          neighbors:{}, ydayObsMax:null, ydayModelMax:{}, d2ObsMax:null, d2ModelMax:{}, jmaFx:null, fxRain:null, t850:null, t850Curves:{}, w850:null, hums:[], fxBreeze:null, sounding:null };

/* ================= fetchers ================= */
async function fetchAmedas(){
  const head = await fetch("https://www.jma.go.jp/bosai/amedas/data/latest_time.txt", {cache:"no-store"});
  if(!head.ok) throw new Error("latest_time " + head.status);
  const t = jstParts();
  const blocks = [];
  for(let b=0; b<=t.h; b+=3) blocks.push(p2(b));
  const key = todayKey();
  const results = await Promise.allSettled(blocks.map(b =>
    fetch(`https://www.jma.go.jp/bosai/amedas/data/point/${STATION}/${key}_${b}.json`, {cache:"no-store"})
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
  ));
  const pts = [], wnd = [], suns = [], press = [], rains = [], hums = [];
  let lastHum = null;
  for(const res of results){
    if(res.status !== "fulfilled") continue;
    for(const [ts, v] of Object.entries(res.value)){
      if(!ts.startsWith(key)) continue;
      const hour = parseInt(ts.slice(8,10),10) + parseInt(ts.slice(10,12),10)/60;
      const temp = (v && v.temp) ? v.temp[0] : null;
      if(temp!=null && isFinite(temp)) pts.push({t:hour, v:temp});
      const dir = (v && v.windDirection) ? v.windDirection[0] : null;
      const spd = (v && v.wind) ? v.wind[0] : null;
      if(dir!=null || spd!=null) wnd.push({t:hour, dir, spd});
      const hu = (v && v.humidity) ? v.humidity[0] : null;
      if(hu!=null && isFinite(hu)){ lastHum = {t:hour, v:hu}; hums.push({t:hour, v:hu}); }
      const su = (v && v.sun10m) ? v.sun10m[0] : null;   // minutes of sunshine in the 10-min window
      if(su!=null && isFinite(su)) suns.push({t:hour, v:su});
      const rn = (v && v.precipitation10m) ? v.precipitation10m[0] : null;  // mm in 10 min
      if(rn!=null && isFinite(rn)) rains.push({t:hour, v:rn});
      const pr = (v && v.normalPressure) ? v.normalPressure[0]
               : (v && v.pressure) ? v.pressure[0] : null;
      if(pr!=null && isFinite(pr)) press.push({t:hour, v:pr});
    }
  }
  pts.sort((a,b)=>a.t-b.t);
  wnd.sort((a,b)=>a.t-b.t);
  suns.sort((a,b)=>a.t-b.t);
  press.sort((a,b)=>a.t-b.t);
  rains.sort((a,b)=>a.t-b.t);
  hums.sort((a,b)=>a.t-b.t);
  S.winds = wnd; S.hum = lastHum; S.hums = hums; S.suns = suns; S.press = press; S.rains = rains;
  if(!pts.length) throw new Error("no obs yet");
  S.obs = pts;
  let mx=-1e9, mt=null;
  for(const p of pts) if(p.v>mx){mx=p.v; mt=p.t;}
  S.obsMax = mx; S.obsMaxT = mt;
  const last = pts[pts.length-1];
  S.cur = last.v; S.curT = last.t;
}

async function fetchMetar(){
  const r = await fetch("https://aviationweather.gov/api/data/metar?ids=RJTT&format=json&hours=28", {cache:"no-store"});
  if(!r.ok) throw new Error("metar " + r.status);
  const arr = await r.json();
  if(!Array.isArray(arr) || !arr.length) throw new Error("metar empty");
  const key = todayISO();
  let mmax = null;
  const list = [];
  for(const m of arr){
    const raw = m.rawOb || m.raw_text || "";
    const when = m.reportTime || m.receiptTime || "";
    list.push({raw, when});
    // reportTime is UTC "YYYY-MM-DD HH:MM:SS" → shift to JST
    const d = new Date((when.replace(" ","T"))+"Z");
    if(!isNaN(d)){
      const j = new Date(d.getTime()+9*3600*1000);
      const iso = `${j.getUTCFullYear()}-${p2(j.getUTCMonth()+1)}-${p2(j.getUTCDate())}`;
      if(iso===key && m.temp!=null && isFinite(m.temp)) mmax = Math.max(mmax??-1e9, m.temp);
    }
  }
  S.metars = list.slice(0,6);
  S.metarMax = mmax;
  if(arr[0] && arr[0].dewp!=null && isFinite(arr[0].dewp)) S.dewp = arr[0].dewp;
  if(arr[0]){
    const r0 = arr[0].rawOb || arr[0].raw_text || "";
    const wm = r0.match(/\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)\b/);
    if(wm){
      const toKt = wm[4]==="MPS" ? 1.94384 : 1;
      S.metarWind = {
        dir: wm[1]==="VRB" ? null : parseInt(wm[1],10),
        spd: parseInt(wm[2],10)*toKt,
        gust: wm[3] ? parseInt(wm[3],10)*toKt : null,
        ws: /\bWS\b/.test(r0)
      };
    }
  }
  // fall back to METAR for current obs if AMeDAS failed
  if(S.cur==null && arr[0] && arr[0].temp!=null){
    S.cur = arr[0].temp;
    const d = new Date((arr[0].reportTime||"").replace(" ","T")+"Z");
    if(!isNaN(d)){ const j=new Date(d.getTime()+9*3600*1000); S.curT = j.getUTCHours()+j.getUTCMinutes()/60; }
    if(S.metarMax!=null && S.obsMax==null){ S.obsMax = S.metarMax; }
  }
}

async function fetchModels(){
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}`
    + `&hourly=temperature_2m,cloud_cover,precipitation,temperature_850hPa,wind_direction_10m,wind_direction_850hPa,wind_speed_850hPa&models=${MODELS.map(m=>m.key).join(",")}`
    + `&timezone=Asia%2FTokyo&forecast_days=2&past_days=2`;
  const r = await fetch(url, {cache:"no-store"});
  if(!r.ok) throw new Error("open-meteo " + r.status);
  const j = await r.json();
  const H = j.hourly || {};
  const times = H.time || [];
  const i0 = times.findIndex(t => t.startsWith(todayISO()));
  const i1 = times.findIndex(t => t.startsWith(tomorrowISO()));
  const iY = times.findIndex(t => t.startsWith(yesterdayISO()));
  const iD2 = times.findIndex(t => t.startsWith(d2ISO()));
  if(i0<0) throw new Error("no today hours");
  for(const m of MODELS){
    const a = H[`temperature_2m_${m.key}`] || H.temperature_2m;
    if(!a) continue;
    const today = [], tomo = [];
    for(let k=0;k<24;k++){
      const v = a[i0+k];
      today.push((v==null)?null:v);
      if(i1>=0){ const w=a[i1+k]; tomo.push((w==null)?null:w); }
    }
    if(today.some(v=>v!=null)) S.models[m.key] = today;
    const tv = tomo.filter(v=>v!=null);
    if(tv.length) S.tomorrow[m.key] = Math.max(...tv);
    if(iY>=0){
      const yv=[];
      for(let k=0;k<24;k++){ const v=a[iY+k]; if(v!=null) yv.push(v); }
      if(yv.length) S.ydayModelMax[m.key] = Math.max(...yv);
    }
    if(iD2>=0){
      const dv=[];
      for(let k=0;k<24;k++){ const v=a[iD2+k]; if(v!=null) dv.push(v); }
      if(dv.length) S.d2ModelMax[m.key] = Math.max(...dv);
    }
  }
  const cloud = [];
  for(let k=0;k<24;k++){
    const vs = MODELS.map(m => { const c = H[`cloud_cover_${m.key}`]; return c ? c[i0+k] : null; })
                     .filter(v => v!=null && isFinite(v));
    cloud.push(vs.length ? vs.reduce((a,b)=>a+b,0)/vs.length : null);
  }
  if(cloud.some(v=>v!=null)) S.cloud = cloud;
  // 850 hPa temperature at midday (11–15 JST): the synoptic airmass marker
  {
    const vals = [];
    for(const m of MODELS){
      const a8 = H[`temperature_850hPa_${m.key}`]; if(!a8) continue;
      const curve8 = [];
      for(let k=0;k<24;k++){ const v=a8[i0+k]; curve8.push((v!=null && isFinite(v)) ? v : null); }
      if(curve8.some(v=>v!=null)) S.t850Curves[m.key] = curve8;
      const mid = [];
      for(let k=11;k<=15;k++){ const v=a8[i0+k]; if(v!=null && isFinite(v)) mid.push(v); }
      if(mid.length) vals.push(mid.reduce((x,y)=>x+y,0)/mid.length);
    }
    if(vals.length){
      S.t850 = { mean: vals.reduce((a,b)=>a+b,0)/vals.length,
                 lo: Math.min(...vals), hi: Math.max(...vals), n: vals.length };
    }
    // midday 850 hPa wind: vector mean across models (foehn / advection detector)
    let u=0, v=0, wn=0, spds=[];
    for(const m of MODELS){
      const wd = H[`wind_direction_850hPa_${m.key}`], ws = H[`wind_speed_850hPa_${m.key}`];
      if(!wd || !ws) continue;
      for(let k=11;k<=15;k++){
        const dirv = wd[i0+k], spv = ws[i0+k];
        if(dirv==null || spv==null) continue;
        const r = dirv*Math.PI/180;
        u += Math.sin(r)*spv; v += Math.cos(r)*spv; spds.push(spv); wn++;
      }
    }
    if(wn){
      let dir = Math.atan2(u/wn, v/wn)*180/Math.PI; if(dir<0) dir+=360;
      S.w850 = {dir: Math.round(dir), spd: spds.reduce((a,b)=>a+b,0)/spds.length};
    }
  }
  // forecast sea-breeze onset: first hour 09–17 JST each model turns the wind onshore (70–215°)
  {
    const onsets = [];
    for(const m of MODELS){
      const wd = H[`wind_direction_10m_${m.key}`]; if(!wd) continue;
      let hr = null;
      for(let k=9;k<=17;k++){
        const v = wd[i0+k];
        if(v!=null && v>=70 && v<=215){ hr = k; break; }
      }
      if(hr!=null) onsets.push(hr);
    }
    if(onsets.length){
      onsets.sort((a,b)=>a-b);
      const med = onsets.length%2 ? onsets[(onsets.length-1)/2] : (onsets[onsets.length/2-1]+onsets[onsets.length/2])/2;
      S.fxBreeze = {median: med, lo: onsets[0], hi: onsets[onsets.length-1], n: onsets.length, total: MODELS.length};
    } else {
      S.fxBreeze = {median: null, n: 0};
    }
  }
  // forecast rain: mean across models of the next-3h precip total (mm)
  {
    const nowH = Math.floor(jstParts().dec);
    const sums = MODELS.map(m => {
      const a2 = H[`precipitation_${m.key}`]; if(!a2) return null;
      let sum=0, n=0;
      for(let k=nowH; k<Math.min(24,nowH+3); k++){ const v=a2[i0+k]; if(v!=null){sum+=v;n++;} }
      return n? sum : null;
    }).filter(v=>v!=null);
    if(sums.length) S.fxRain = sums.reduce((a,b)=>a+b,0)/sums.length;
  }
  if(!Object.keys(S.models).length) throw new Error("no model data");
}

async function fetchNeighbors(){
  // latest 3-hour block for each neighbor station -> most recent temp + wind dir
  const t = jstParts();
  const block = p2(Math.floor(t.h/3)*3);
  const key = todayKey();
  const res = await Promise.allSettled(NEIGHBORS.map(n =>
    fetch(`https://www.jma.go.jp/bosai/amedas/data/point/${n.id}/${key}_${block}.json`, {cache:"no-store"})
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
  ));
  res.forEach((r,i)=>{
    if(r.status!=="fulfilled") return;
    const keys = Object.keys(r.value).filter(k=>k.startsWith(key)).sort();
    if(!keys.length) return;
    const last = r.value[keys[keys.length-1]];
    const temp = last && last.temp ? last.temp[0] : null;
    const dir  = last && last.windDirection ? last.windDirection[0] : null;
    const spd  = last && last.wind ? last.wind[0] : null;
    if(temp!=null && isFinite(temp))
      S.neighbors[NEIGHBORS[i].id] = {name:NEIGHBORS[i].name, temp, dir, spd,
        t: parseInt(keys[keys.length-1].slice(8,10),10)+parseInt(keys[keys.length-1].slice(10,12),10)/60};
  });
  if(!Object.keys(S.neighbors).length) throw new Error("no neighbor data");
}

async function fetchYdayObs(){
  // actual maxes at Haneda for the last two days, for model verification
  const blocks = ["00","03","06","09","12","15","18","21"];
  async function dayMax(key){
    const res = await Promise.allSettled(blocks.map(b =>
      fetch(`https://www.jma.go.jp/bosai/amedas/data/point/${STATION}/${key}_${b}.json`, {cache:"no-store"})
        .then(r => r.ok ? r.json() : Promise.reject(r.status))
    ));
    let mx = null;
    for(const r of res){
      if(r.status!=="fulfilled") continue;
      for(const [ts,v] of Object.entries(r.value)){
        if(!ts.startsWith(key)) continue;
        const temp = v && v.temp ? v.temp[0] : null;
        if(temp!=null && isFinite(temp)) mx = (mx==null)?temp:Math.max(mx,temp);
      }
    }
    return mx;
  }
  const [y, d2] = await Promise.all([dayMax(yesterdayKey()), dayMax(d2Key())]);
  S.ydayObsMax = y; S.d2ObsMax = d2;
  if(y==null && d2==null) throw new Error("no past obs");
}

/* ===== per-model daily error log (feeds the 7d rank column) =====
   Between 10:15-16:00 JST the raw daily max each model shows for TODAY is locked;
   the next day it is graded against the AMeDAS actual. Last 30 days kept. */
const MLOG_KEY="rjtt_mlog_v1";
function mlogLoad(){ try{ return JSON.parse(localStorage.getItem(MLOG_KEY)||"{}"); }catch(e){ return {}; } }
function mlogSave(j){ try{ localStorage.setItem(MLOG_KEY, JSON.stringify(j)); }catch(e){} }
function modelLogTick(){
  try{
    const now=jstParts().dec, k=todayISO();
    const j=mlogLoad(); let dirty=false;
    if(now>=10.25 && now<=16 && !(j[k]&&j[k].models)){
      const snap={};
      for(const m of MODELS){
        const T=S.models[m.key]; if(!T) continue;
        let mx=-1e9; for(let h=0;h<24;h++){ const v=T[h]; if(v!=null&&v>mx) mx=v; }
        if(mx>-100) snap[m.key]=+mx.toFixed(1);
      }
      if(Object.keys(snap).length>=3){ j[k]=j[k]||{}; j[k].models=snap; dirty=true; }
    }
    const y=new Date(jst().getTime()-864e5);
    const yk=`${y.getUTCFullYear()}-${p2(y.getUTCMonth()+1)}-${p2(y.getUTCDate())}`;
    if(j[yk] && j[yk].models && j[yk].actual==null && S.ydayObsMax!=null){ j[yk].actual=S.ydayObsMax; dirty=true; }
    const keys=Object.keys(j).sort();
    if(keys.length>30){ for(const kk of keys.slice(0,keys.length-30)) delete j[kk]; dirty=true; }
    if(dirty) mlogSave(j);
  }catch(e){}
}
function compute7d(){
  try{
    const j=mlogLoad();
    const graded=Object.keys(j).filter(k=>j[k].actual!=null&&j[k].models).sort().slice(-7);
    if(graded.length<3) return {ranks:{}, mae:{}, n:graded.length};
    const errs={};
    for(const k of graded){ const e=j[k];
      for(const mk in e.models){ (errs[mk]=errs[mk]||[]).push(Math.abs(e.models[mk]-e.actual)); } }
    const mae={};
    for(const mk in errs){ if(errs[mk].length>=3) mae[mk]=+(errs[mk].reduce((a,b)=>a+b,0)/errs[mk].length).toFixed(2); }
    const order=Object.keys(mae).sort((a,b)=>mae[a]-mae[b]);
    const ranks={}; order.forEach((mk,i)=>ranks[mk]=i+1);
    return {ranks, mae, n:graded.length};
  }catch(e){ return {ranks:{}, mae:{}, n:0}; }
}
/* ================= model skill ranking ================= */
function computeSkill(){
  // Score = 0.6 × mean |daily-max error| over the last 2 verified days
  //       + 0.4 × mean |model − obs| across today's observations so far.
  // Lower is better. Ranks drive the blend weights.
  const scores = {};
  for(const m of MODELS){
    const errs = [];
    if(S.ydayObsMax!=null && S.ydayModelMax[m.key]!=null) errs.push(Math.abs(S.ydayModelMax[m.key]-S.ydayObsMax));
    if(S.d2ObsMax!=null && S.d2ModelMax[m.key]!=null) errs.push(Math.abs(S.d2ModelMax[m.key]-S.d2ObsMax));
    const maxErr = errs.length ? errs.reduce((a,b)=>a+b,0)/errs.length : null;
    let trackMAE = null;
    const T = S.models[m.key];
    if(T && S.obs.length >= 6){
      let sum=0, n=0;
      for(let i=0; i<S.obs.length; i+=3){           // every 30 min is plenty
        const p = S.obs[i];
        const mv = interpHour(T, Math.min(p.t,23.99));
        if(mv!=null){ sum += Math.abs(p.v - mv); n++; }
      }
      if(n) trackMAE = sum/n;
    }
    if(maxErr!=null && trackMAE!=null) scores[m.key] = 0.6*maxErr + 0.4*trackMAE;
    else if(maxErr!=null) scores[m.key] = maxErr;
    else if(trackMAE!=null) scores[m.key] = trackMAE;
  }
  const keys = Object.keys(scores);
  if(!keys.length) return {scores:{}, ranks:{}, have:false};
  keys.sort((a,b)=>scores[a]-scores[b]);
  const ranks = {};
  keys.forEach((k,i)=>ranks[k]=i+1);
  return {scores, ranks, have:true, n:keys.length};
}

async function fetchJmaForecast(){
  // JMA official public forecast for Tokyo-to (130000): forecaster-edited point temps
  const r = await fetch("https://www.jma.go.jp/bosai/forecast/data/forecast/130000.json", {cache:"no-store"});
  if(!r.ok) throw new Error("jma fx " + r.status);
  const j = await r.json();
  try{
    for(const block of j){
      for(const ts of (block.timeSeries||[])){
        for(const area of (ts.areas||[])){
          if(area.temps && area.area && /東京/.test(area.area.name)){
            const vals = area.temps.map(Number).filter(v=>isFinite(v));
            if(vals.length){ S.jmaFx = {max: Math.max(...vals), name: area.area.name}; return; }
          }
        }
      }
    }
  }catch(e){ /* structure shift: degrade silently */ }
  if(!S.jmaFx) throw new Error("no temps in jma fx");
}

async function fetchSounding(){
  const LV=[1000,975,950,925,900,850,800,700,600,500];
  const t=jstParts();
  const v=[];
  for(const L of LV){ v.push(`temperature_${L}hPa`,`relative_humidity_${L}hPa`,`wind_speed_${L}hPa`,`wind_direction_${L}hPa`,`geopotential_height_${L}hPa`); }
  const url=`https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&hourly=${v.join(",")}&forecast_days=1&timezone=Asia%2FTokyo`;
  const r=await fetch(url,{cache:"no-store"}); if(!r.ok) throw new Error("sounding "+r.status);
  const j=await r.json(); const H=j.hourly||{}; const times=H.time||[];
  // pick the hour nearest 14:00 JST (afternoon mixing) but not before now
  let idx=times.findIndex(x=>x.startsWith(todayISO()) && +x.slice(11,13)===Math.max(13,Math.min(14,Math.ceil(t.dec))));
  if(idx<0) idx=times.findIndex(x=>x.startsWith(todayISO()) && +x.slice(11,13)===14);
  if(idx<0) idx=Math.max(0, times.findIndex(x=>x.startsWith(todayISO())));
  const lv=[];
  for(const L of LV){
    const T=H[`temperature_${L}hPa`], RH=H[`relative_humidity_${L}hPa`], WS=H[`wind_speed_${L}hPa`], WD=H[`wind_direction_${L}hPa`], GH=H[`geopotential_height_${L}hPa`];
    if(!T) continue;
    const temp=T[idx], rh=RH?RH[idx]:null, ws=WS?WS[idx]:null, wd=WD?WD[idx]:null, gh=GH?GH[idx]:null;
    if(temp==null||gh==null) continue;
    const td = (rh!=null) ? magnusTd(temp, Math.max(1,rh)) : null;
    lv.push({p:L, t:temp, td, rh, ws, wd, z:gh});
  }
  if(lv.length<4) throw new Error("thin sounding");
  S.sounding={levels:lv, validH:+times[idx].slice(11,13)};
}

async function fetchTaf(){
  const r = await fetch("https://aviationweather.gov/api/data/taf?ids=RJTT&format=json", {cache:"no-store"});
  if(!r.ok) throw new Error("taf " + r.status);
  const arr = await r.json();
  if(!Array.isArray(arr) || !arr.length) throw new Error("taf empty");
  const raw = arr[0].rawTAF || arr[0].rawOb || "";
  const m = raw.match(/TX(M?)(\d{2})\/(\d{2})(\d{2})Z/);
  let tx=null, txWhen=null;
  if(m){
    tx = (m[1]==="M" ? -1 : 1) * parseInt(m[2],10);
    txWhen = `day ${m[3]} ${p2((parseInt(m[4],10)+9)%24)}:00 JST`;
  }
  S.taf = {raw, tx, txWhen};
}

/* ================= local signals ================= */
function magnusTd(T,RH){ const a=17.62,b=243.12; const g=Math.log(RH/100)+a*T/(b+T); return b*g/(a-g); }
function tempNear(x){
  let best=null, bd=1e9;
  for(const p of S.obs){ const d=Math.abs(p.t-x); if(d<bd){bd=d; best=p.v;} }
  return best;
}
function analyzeLocal(){
  const L = {sunTxt:"—", sunNote:"no sunshine data yet",
             windTxt:"—", windNote:"no wind data yet", flow:null,
             seaTxt:"—", seaNote:"AMeDAS wind feed needed", seaIn:false, onset:null, drop:null,
             dewTxt:"—", dewNote:"no moisture data yet",
             tafTxt:"—", tafNote:"TAF feed unavailable"};
  const w = S.winds || [];
  if(w.length){
    const last = w[w.length-1];
    const dn = DIR_NAMES[last.dir] ?? "—";
    L.windTxt = `${dn}${last.spd!=null ? " · "+last.spd.toFixed(1)+" m/s" : ""}`;
    if(last.dir===0){ L.flow="calm"; L.windNote="calm — radiative heating runs uncapped for now"; }
    else if(ONSHORE.has(last.dir)){ L.flow="onshore"; L.windNote="onshore off Tokyo Bay — maritime air, cap risk on the high"; }
    else if(INLAND.has(last.dir)){ L.flow="inland"; L.windNote="flow across the Tokyo metro — heat-island air, upside vs raw models"; }
    else { L.flow="alongshore"; L.windNote="alongshore — weak land/sea signal"; }
    let runStart=null;
    for(let i=w.length-1; i>=0; i--){
      if(w[i].dir!=null && ONSHORE.has(w[i].dir)) runStart = w[i].t; else break;
    }
    if(runStart!=null && (w[w.length-1].t - runStart >= 0.5 || w.length<4)){
      L.seaIn=true; L.onset=runStart;
      const tAt = tempNear(runStart);
      let minAfter=null;
      for(const p of S.obs) if(p.t>=runStart && p.t<=runStart+1.5) minAfter = (minAfter==null)?p.v:Math.min(minAfter,p.v);
      if(tAt!=null && minAfter!=null) L.drop = tAt - minAfter;
      const switched = w.some(pp => pp.t<runStart && pp.dir!=null && pp.dir!==0 && !ONSHORE.has(pp.dir));
      L.seaTxt = `IN · since ${hhmm(runStart)}`;
      L.seaNote = (switched ? "switched from land flow; " : "")
                + (L.drop!=null && L.drop>0.3 ? `−${L.drop.toFixed(1)}°C since onset; ` : "")
                + (runStart < 13.5
                   ? "arrived BEFORE the ~14:00 peak → day's max is capped at the pre-onset level (typically 2–4° below inland)"
                   : "arrived after the peak → max already printed; this only speeds the evening cooldown");
    } else {
      L.seaTxt = "NOT IN";
      const fb = S.fxBreeze;
      let eta = "onset usually 11:00–14:00 JST";
      if(fb && fb.median!=null){
        eta = `models expect onset ~${hhmm(fb.median)} (${fb.n}/${fb.total} agree, range ${hhmm(fb.lo)}–${hhmm(fb.hi)})`;
        L.breezeEta = fb.median;
      } else if(fb && fb.n===0){
        eta = "models keep the wind offshore all afternoon — breeze may not arrive; inland-style high possible";
      }
      const yoko = S.neighbors && S.neighbors["46106"];
      const yokoOn = yoko && yoko.dir!=null && ONSHORE.has(yoko.dir);
      L.seaNote = eta + (yokoOn ? " · ⚠ Yokohama is already onshore — front approaching, Haneda onset likely within the hour"
                                : "") + " · arrival before ~14:00 caps the max; after, it only cools the evening";
    }
  }
  // sunshine: minutes of sun in the latest 10-min window + fraction over the last hour
  const su = S.suns || [];
  if(su.length){
    const last = su[su.length-1];
    const hourAgo = last.t - 1;
    const recent = su.filter(x => x.t > hourAgo);
    const got = recent.reduce((a,b)=>a+b.v, 0);
    const poss = recent.length * 10;
    const frac = poss>0 ? got/poss : null;
    L.sunTxt = `${Math.round(last.v)}/10 min`;
    let pr = "";
    if(S.press && S.press.length>=2){
      const d = S.press[S.press.length-1].v - S.press[0].v;
      pr = ` · MSLP ${S.press[S.press.length-1].v.toFixed(0)} hPa ${d>=0.6?"rising (offshore-high risk → sea-breeze cap)":d<=-0.6?"falling":"steady"}`;
    }
    L.sunNote = (frac==null ? "tracking insolation"
                : frac>=0.8 ? `near-full sun (${Math.round(frac*100)}% of last hr) — strong heating, supports the high`
                : frac>=0.4 ? `broken sun (${Math.round(frac*100)}% of last hr) — moderate heating`
                : `mostly cloud (${Math.round(frac*100)}% of last hr) — heating capped, downside on the max`) + pr;
    if(S.cloud){
      const nowH = Math.floor(jstParts().dec);
      const rest = S.cloud.slice(nowH, 15).filter(v=>v!=null);
      if(rest.length){
        const avg = rest.reduce((a,b)=>a+b,0)/rest.length;
        L.sunNote += ` · forecast cloud to ~14:00 avg ${Math.round(avg)}%`;
      }
    }
  } else {
    L.sunNote = "no sunshine element in this station feed";
  }

  // rain: observed 10-min + last hour, plus model next-3h
  L.rainTxt="—"; L.rainNote="no precipitation data"; L.raining=false;
  {
    const rr = S.rains || [];
    const last = rr.length ? rr[rr.length-1] : null;
    const hourTotal = rr.filter(x=>last && x.t>last.t-1).reduce((a,b)=>a+b.v,0);
    const fx = S.fxRain;
    if(last){
      L.raining = last.v>0 || hourTotal>0.5;
      L.rainTxt = L.raining ? `${last.v.toFixed(1)} mm/10min` : "DRY";
      const parts=[];
      if(L.raining) parts.push(`${hourTotal.toFixed(1)} mm last hr — heating shut off, high effectively capped at current level`);
      else parts.push("no rain at station");
      if(fx!=null) parts.push(fx>=1 ? `models: ${fx.toFixed(1)} mm next 3 h — rain risk, downside on the max`
                            : fx>=0.2 ? `models: light showers possible next 3 h (${fx.toFixed(1)} mm)`
                            : "models: dry next 3 h");
      L.rainNote = parts.join(" · ");
    } else if(fx!=null){
      L.rainTxt = fx>=1 ? "RAIN RISK" : "DRY (FX)";
      L.rainNote = `models: ${fx.toFixed(1)} mm next 3 h`;
    }
  }

  let td = S.dewp, src = "METAR";
  if(td==null && S.hum && S.cur!=null){ td = magnusTd(S.cur, S.hum.v); src = "AMeDAS RH"; }
  if(td!=null && S.cur!=null){
    const spread = S.cur - td;
    // Td trend over the last ~3 h from AMeDAS RH + temp
    let tdTrend = null;
    if(S.hums && S.hums.length){
      const now3 = jstParts().dec - 3;
      const old = S.hums.find(x => x.t >= now3 - 0.4 && x.t <= now3 + 0.4);
      const oT = old ? tempNear(old.t) : null;
      if(old && oT!=null){ tdTrend = td - magnusTd(oT, old.v); }
    }
    L.dewTrend = tdTrend;
    L.dewTxt = `${fmt1(td)}°C · Δ${fmt1(spread)}°`;
    L.dewNote = (td>=21 ? `humid air mass (${src}) — solar energy goes to moisture, caps the max`
              : td<=12 ? `dry air mass (${src}) — efficient surface heating, upside if sunny`
              : `moderate moisture (${src}) — broadly neutral for the high`)
              + (tdTrend!=null && Math.abs(tdTrend)>=0.7
                 ? (tdTrend<0 ? ` · Td falling ${fmt1(-tdTrend)}°/3h — drying, heating efficiency improving (upside)`
                              : ` · Td rising ${fmt1(tdTrend)}°/3h — moistening, cap tightening`)
                 : ``);
  }
  if(S.taf){
    if(S.taf.tx!=null){
      L.tafTxt = `${S.taf.tx}°C`;
      L.tafNote = `TX group, valid ${S.taf.txWhen} — forecaster-edited; weigh above raw global models`;
    } else { L.tafTxt = "no TX"; L.tafNote = "latest TAF carries no max-temp group"; }
  }

  // --- operations: runway flow, breeze shift, shear/turbulence ---
  L.flowTxt="—"; L.flowNote="awaiting wind"; L.shiftTxt="—"; L.shiftNote="—";
  L.turbTxt="—"; L.turbNote="awaiting wind";
  let rDir=null, rSpd=null, rGust=null, rWS=false, rSrc="AMeDAS";
  if(S.metarWind){ rDir=S.metarWind.dir; rSpd=S.metarWind.spd; rGust=S.metarWind.gust; rWS=S.metarWind.ws; rSrc="METAR"; }
  else if(w.length){ const last=w[w.length-1]; rDir = (last.dir!=null && last.dir!==0) ? (last.dir-1)*22.5 : null; rSpd = last.spd!=null ? last.spd*1.94384 : null; }
  if(rDir!=null){
    const north = (rDir>=290 || rDir<=70);
    const south = (rDir>=110 && rDir<=250);
    const hr = jstParts().h;
    if(north){ L.flowTxt="NORTH-FLOW"; L.flowNote="landings 34L/34R, departures 34R/05 (typical, ATC/noise-abatement dependent)"; }
    else if(south){
      L.flowTxt="SOUTH-FLOW";
      L.flowNote = (hr>=15 && hr<19)
        ? "departures 16L/16R; afternoon arrivals via the central-Tokyo 16L/16R routes (15–19 JST, typical)"
        : "departures 16L/16R; arrivals 22/23 (typical, ATC/noise-abatement dependent)";
    } else { L.flowTxt="VARIABLE"; L.flowNote="light/variable — configuration set by ATC and noise-abatement rules"; }
  }
  if(L.seaIn && L.onset!=null){ L.shiftTxt=`SEA · ${hhmm(L.onset)}`; L.shiftNote="bay flow established; expect south-flow / config change around onset"; }
  else if(L.flow==="inland"||L.flow==="calm"){ L.shiftTxt="LAND / CALM"; L.shiftNote="land breeze or calm — sea breeze typically sets in 11:00–14:00 JST"; }
  else { L.shiftTxt="—"; L.shiftNote="no clear land/sea transition yet"; }
  if(rSpd!=null){
    const gustFactor = (rGust!=null) ? (rGust-rSpd) : 0;
    const southerly = rDir!=null && rDir>=140 && rDir<=220;
    const reasons=[];
    if(rWS) reasons.push("METAR windshear group");
    if(southerly && rSpd>=15) reasons.push("strong southerly over Boso Peninsula — mechanical turbulence on approach");
    if(gustFactor>=10) reasons.push(`gusting +${Math.round(gustFactor)} kt`);
    if(reasons.length){
      L.turbTxt = rWS ? "WS / TURB" : "TURB RISK";
      L.turbNote = reasons.join("; ") + ` (${rSrc} ${rDir!=null?Math.round(rDir)+"°":"VRB"}/${Math.round(rSpd)}${rGust?"G"+Math.round(rGust):""} kt)`;
    } else {
      L.turbTxt="LOW";
      L.turbNote = `smooth — ${rSrc} ${rDir!=null?Math.round(rDir)+"°":"VRB"}/${Math.round(rSpd)} kt, no shear signal`;
    }
  }
  return L;
}

/* ================= analog days: history-based prediction ================= */
function obsAt(x){
  let best=null, bd=0.45;
  for(const p of S.obs){ const d=Math.abs(p.t-x); if(d<bd){bd=d; best=p.v;} }
  return best;
}
function onshoreAt9(){
  let best=null, bd=0.6;
  for(const p of (S.winds||[])){ const d=Math.abs(p.t-9); if(d<bd && p.dir!=null){bd=d; best=p.dir;} }
  if(best==null) return null;
  return ONSHORE.has(best) ? 1 : 0;
}
function dayOfYear(){
  const t = jstParts();
  return Math.floor((Date.UTC(t.y,t.mo-1,t.da) - Date.UTC(t.y,0,0))/864e5);
}
async function maybeFetchArchive(){
  try{
    const cached = localStorage.getItem("rjtt_arc_v2");
    if(cached){ const o = JSON.parse(cached); if(o.fetched === todayISO() && o.days && o.days.length){ S.archive = o; return; } }
  }catch(e){}
  try{
    const end = yesterdayISO();
    const start = new Date(jst().getTime() - 730*864e5);
    const sIso = `${start.getUTCFullYear()}-${p2(start.getUTCMonth()+1)}-${p2(start.getUTCDate())}`;
    const u = `https://archive-api.open-meteo.com/v1/archive?latitude=${LAT}&longitude=${LON}&start_date=${sIso}&end_date=${end}&hourly=temperature_2m,cloud_cover,wind_direction_10m&timezone=Asia%2FTokyo`;
    const r = await fetch(u); if(!r.ok) throw new Error("archive "+r.status);
    const j = await r.json(); const H = j.hourly || {};
    const T = H.temperature_2m||[], C = H.cloud_cover||[], W = H.wind_direction_10m||[], times = H.time||[];
    const days = [];
    for(let i=0; i+23 < T.length; i+=24){
      const t6 = T[i+6], t9 = T[i+9];
      if(t6==null || t9==null) continue;
      let hi=-1e9, hiH=14, lo=1e9, loH=5;
      for(let h=0; h<24; h++){ const v=T[i+h]; if(v!=null){ if(v>hi){hi=v; hiH=h;} if(v<lo){lo=v; loH=h;} } }
      if(hi<-100) continue;
      let cs=0, cn=0;
      for(let h=6; h<13; h++){ const v=C[i+h]; if(v!=null){cs+=v; cn++;} }
      const wd = W[i+9];
      const dt = new Date(times[i]);
      const doy = Math.floor((Date.UTC(dt.getUTCFullYear(),dt.getUTCMonth(),dt.getUTCDate()) - Date.UTC(dt.getUTCFullYear(),0,0))/864e5);
      days.push({doy, t9:+t9.toFixed(1), ramp:+(t9-t6).toFixed(2),
                 cloud: cn?Math.round(cs/cn):null,
                 on: (wd!=null)?((wd>=70&&wd<=215)?1:0):null,
                 hi:+hi.toFixed(1), hiH, lo:+lo.toFixed(1), loH, date: times[i].slice(0,10)});
    }
    if(!days.length) throw new Error("empty archive");
    S.archive = {fetched: todayISO(), days};
    try{ localStorage.setItem("rjtt_arc_v2", JSON.stringify(S.archive)); }catch(e){}
  }catch(e){ /* analog panel degrades gracefully */ }
}
function computeAnalogs(){
  const arc = S.archive;
  if(!arc || !arc.days || !arc.days.length) return null;
  if(jstParts().dec < 9.16) return {pending:true};
  const t9 = obsAt(9), t6 = obsAt(6);
  if(t9==null || t6==null) return null;
  const ramp = t9 - t6;
  let cloud = null;
  if(S.cloud){ const cs = S.cloud.slice(6,13).filter(v=>v!=null); if(cs.length) cloud = cs.reduce((a,b)=>a+b,0)/cs.length; }
  const wOn = onshoreAt9();
  const doy = dayOfYear();
  const scored = [];
  for(const d of arc.days){
    let dd = Math.abs(doy - d.doy); dd = Math.min(dd, 365-dd);
    if(dd > 45) continue;                       // same season only
    let dist = Math.abs(t9 - d.t9) + 1.5*Math.abs(ramp - d.ramp);
    if(cloud!=null && d.cloud!=null) dist += Math.abs(cloud - d.cloud)/25;
    if(wOn!=null && d.on!=null && wOn!==d.on) dist += 0.8;
    scored.push([dist, d]);
  }
  scored.sort((a,b)=>a[0]-b[0]);
  const K = scored.slice(0,15).map(x=>x[1]);
  if(K.length < 5) return null;
  const deltas = K.map(d=>d.hi - d.t9).sort((a,b)=>a-b);
  const q = p => deltas[Math.min(deltas.length-1, Math.floor(p*deltas.length))];
  const peaks = K.map(d=>d.hiH).sort((a,b)=>a-b);
  return {n:K.length, high:t9+q(0.5), lo:t9+q(0.25), hiQ:t9+q(0.75), peak:peaks[Math.floor(peaks.length/2)]};
}

/* ================= print forecast: what will the next METARs say? ================= */
function metarPrintOffset(){
  // mean (METAR print − AMeDAS at the same minute) over today's recent prints
  const diffs = [];
  for(const m of (S.metars||[])){
    const raw = m.raw || "";
    const tm = raw.match(/\b\d{2}(\d{2})(\d{2})Z\b/);
    const tg = raw.match(/\s(M?)(\d{2})\/(M?\d{2}|\/\/)/);
    if(!tm || !tg) continue;
    const tJ = ((parseInt(tm[1],10)+9)%24) + parseInt(tm[2],10)/60;
    const mt = (tg[1]==="M" ? -1 : 1) * parseInt(tg[2],10);
    const ov = obsAt(tJ);
    if(ov!=null) diffs.push(mt - ov);
  }
  if(!diffs.length) return {off:0, n:0};
  return {off: diffs.reduce((a,b)=>a+b,0)/diffs.length, n: diffs.length};
}
function printForecast(nc){
  const now = jstParts().dec;
  const allObs = S.obs || [];
  // Use the last ~60 min of observations; if that's thin, fall back to the last 4 points.
  let pts = allObs.filter(p => p.t > now - 1.0);
  if(pts.length < 2 && allObs.length >= 2) pts = allObs.slice(-4);
  // need at least 2 points and a current temp to project anything
  if(pts.length < 2 || S.cur==null) return null;
  // least-squares trend over the recent window (°C per hour)
  const n = pts.length;
  const mx = pts.reduce((a,p)=>a+p.t,0)/n, my = pts.reduce((a,p)=>a+p.v,0)/n;
  let num=0, den=0;
  for(const p of pts){ num += (p.t-mx)*(p.v-my); den += (p.t-mx)**2; }
  let slope = den>0 ? num/den : 0;
  // guard against a wild slope from a single noisy jump
  if(!isFinite(slope) || Math.abs(slope) > 12) slope = 0;
  const {off, n:offN} = metarPrintOffset();
  // next three report times (:00 / :30)
  const rows = [];
  let t0 = Math.ceil(now*2)/2; if(t0 - now < 0.03) t0 += 0.5;
  for(let i=0; i<3; i++){
    const tP = t0 + 0.5*i; if(tP >= 24) break;
    const dt = tP - (S.curT ?? now);
    const proj = S.cur + slope*Math.min(dt, 1.2) + off;
    const sg = 0.18 + 0.25*Math.max(0, tP - now);
    const k = Math.round(proj);
    const pk = kk => phi((kk+0.5-proj)/sg) - phi((kk-0.5-proj)/sg);
    const cand = [k-1,k,k+1].map(kk=>({k:kk, p:pk(kk)})).sort((a,b)=>b.p-a.p);
    rows.push({tP, isHour: Math.abs(tP-Math.round(tP))<0.01, exp:cand[0].k, prob:cand[0].p, alt:cand[1], proj});
  }
  // expected printed max for the rest of the day, sampling the corrected blend
  let pmHalf=null, pmHour=null;
  if(nc.blendCurve){
    for(let h=Math.ceil(now*2)/2; h<24; h+=0.5){
      const v = interpHour(nc.blendCurve, Math.min(h,23.99));
      if(v==null) continue;
      const pv = v + off;
      if(pmHalf==null || pv>pmHalf) pmHalf = pv;
      if(Math.abs(h-Math.round(h))<0.01 && (pmHour==null || pv>pmHour)) pmHour = pv;
    }
  }
  const floorK = (S.metarMax!=null) ? Math.round(S.metarMax)
               : (S.obsMax!=null ? Math.round(S.obsMax + off) : null);
  const pHalf = pmHalf!=null ? Math.max(floorK ?? -99, Math.round(pmHalf)) : null;
  const pHour = pmHour!=null ? Math.max(floorK ?? -99, Math.round(pmHour)) : null;
  return {rows, off, offN, slope, pHalf, pHour};
}

/* ================= journal: record the 10:30 verdict, grade it next day ================= */
/* ===== Journal storage: browser + optional permanent cloud (Supabase) =====
   To enable cloud auto-save, paste your project URL and anon key below.
   Leave them blank to stay browser-only. Setup steps are on the How it works page. */
const JR_CLOUD = {
  url: "",      // e.g. "https://abcdefgh.supabase.co"
  key: "",      // your anon public key
  table: "rjtt_journal",
  rowId: "main" // single shared row holding the whole journal blob
};
function jrCloudOn(){ return !!(JR_CLOUD.url && JR_CLOUD.key); }

function journalLoad(){ try{ return JSON.parse(localStorage.getItem("rjtt_jr_v1")||"{}"); }catch(e){ return {}; } }
function journalSave(j){
  try{ localStorage.setItem("rjtt_jr_v1", JSON.stringify(j)); }catch(e){}
  cloudPush(j);   // fire-and-forget background save to the cloud
}

// merge two journals: graded days win; otherwise the one with more recorded calls
function journalMerge(a, b){
  const out = Object.assign({}, a);
  for(const k in b){
    const x=out[k], y=b[k];
    if(!x){ out[k]=y; continue; }
    const xg=x.actual!=null, yg=y.actual!=null;
    if(yg && !xg) out[k]=y;
    else if(yg===xg){ if((y.calls||[]).length > (x.calls||[]).length) out[k]=y; }
  }
  return out;
}

let _cloudBusy=false, _cloudPending=null;
async function cloudPush(j){
  if(!jrCloudOn()) return;
  if(_cloudBusy){ _cloudPending=j; return; }   // coalesce rapid saves
  _cloudBusy=true;
  try{
    await fetch(`${JR_CLOUD.url}/rest/v1/${JR_CLOUD.table}?on_conflict=id`, {
      method:"POST",
      headers:{
        "apikey":JR_CLOUD.key, "Authorization":`Bearer ${JR_CLOUD.key}`,
        "Content-Type":"application/json", "Prefer":"resolution=merge-duplicates"
      },
      body: JSON.stringify([{ id:JR_CLOUD.rowId, data:j, updated:new Date().toISOString() }])
    });
  }catch(e){ /* offline: browser copy still holds */ }
  _cloudBusy=false;
  if(_cloudPending){ const p=_cloudPending; _cloudPending=null; cloudPush(p); }
}
async function cloudPull(){
  if(!jrCloudOn()) return null;
  try{
    const r=await fetch(`${JR_CLOUD.url}/rest/v1/${JR_CLOUD.table}?id=eq.${JR_CLOUD.rowId}&select=data`, {
      headers:{ "apikey":JR_CLOUD.key, "Authorization":`Bearer ${JR_CLOUD.key}` }
    });
    if(!r.ok) return null;
    const rows=await r.json();
    return (rows && rows[0] && rows[0].data) ? rows[0].data : null;
  }catch(e){ return null; }
}
// on startup: pull cloud copy, merge with local, save the union back
async function cloudSync(){
  if(!jrCloudOn()) return;
  const remote=await cloudPull(); if(!remote) { cloudPush(journalLoad()); return; }
  const merged=journalMerge(journalLoad(), remote);
  try{ localStorage.setItem("rjtt_jr_v1", JSON.stringify(merged)); }catch(e){}
  cloudPush(merged);
  // refresh the panel if it's already rendered
  const badge=document.getElementById("a-rec-note");
  if(badge && jrCloudOn()) badge.textContent += " · ☁ cloud-synced";
}
/* ===== journal memory: learn from the dashboard's OWN graded days =====
   Every graded day carries an error (actual high - locked call). Weight past days
   by similarity to THIS morning (09:00 temp, 06->09 ramp, morning cloud, season),
   take the weighted mean error, shrink it toward zero while the record is small
   (n/(n+6)), cap at +/-0.8 deg, and fold it into today's high. */
function featSnapshot(){
  try{
    const o = S.obs || [];
    const at = h => { let best=null, bd=9; for(const p of o){ const d=Math.abs(p.t-h); if(d<bd){ bd=d; best=p.v; } } return bd<=0.5 ? best : null; };
    const t9 = at(9), t6 = at(6);
    const ramp = (t9!=null && t6!=null) ? +(t9-t6).toFixed(2) : null;
    let cloud = null;
    if(S.cloud){ const cs = S.cloud.slice(6,11).filter(v=>v!=null); if(cs.length) cloud = Math.round(cs.reduce((a,b)=>a+b,0)/cs.length); }
    const w = S.winds || []; const lw = w.length ? w[w.length-1] : null;
    const d = jst(); const doy = Math.floor((d - new Date(d.getFullYear(),0,0)) / 864e5);
    return { t9: t9!=null?+(+t9).toFixed(1):null, ramp, cloud, wdir: lw?lw.dir:null, wspd: lw?(lw.spd??null):null, doy };
  }catch(e){ return null; }
}
function journalMemory(){
  let j; try{ j = journalLoad(); }catch(e){ return null; }
  const today = featSnapshot();
  const rows = [];
  for(const k in j){
    const e = j[k];
    if(!e || e.actualX==null || !e.lock || e.lock.high==null) continue;
    const err = e.actualX - e.lock.high;              // + means the call ran COLD (actual came in higher)
    if(!isFinite(err) || Math.abs(err) > 6) continue; // skip corrupted entries
    let w = 0.4;                                      // baseline: every graded day informs the global bias
    if(e.feat && today && e.feat.t9!=null && today.t9!=null){
      let d = 0;
      d += Math.abs(e.feat.t9 - today.t9) * 0.5;
      if(e.feat.ramp!=null && today.ramp!=null) d += Math.abs(e.feat.ramp - today.ramp) * 0.8;
      if(e.feat.cloud!=null && today.cloud!=null) d += Math.abs(e.feat.cloud - today.cloud) / 25;
      if(e.feat.doy!=null && today.doy!=null){ let dd = Math.abs(e.feat.doy - today.doy); dd = Math.min(dd, 365-dd); d += Math.min(3, dd/20); }
      w = 1.6 / (1 + d);                              // similar mornings weigh more
    }
    rows.push({ err, w });
  }
  if(!rows.length) return null;
  const W = rows.reduce((a,r)=>a+r.w,0);
  if(!(W>0)) return null;
  const mean = rows.reduce((a,r)=>a+r.err*r.w,0) / W;
  const n = rows.length;
  let adj = mean * (n/(n+6));                          // shrink hard while the sample is small
  adj = Math.max(-0.8, Math.min(0.8, adj));            // never move the high more than 0.8 deg
  return { adj:+adj.toFixed(2), n, mean:+mean.toFixed(2) };
}
function journalTick(bucket, high){
  const now = jstParts().dec; const j = journalLoad(); const k = todayISO();
  let dirty = false;
  // record every change of the verdict bucket through the active day (05–16 JST)
  if(now>=5 && now<=16 && bucket!=null){
    j[k] = j[k]||{};
    const c = j[k].calls || [];
    if(!c.length || c[c.length-1].b !== bucket){
      c.push({t:+now.toFixed(2), b:bucket});
      if(c.length>60) c.shift();
      j[k].calls = c; dirty = true;
    }
  }
  // snapshot this morning's fingerprint once (fuel for the journal-memory matcher)
  if(now>=9.2 && now<=16){
    j[k] = j[k]||{};
    if(!j[k].feat){ const f = featSnapshot(); if(f && f.t9!=null){ j[k].feat = f; dirty = true; } }
  }
  if(now>=10.25 && now<=13 && !(j[k] && j[k].lock)){
    j[k] = j[k]||{}; j[k].lock = {t:+now.toFixed(2), bucket, high:+(high??0).toFixed(1)};
    dirty = true;
  }
  const yk = yesterdayISO();
  if(S.ydayObsMax!=null && j[yk] && j[yk].lock && j[yk].actual==null){
    j[yk].actual = Math.round(S.ydayObsMax); j[yk].actualX = S.ydayObsMax;
    // when did the verdict FIRST lock onto the correct bucket and stay there?
    const c = j[yk].calls || [];
    let callT = null;
    if(c.length && c[c.length-1].b === j[yk].actual){
      let i = c.length-1;
      while(i>0 && c[i-1].b === j[yk].actual) i--;
      callT = c[i].t;
    }
    j[yk].callT = callT;   // null = never stably correct that day
    dirty = true;
  }
  if(dirty) journalSave(j);
  return j;
}
function journalStats(j){
  const rows = Object.entries(j).filter(([,v])=>v.lock && v.actual!=null)
                 .sort((a,b)=> a[0]<b[0]?1:-1).slice(0,30);
  if(!rows.length) return null;
  let hit=0, mae=0;
  const callTs = [];
  for(const [,v] of rows){
    if(v.lock.bucket===v.actual) hit++;
    mae += Math.abs(v.lock.high-(v.actualX??v.actual));
    if(v.callT!=null) callTs.push(v.callT);
  }
  callTs.sort((a,b)=>a-b);
  const medCall = callTs.length ? callTs[Math.floor(callTs.length/2)] : null;
  return {n:rows.length, hit, mae:mae/rows.length, medCall, callN:callTs.length};
}

/* ================= morning evidence: should the warm pace be trusted? ================= */
// When models run cold overnight, the lift only carries to the afternoon max if the
// warmth is real advected heat. Capping evidence (cloud deck, low sun, heavy forecast
// cloud, flow already onshore) means it was likely a cloud blanket — discount it.
function morningEvidence(){
  const now = jstParts().dec;
  const E = {trustWarm:1, reasons:[], capScore:0, mixBreak:false, advect:false};
  if(now < 5.5 || now > 14) return E;
  let cap = 0;
  const su = S.suns || [];
  if(now >= 7.5 && su.length){
    const last = su[su.length-1];
    const rec = su.filter(x => x.t > last.t - 1);
    const frac = rec.length ? rec.reduce((a,b)=>a+b.v,0)/(rec.length*10) : null;
    if(frac!=null){
      if(frac < 0.4){ cap++; E.reasons.push(`sun only ${Math.round(frac*100)}% last hr`); }
      else if(frac > 0.75){ cap--; E.reasons.push(`near-full sun`); }
    }
  }
  const raw = (S.metars && S.metars[0] && S.metars[0].raw) || "";
  if(/(BKN|OVC)0[0-7]\d/.test(raw)){ cap++; E.reasons.push("broken/overcast deck on METAR"); }
  if(S.cloud){
    const nowH = Math.floor(now);
    const rest = S.cloud.slice(nowH, 15).filter(v=>v!=null);
    if(rest.length){
      const avg = rest.reduce((a,b)=>a+b,0)/rest.length;
      if(avg >= 65){ cap++; E.reasons.push(`forecast cloud ${Math.round(avg)}%`); }
    }
  }
  // ===== WIND-SPEED DISCRIMINATOR (today's-miss fix) =====
  // Onshore/SSW flow is only a CAP when it's gentle (a true sea breeze).
  // A STRONG onshore/SSW wind (>=6 m/s) is warm advection + downward mixing -> it HEATS.
  const w = S.winds || [];
  const lastw = w[w.length-1];
  const spd = lastw ? (lastw.spd ?? 0) : 0;
  const onsh = lastw && lastw.dir!=null && lastw.dir!==0 && ONSHORE.has(lastw.dir);
  if(now < 11 && onsh){
    if(spd >= 6){
      // strong onshore/SSW = mixing/advection, NOT a cap. Cancel a cap point and flag advection.
      cap--; E.advect=true;
      E.reasons.push(`strong onshore flow ${fmt1(spd)} m/s — warm advection/mixing, not a sea-breeze cap`);
    } else if(spd >= 2){
      cap++; E.reasons.push(`light onshore flow ${fmt1(spd)} m/s — gentle sea breeze, capping`);
    }
  }
  // ===== MIXING-BREAK DETECTOR =====
  // A capped-flat morning that suddenly ramps (>=1.5°C in ~30 min) with rising wind is a
  // regime change: the cap broke. Un-discount HARD — the warm models are back in play.
  {
    const o = S.obs || [];
    if(o.length >= 4){
      const tNow = o[o.length-1];
      // temp ~30 min ago
      let prev=null; for(let i=o.length-2;i>=0;i--){ if(tNow.t - o[i].t >= 0.45){ prev=o[i]; break; } }
      if(prev){
        const dT = tNow.v - prev.v;
        // wind trend: is speed rising?
        let wRise=false;
        if(w.length>=3){ const wn=w[w.length-1].spd??0, wp=w[Math.max(0,w.length-4)].spd??0; wRise = (wn - wp) >= 1.5; }
        if(dT >= 1.5 && (wRise || spd >= 6)){
          E.mixBreak = true;
          E.reasons.push(`⚡ MIXING BREAK: +${fmt1(dT)}° in 30 min with ${wRise?"rising":"strong"} wind — morning cap broke, fast warm-up underway`);
        }
      }
    }
  }
  E.capScore = cap;
  // resolve trust: a mixing break or strong advection overrides the cap and BOOSTS the warm models
  if(E.mixBreak){ E.trustWarm = 1.25; }      // trust warm models MORE than baseline
  else if(E.advect && cap <= 0){ E.trustWarm = 1.1; }
  else if(cap >= 2) E.trustWarm = 0.35;
  else if(cap === 1) E.trustWarm = 0.65;
  else E.trustWarm = 1;
  return E;
}

/* ================= strategist read ================= */
function computeStrategy(nc, loc){
  const G = {follow:"—", followNote:"needs model + observation data", discard:"—", discardNote:"—", watch:"—", watchNote:"—"};
  const entries = Object.entries(nc.perModel || {});
  if(!entries.length) return G;
  const now = jstParts().dec;
  const nameOf = k => (MODELS.find(m=>m.key===k)||{}).name || k;
  const early = S.obs.length < 6;   // pace not yet meaningful pre-dawn

  // split: pace-clean vs pace-broken
  const PACE_LIM = 1.2;
  const clean = [], broken = [];
  for(const [k,pm] of entries){
    if(pm.bias!=null && Math.abs(pm.bias) >= PACE_LIM && !early) broken.push([k,pm]);
    else clean.push([k,pm]);
  }
  // cluster stats over clean models
  const highs = clean.map(([,pm])=>pm.projHigh).sort((a,b)=>a-b);
  const med = highs.length ? (highs.length%2 ? highs[(highs.length-1)/2] : (highs[highs.length/2-1]+highs[highs.length/2])/2) : null;
  // outliers among clean
  const OUT_LIM = 1.5;
  const outliers = med!=null ? clean.filter(([,pm])=>Math.abs(pm.projHigh-med) >= OUT_LIM) : [];
  const core = clean.filter(([,pm])=>med==null || Math.abs(pm.projHigh-med) < OUT_LIM);

  // FOLLOW: best non-outlier clean model — low |pace|, good skill, JMA home-model tiebreak
  if(early){
    const rk1 = entries.find(([k])=> nc.skill && nc.skill.ranks && nc.skill.ranks[k]===1);
    G.follow = rk1 ? nameOf(rk1[0]) : nameOf(entries[0][0]);
    const ek = rk1 ? rk1[0] : entries[0][0];
    G.followKey = ek; G.followHigh = (nc.perModel[ek]||{}).projHigh ?? null;
    G.followNote = "pre-dawn: pace isn’t meaningful yet — lean on the skill rank and the official forecasts until the 09–13 JST heating ramp";
  } else if(core.length){
    let best=null, bestS=1e9;
    for(const [k,pm] of core){
      const sk = (nc.skill && nc.skill.scores && nc.skill.scores[k]!=null) ? nc.skill.scores[k] : 0.7;
      let sc = Math.abs(pm.bias??0) + 0.8*sk - (k==="jma_seamless"?0.08:0);
      if(sc<bestS){bestS=sc; best=[k,pm];}
    }
    G.follow = nameOf(best[0]);
    const rk = nc.skill && nc.skill.ranks ? nc.skill.ranks[best[0]] : null;
    G.followKey = best[0]; G.followHigh = best[1].projHigh;
    G.followNote = `pace ${(best[1].bias>=0?"+":"")}${fmt1(best[1].bias)}°${rk?`, rank #${rk}`:""} — tracking reality and verified; implies the ${Math.round(best[1].projHigh)}° bucket; cluster of ${core.length} clean models reads ${fmt1(Math.min(...core.map(([,p])=>p.projHigh)))}–${fmt1(Math.max(...core.map(([,p])=>p.projHigh)))}°C`;
  }

  // DISCARD
  if(broken.length){
    G.discard = broken.map(([k])=>nameOf(k)).join(" + ");
    G.discardNote = `running ${broken.map(([,pm])=>(pm.bias>=0?"+":"")+fmt1(pm.bias)+"°").join(", ")} off reality — airmass/cloud wrong; their corrected highs are mostly correction, not forecast`;
  } else if(!early){
    G.discard = "NONE"; G.discardNote = "every model is tracking within ±" + PACE_LIM.toFixed(1) + "° — unusually clean board";
  } else { G.discard = "—"; G.discardNote = "judged after enough observations accumulate"; }

  // OUTLIER WATCH
  if(outliers.length && med!=null){
    const [ok_, opm] = outliers.reduce((a,b)=>Math.abs(b[1].projHigh-med)>Math.abs(a[1].projHigh-med)?b:a);
    const dirHot = opm.projHigh > med;
    const bits = [];
    bits.push(`says ${fmt1(opm.projHigh)}° vs cluster ~${fmt1(med)}°`);
    if(S.jmaFx && dirHot && S.jmaFx.max >= med + 0.7) bits.push(`JMA official ${S.jmaFx.max}° leans its way — fat ${dirHot?"right":"left"} tail`);
    if(S.t850){
      const ceil = S.t850.mean + 12;
      bits.push(dirHot ? (opm.projHigh <= ceil + 0.3 ? `T850 ceiling ~${fmt1(ceil)}° permits it` : `T850 ceiling ~${fmt1(ceil)}° does NOT support it`) : `check T850 floor`);
    }
    if(now < 9) bits.push("verdict comes on the 09–13 JST ramp: if its pace holds ~0 while the climb runs hot, it’s live");
    else if(now <= 13) bits.push("ramp is NOW — watch its pace in real time");
    else bits.push("ramp has passed — the observed trace has already voted");
    if(dirHot && loc && loc.seaIn) bits.push("KILL: sea breeze is already in — the hot scenario is dead");
    else if(dirHot) bits.push("kill switch: sea-breeze IN before ~12:30");
    G.watch = nameOf(ok_);
    G.watchNote = bits.join(" · ");
  } else {
    G.watch = "NONE";
    G.watchNote = med!=null ? "no clean model sits ±1.5° off the cluster — distribution is honest, trade the buckets" : "—";
  }
  return G;
}

/* ================= math ================= */
// standard normal CDF via Abramowitz–Stegun erf approximation
function phi(x){
  const t = 1/(1+0.3275911*Math.abs(x)/Math.SQRT2);
  const e = 1 - (((((1.061405429*t - 1.453152027)*t) + 1.421413741)*t - 0.284496736)*t + 0.254829592)*t * Math.exp(-(x*x)/2);
  return x>=0 ? 0.5*(1+e) : 0.5*(1-e);
}
function computeBuckets(nc){
  if(nc.high==null) return null;
  const now = jstParts().dec;
  // spread: model disagreement + remaining time-to-peak uncertainty, floored
  const highs = Object.values(nc.perModel).map(p=>p.projHigh);
  const mean = nc.high;   // already includes the analog vote (folded in at computeNowcast)
  const varM = highs.length>1 ? highs.reduce((a,v)=>a+(v-mean)**2,0)/(highs.length-1) : 0.25;
  const analogUsed = nc.analogUsed ?? null;
  const hoursToPeak = Math.max(0, (nc.peakT!=null ? nc.peakT : 14) - now);
  let sigma = Math.max(0.35, Math.sqrt(varM + (0.25*hoursToPeak/3)**2));
  if(nc.peakSet){
    // high already set: residual risk is only rounding edges, missed METAR prints,
    // and rare late-day warm advection — shrink with hours since the peak
    const since = Math.max(0, now - (nc.peakT ?? 14));
    sigma = Math.max(0.15, Math.min(sigma, 0.32 - 0.04*since));
  }
  const floorK = (S.metarMax!=null) ? Math.round(S.metarMax) : null;
  const lo = Math.floor(mean - 3.5*sigma), hi = Math.ceil(mean + 3.5*sigma);
  const ks = [], ps = [];
  for(let k=lo; k<=hi; k++){
    ks.push(k);
    ps.push(phi((k+0.5-mean)/sigma) - phi((k-0.5-mean)/sigma));
  }
  // settlement can't print below the METAR max already recorded:
  // collapse all mass below floorK into the floor bucket
  if(floorK!=null){
    let below = 0;
    for(let i=0;i<ks.length;i++){ if(ks[i]<floorK){ below += ps[i]; ps[i]=0; } }
    const fi = ks.indexOf(floorK);
    if(fi>=0) ps[fi] += below; else { ks.unshift(floorK); ps.unshift(below); }
  }
  const total = ps.reduce((a,b)=>a+b,0) || 1;
  const out = ks.map((k,i)=>({k, p: ps[i]/total})).filter(b=>b.p>=0.01);
  out.sort((a,b)=>a.k-b.k);
  return {buckets: out, sigma, floorK, analogUsed, center: mean};
}
function interpHour(series, x){
  const lo = Math.floor(x), hi = Math.min(lo+1,23);
  const a = series[lo], b = series[hi];
  if(a==null && b==null) return null;
  if(a==null) return b; if(b==null) return a;
  return a + (b-a)*(x-lo);
}
/* ===== solar & thermal cycle: pure geometry + archive peak-timing climatology ===== */
const _r=d=>d*Math.PI/180, _g=r=>r*180/Math.PI;
function solarDay(ms){
  const d=new Date(ms);
  const doy=Math.floor((Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())-Date.UTC(d.getUTCFullYear(),0,0))/864e5);
  const g=2*Math.PI/365*(doy-1+0.5);
  const eq=229.18*(0.000075+0.001868*Math.cos(g)-0.032077*Math.sin(g)-0.014615*Math.cos(2*g)-0.040849*Math.sin(2*g));
  const decl=0.006918-0.399912*Math.cos(g)+0.070257*Math.sin(g)-0.006758*Math.cos(2*g)+0.000907*Math.sin(2*g)-0.002697*Math.cos(3*g)+0.00148*Math.sin(3*g);
  const phi=_r(LAT);
  function haFor(zen){ const c=Math.cos(_r(zen))/(Math.cos(phi)*Math.cos(decl))-Math.tan(phi)*Math.tan(decl); return (c<-1||c>1)?null:_g(Math.acos(c)); }
  const ha0=haFor(90.833), ha6=haFor(96);
  const toJ=um=>um+540;
  const noon=toJ(720-4*LON-eq);
  const out={eq, decl, noonMin:noon, maxElev:90-Math.abs(LAT-_g(decl)),
    riseMin:ha0!=null?toJ(720-4*(LON+ha0)-eq):null, setMin:ha0!=null?toJ(720-4*(LON-ha0)-eq):null,
    dawnMin:ha6!=null?toJ(720-4*(LON+ha6)-eq):null, duskMin:ha6!=null?toJ(720-4*(LON-ha6)-eq):null};
  out.dayLen=(out.riseMin!=null&&out.setMin!=null)?out.setMin-out.riseMin:0;
  return out;
}
function solarElev(sd, jstMin){
  const tst=jstMin+sd.eq+4*LON-540;
  const ha=_r(tst/4-180);
  const phi=_r(LAT);
  const cz=Math.sin(phi)*Math.sin(sd.decl)+Math.cos(phi)*Math.cos(sd.decl)*Math.cos(ha);
  return 90-_g(Math.acos(Math.max(-1,Math.min(1,cz))));
}
function peakClimo(){
  const days=(S.archive&&S.archive.days)?S.archive.days.slice(-30):[];
  function stats(a){
    if(a.length<10) return null;
    const st=[...a].sort((x,y)=>x-y), q=p=>st[Math.min(st.length-1,Math.round(p*(st.length-1)))];
    const hist={}; a.forEach(h=>{hist[h]=(hist[h]||0)+1;});
    return {p25:q(.25), med:q(.5), p75:q(.75), hist, n:a.length};
  }
  const hiDays={}, loDays={};
  days.forEach(d=>{
    if(d.hiH!=null) (hiDays[d.hiH]=hiDays[d.hiH]||[]).push(d);
    if(d.loH!=null) (loDays[d.loH]=loDays[d.loH]||[]).push(d);
  });
  return { hi:stats(days.map(d=>d.hiH).filter(h=>h!=null)),
           lo:stats(days.map(d=>d.loH).filter(h=>h!=null)),
           hiDays, loDays,
           recent:days.slice(-5).filter(d=>d.date&&d.lo!=null) };
}
function _hm(min){ min=((min%1440)+1440)%1440; let h=Math.floor(min/60), m=Math.round(min%60); if(m===60){h=(h+1)%24;m=0;} return `${h}:${p2(m)}`; }
function _dur(min){ return `${Math.floor(min/60)}h ${p2(Math.round(min%60))}m`; }
const WDAYS=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
function pinTipHTML(kind, h){
  const cl=peakClimo(); if(!cl) return "";
  const list=((kind==="hi"?cl.hiDays:cl.loDays)||{})[h]||[];
  if(!list.length) return "";
  const rows=list.slice().reverse().slice(0,10).map(d=>{
    const wd=WDAYS[new Date(d.date+"T00:00:00Z").getUTCDay()];
    const v=kind==="hi"?d.hi:d.lo;
    return `${wd} ${d.date} · ${kind==="hi"?"high":"low"} ${fmt1(v)}° during ${p2(h)}:00`;
  });
  if(list.length>10) rows.push(`… +${list.length-10} more`);
  return rows.join("<br>")+`<div style="margin-top:5px;opacity:.65">hourly reanalysis · tap elsewhere to close</div>`;
}
function renderSolar(nc){
  const svg=document.getElementById("sol-arc"); if(!svg) return;
  const sd=solarDay(Date.now()), sy=solarDay(Date.now()-864e5);
  const nowMin=jstParts().dec*60;
  const cl=peakClimo();
  const X=t=>t/1440*1000, HY=150, K=(HY-20)/90;
  const Y=e=>HY-Math.max(e,-12)*K;
  let pts=[];
  for(let m=0;m<=1440;m+=10) pts.push(`${X(m).toFixed(1)},${Y(solarElev(sd,m)).toFixed(1)}`);
  let g=`<line x1="0" y1="${HY}" x2="1000" y2="${HY}" stroke="rgba(128,140,160,.35)"/><text x="994" y="${HY-6}" font-size="11" fill="var(--ink-soft)" text-anchor="end" font-family="var(--mono)">horizon</text>`;
  // typical bands from climatology
  if(cl.hi){ g+=`<rect x="${X(cl.hi.p25*60)}" y="20" width="${X((cl.hi.p75+1)*60)-X(cl.hi.p25*60)}" height="${HY-20}" fill="rgba(231,181,60,.10)"/>
    <line x1="${X((cl.hi.med+0.5)*60)}" y1="20" x2="${X((cl.hi.med+0.5)*60)}" y2="${HY}" stroke="rgba(231,181,60,.8)" stroke-dasharray="5 4" stroke-width="1.6"/>
    <text x="${X((cl.hi.med+0.5)*60)}" y="14" font-size="11" fill="rgba(231,181,60,.95)" text-anchor="middle" font-family="var(--mono)">typical high</text>`;
    for(const[h,n] of Object.entries(cl.hi.hist)){ if(n<2) continue; const cx=X((+h+0.5)*60);
      g+=`<g class="pin" data-kind="hi" data-h="${h}" style="cursor:pointer"><circle cx="${cx}" cy="30" r="15" fill="rgba(0,0,0,0)" pointer-events="all"/><line x1="${cx}" y1="34" x2="${cx}" y2="46" stroke="rgba(231,181,60,.7)"/><circle cx="${cx}" cy="28" r="8" fill="rgba(231,181,60,.9)"/><text x="${cx}" y="31.5" font-size="10" font-weight="700" fill="#1a1206" text-anchor="middle" font-family="var(--mono)">${n}</text></g>`; } }
  if(cl.lo){ g+=`<line x1="${X((cl.lo.med+0.5)*60)}" y1="${HY}" x2="${X((cl.lo.med+0.5)*60)}" y2="196" stroke="rgba(110,168,254,.7)" stroke-dasharray="5 4"/><text x="${X((cl.lo.med+0.5)*60)}" y="208" font-size="11" fill="rgba(110,168,254,.95)" text-anchor="middle" font-family="var(--mono)">typical low</text>`;
    for(const[h,n] of Object.entries(cl.lo.hist)){ if(n<2) continue; const cx=X((+h+0.5)*60);
      g+=`<g class="pin" data-kind="lo" data-h="${h}" style="cursor:pointer"><circle cx="${cx}" cy="${HY+22}" r="15" fill="rgba(0,0,0,0)" pointer-events="all"/><line x1="${cx}" y1="${HY+8}" x2="${cx}" y2="${HY+18}" stroke="rgba(110,168,254,.7)"/><circle cx="${cx}" cy="${HY+24}" r="8" fill="rgba(110,168,254,.9)"/><text x="${cx}" y="${HY+27.5}" font-size="10" font-weight="700" fill="#0d1016" text-anchor="middle" font-family="var(--mono)">${n}</text></g>`; } }
  // sun path + markers
  g+=`<polyline fill="none" stroke="var(--jma)" stroke-width="2.6" points="${pts.join(" ")}" opacity=".95"/>`;
  const mk=(m,lab)=>{ if(m==null) return ""; return `<line x1="${X(m)}" y1="20" x2="${X(m)}" y2="${HY}" stroke="rgba(128,140,160,.3)" stroke-dasharray="3 4"/><text x="${X(m)}" y="${HY+16}" font-size="11.5" fill="var(--ink)" text-anchor="middle" font-family="var(--mono)" font-weight="600">${lab} ${_hm(m)}</text>`; };
  g+=mk(sd.riseMin,"↑")+mk(sd.noonMin,"☉")+mk(sd.setMin,"↓");
  const eNow=solarElev(sd,nowMin);
  g+=`<line x1="${X(nowMin)}" y1="8" x2="${X(nowMin)}" y2="196" stroke="rgba(226,232,240,.5)"/><circle cx="${X(nowMin)}" cy="${Y(eNow)}" r="6" fill="var(--accent)"/><text x="${X(nowMin)}" y="${Math.max(12,Y(eNow)-12)}" font-size="12" font-weight="700" fill="var(--accent)" text-anchor="middle" font-family="var(--mono)">NOW</text>`;
  for(let h=0;h<=24;h+=3){
    const anch = h===0 ? "start" : h===24 ? "end" : "middle";
    const xx = h===0 ? 4 : h===24 ? 996 : X(h*60);
    g+=`<text x="${xx}" y="213" font-size="10" fill="var(--ink-soft)" text-anchor="${anch}" font-family="var(--mono)">${h===0||h===24?"12a":h<12?h+"a":h===12?"12p":(h-12)+"p"}</text>`;
  }
  svg.innerHTML=g;
  if(!svg._pinsWired){
    svg._pinsWired=true;
    svg.addEventListener("click",(e)=>{
      const tip=document.getElementById("sol-tip"); if(!tip) return;
      const pin=(e.target&&e.target.closest)?e.target.closest("g.pin"):null;
      if(!pin){ tip.style.display="none"; return; }
      const html=pinTipHTML(pin.getAttribute("data-kind"), +pin.getAttribute("data-h"));
      if(!html){ tip.style.display="none"; return; }
      tip.innerHTML=html;
      const host=svg.parentElement, r=host.getBoundingClientRect();
      tip.style.display="block";
      let x=e.clientX-r.left+12, y=e.clientY-r.top+12;
      const tw=tip.offsetWidth||280, th=tip.offsetHeight||80;
      if(x+tw>r.width-6) x=Math.max(6, r.width-tw-6);
      if(y+th>r.height-6) y=Math.max(6, (e.clientY-r.top)-th-12);
      tip.style.left=x+"px"; tip.style.top=y+"px";
      e.stopPropagation();
    });
    document.addEventListener("click",(e)=>{
      const tip=document.getElementById("sol-tip");
      if(tip && !(e.target&&e.target.closest&&e.target.closest("#sol-arc"))) tip.style.display="none";
    });
  }
  // status
  const stEl=document.getElementById("sol-status");
  if(stEl){
    let st="";
    if(nowMin<sd.dawnMin||nowMin>sd.duskMin) st="night — radiative cooling only";
    else if(nowMin<sd.riseMin) st="first light — cooling ending";
    else if(cl.hi && nowMin>=cl.hi.p25*60 && nowMin<(cl.hi.p75+1)*60) st="⚑ PEAK WINDOW — highs usually print now";
    else if(cl.hi && nowMin>=(cl.hi.p75+1)*60 && nowMin<=sd.setMin) st="↘ afternoon cooling — net loss exceeds incoming sun";
    else if(nowMin<=sd.noonMin) st="heating phase — sun input exceeds losses";
    else st="past solar noon — heating momentum fading";
    stEl.textContent=st;
  }
  // stats grid
  const grid=document.getElementById("sol-stats");
  if(grid){
    const dLeft=Math.max(0,(sd.setMin||nowMin)-nowMin);
    const frac=(sd.riseMin!=null&&sd.setMin!=null)?Math.round(100*Math.min(1,Math.max(0,(nowMin-sd.riseMin)/(sd.setMin-sd.riseMin)))):0;
    const dd=Math.round((sd.dayLen-sy.dayLen)*60);
    const strength=eNow<=0?0:Math.round(100*Math.sin(_r(eNow))/Math.sin(_r(sd.maxElev)));
    const cell=(l,v,s)=>`<div><div class="label">${l}</div><div class="mid">${v}</div><div class="sub">${s||""}</div></div>`;
    grid.innerHTML=
      cell("Sunrise",_hm(sd.riseMin),"dawn "+_hm(sd.dawnMin))+
      cell("Sunset",_hm(sd.setMin),"dusk "+_hm(sd.duskMin))+
      cell("Solar noon",_hm(sd.noonMin),`max sun ${Math.round(sd.maxElev)}°`)+
      cell("Day length",_dur(sd.dayLen),(dd>=0?"+":"−")+Math.abs(dd)+"s vs yesterday")+
      cell("Daylight left",_dur(dLeft),`${frac}% of daylight elapsed`)+
      cell("Sun strength",strength+"%","of today's peak · geometry only")+
      cell("Typical high",cl.hi?`${_hm(cl.hi.p25*60)}–${_hm((cl.hi.p75+1)*60)}`:"building history",cl.hi?`median ${_hm((cl.hi.med+0.5)*60)} · ${cl.hi.n}d`:"needs archive")+
      cell("Typical low",cl.lo?`${_hm(cl.lo.p25*60)}–${_hm((cl.lo.p75+1)*60)}`:"building history",cl.lo?`median ${_hm((cl.lo.med+0.5)*60)} · ${cl.lo.n}d`:"needs archive");
    const rec=document.getElementById("sol-recent");
    if(rec && cl.recent && cl.recent.length){
      const wd=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
      rec.textContent="recent: "+cl.recent.map(d=>`${wd[new Date(d.date+"T00:00:00Z").getUTCDay()]} ${fmt1(d.hi)}°/${fmt1(d.lo)}°`).join(" · ")+" (reanalysis)";
    }
  }
}
/* ===== jump alerts: browser notification when the watch fires/escalates ===== */
function notifyJump(j){
  try{
    const lvl = j ? j.level : 0;
    const prev = window.__jl || 0;
    window.__jl = lvl;
    if(lvl <= prev) return;                              // ping only on escalation
    if(!("Notification" in window) || Notification.permission!=="granted") return;
    const body = lvl===2
      ? `TEMP JUMPING: +${fmt1(j.d10)}° in 10 min — break underway`
      : (j.sw && !j.windUp)
        ? "Southerly switch inbound — bay sentinels flipped south; spike likely at Haneda"
        : "Jump watch: south wind rising with model upside left";
    new Notification("RJTT nowcaster ⚡", { body, tag:"rjtt-jump" });
  }catch(e){}
}
function wireAlerts(){
  try{
    const b=document.getElementById("btn-alerts"); if(!b) return;
    const paint=()=>{ b.textContent = ("Notification" in window)
      ? (Notification.permission==="granted" ? "on ✓" : Notification.permission==="denied" ? "blocked" : "enable")
      : "n/a"; };
    paint();
    b.addEventListener("click", async ()=>{
      try{ if("Notification" in window && Notification.permission!=="granted") await Notification.requestPermission(); }catch(e){}
      paint();
      if(("Notification" in window) && Notification.permission==="granted")
        try{ new Notification("RJTT nowcaster", {body:"Alerts armed — you'll get a ping when the jump watch fires.", tag:"rjtt-jump"}); }catch(e){}
    });
  }catch(e){}
}
wireAlerts();
/* ===== jump watch: early warning that the temperature is about to break upward =====
   The July-1 pattern: obs plateau BELOW what the warmest credible model still expects,
   heating hours remain, and the south-sector wind is trending up (mixing strengthening).
   Two triggers: (a) wind trend = watch BEFORE the jump; (b) first accelerated 10-min
   tick = break underway. Effect is deliberately modest: a small warm premium on the
   high (never past the warmest model) plus a transparent note - a warning light, not
   a call flip. */
function jumpRisk(obsMax, hiModel){
  try{
    const now = jstParts().dec;
    if(now < 10.5 || now > 14.75) return null;           // only while heating time remains
    const o = S.obs||[];
    if(o.length < 4 || obsMax==null || hiModel==null || !isFinite(hiModel)) return null;
    const headroom = hiModel - obsMax;
    // (b) acceleration: the last tick(s) already jumped — self-evident, no headroom needed
    let accel=false, d10=0;
    if(o.length>=2){
      d10 = o[o.length-1].v - o[o.length-2].v;
      const d20 = o.length>=3 ? (o[o.length-1].v - o[o.length-3].v) : 0;
      if(d10>=0.5 || d20>=0.7) accel=true;
    }
    if(accel) return { level:2, headroom:+Math.max(0,headroom).toFixed(1), d10:+d10.toFixed(1), windUp:false, accel:true };
    // (a) anticipatory wind-trend watch: needs real model upside left to matter
    if(headroom < 0.6) return null;
    let windUp=false;
    const w=(S.winds||[]).filter(x=>x&&x.spd!=null);
    if(w.length>=3){
      const cur=w[w.length-1];
      const past=w.filter(x=>x.t<=cur.t-0.5);
      const ref=past.length?past[past.length-1]:null;
      const sSector = cur.dir!=null && cur.dir>=6 && cur.dir<=11;
      if(ref && sSector && cur.spd>=3 && (cur.spd-ref.spd)>=0.5) windUp=true;
    }
    // (c) southerly switch inbound: bay sentinels already flipped south (warm air behind)
    // while Haneda hasn't — the front is crossing the bay toward the field.
    let switchIn=false;
    try{
      const curW = w.length ? w[w.length-1] : null;
      const hanedaSouth = curW && curW.dir!=null && curW.dir>=6 && curW.dir<=11 && (curW.spd||0)>=3;
      if(!hanedaSouth){
        let flipped=0, warmLead=false;
        for(const id in (S.neighbors||{})){
          const n=S.neighbors[id];
          if(n && n.dir!=null && n.dir>=6 && n.dir<=11 && n.spd!=null && n.spd>=3){
            flipped++;
            if(S.cur!=null && n.temp!=null && (n.temp - S.cur) >= 0.5) warmLead=true;
          }
        }
        if((flipped>=1 && warmLead) || flipped>=2) switchIn=true;
      }
    }catch(e){}
    if(!windUp && !switchIn) return null;
    return { level:1, headroom:+headroom.toFixed(1), d10:+d10.toFixed(1), windUp, sw:switchIn, accel:false };
  }catch(e){ return null; }
}
function computeNowcast(){
  const now = jstParts().dec;
  const out = {perModel:{}, blendCurve:null, high:null, lo:null, hi:null, peakT:null, peakSet:false};
  const evid = morningEvidence();
  out.evid = evid;
  const curves = [];
  for(const m of MODELS){
    const T = S.models[m.key]; if(!T) continue;
    const modelNow = interpHour(T, Math.min(now,23.99));
    // PACE: recency-weighted mean of (obs - model) over the last 3 h,
    // i.e. how warm/cold reality is running vs this model's curve.
    let bias = null;
    if(modelNow!=null && S.obs.length){
      let wsum=0, esum=0;
      for(const p of S.obs){
        if(p.t < now-3 || p.t > now+0.01) continue;
        const mv = interpHour(T, Math.min(p.t,23.99));
        if(mv==null) continue;
        const w = Math.exp((p.t-now)/1.5);   // half-life ~1 h
        esum += w*(p.v - mv); wsum += w;
      }
      if(wsum>0) bias = esum/wsum;
    }
    if(bias==null && S.cur!=null && modelNow!=null) bias = S.cur - modelNow;
    if(bias==null) bias = 0;
    const corr = T.map((v,h)=>{
      if(v==null) return null;
      if(h < now-1) return v;
      const w = Math.exp(-Math.max(0,h-now)/BIAS_DECAY_H);
      // normal: scale only the warm (positive) correction by trust.
      // mixing break: the surface is jumping faster than pace can track, so amplify the
      // correction in BOTH directions to let obs pull the projection up quickly.
      const tw = evid.trustWarm;
      const scale = evid.mixBreak ? Math.max(1, tw) : (bias>0 ? tw : 1);
      return v + bias*w*scale;
    });
    let rem = -1e9, remT = null;
    for(let h=Math.floor(now); h<24; h++){
      if(corr[h]!=null && corr[h]>rem){ rem=corr[h]; remT=h; }
    }
    const base = (S.obsMax!=null) ? S.obsMax : -1e9;
    const projHigh = Math.max(base, rem);
    out.perModel[m.key] = {
      rawMax: Math.max(...T.filter(v=>v!=null)),
      modelNow, bias: (modelNow!=null && (S.cur!=null || S.obs.length))? bias : null,
      corr, projHigh, remT
    };
    curves.push({key:m.key, corr});
  }
  if(!curves.length) return out;
  // skill-weighted blend: better-verified models count more (equal weights if no skill data yet)
  const skill = computeSkill();
  out.skill = skill;
  const wOf = (key) => skill.have && skill.scores[key]!=null ? 1/(0.35 + skill.scores[key]) : 1;
  out.blendCurve = Array.from({length:24},(_,h)=>{
    let ws=0, vs=0, any=false;
    for(const c of curves){
      const v = c.corr[h]; if(v==null) continue;
      const w = wOf(c.key); ws += w; vs += w*v; any=true;
    }
    return any ? vs/ws : null;
  });
  let wsum=0, hsum=0;
  for(const [k,pm] of Object.entries(out.perModel)){ const w=wOf(k); wsum+=w; hsum+=w*pm.projHigh; }
  out.high = hsum/wsum;
  // analog-day vote folded into the headline high so the displayed number and the
  // settlement buckets use the SAME value (no silent divergence between them).
  if(S.analog && S.analog.n>=8 && S.analog.high!=null && isFinite(S.analog.high)){
    out.high = 0.75*out.high + 0.25*S.analog.high;
    out.analogUsed = S.analog.high;
  }
  // the projected high can never be below what's already been observed
  if(S.obsMax!=null && out.high < S.obsMax) out.high = S.obsMax;
  // JOURNAL MEMORY: if this dashboard's own graded calls ran warm/cold on mornings
  // like this one, nudge today's high (shrunk + capped). Applied HERE so the
  // headline, buckets and settlement call all share the same corrected number.
  try{
    const mem = journalMemory();
    if(mem && Math.abs(mem.adj) >= 0.05){
      out.high += mem.adj;
      out.memAdj = mem.adj; out.memN = mem.n; out.memMean = mem.mean;
      if(S.obsMax!=null && out.high < S.obsMax) out.high = S.obsMax;
    }
  }catch(e){}
  const highs = Object.values(out.perModel).map(p=>p.projHigh);
  out.lo = Math.min(...highs); out.hi = Math.max(...highs);
  // JUMP WATCH: small warm premium while an upward break is threatening (capped at the warmest model)
  const jr = jumpRisk(S.obsMax, out.hi);
  if(jr){
    out.jump = jr;
    const bump = jr.level===2 ? 0.3 : 0.15;
    out.high = Math.max(out.high, Math.min(out.high + bump, out.hi));
    if(S.obsMax!=null && out.high < S.obsMax) out.high = S.obsMax;
  }
  // peak timing
  let pk=-1e9, pt=null;
  for(let h=Math.floor(now); h<24; h++){
    const v = out.blendCurve[h];
    if(v!=null && v>pk){ pk=v; pt=h; }
  }
  if(S.obsMax!=null && S.obsMax >= pk - 0.05){ out.peakSet = true; out.peakT = S.obsMaxT; }
  else out.peakT = pt;
  return out;
}

/* ================= render ================= */
function setChip(id, ok, label){
  const el = document.getElementById(id);
  el.classList.toggle("ok", ok); el.classList.toggle("bad", !ok);
  if(label) el.lastChild.textContent = label;
}
function heroHeadline(){
  // phrase from the live weather mode the background engine detects, plus a temp descriptor
  let mode="clear";
  try{
    const rains=(S.rains)||[]; const lastR=rains.length?rains[rains.length-1].v:0; const fxR=S.fxRain||0;
    let cloudNow=null; if(S.cloud){ const h=Math.floor(((Date.now()+9*3600*1000)/3600000)%24); const c=S.cloud[h]; if(c!=null) cloudNow=c; }
    let sunFrac=null; const suns=(S.suns)||[]; if(suns.length){ const last=suns[suns.length-1]; const rec=suns.filter(x=>x.t>last.t-1); if(rec.length) sunFrac=rec.reduce((a,b)=>a+b.v,0)/(rec.length*10); }
    if(lastR>0.5||fxR>=2){ mode=(lastR>2||fxR>=6)?"storm":"rain"; }
    else if((cloudNow!=null&&cloudNow>=60)||(sunFrac!=null&&sunFrac<0.35)){ mode="cloud"; }
    else mode="clear";
  }catch(e){}
  const map={ clear:"Clear Skies", cloud:"Cloudy", rain:"Rain Showers", storm:"Storm with Heavy Rain" };
  return {mode, text: map[mode]||"—"};
}
function updateHero(nc){
  const set=(id,v)=>{const e=document.getElementById(id); if(e) e.textContent=v;};
  const hh=heroHeadline();
  set("hero-headline", hh.text);
  set("hero-temp", S.cur!=null ? fmt1(S.cur) : "—");
  set("hero-high", nc && nc.high!=null ? fmt1(nc.high)+"°" : "—");
  // floor
  let floor = (S.metarMax!=null) ? Math.round(S.metarMax) : (S.obsMax!=null? Math.round(S.obsMax):null);
  set("hero-floor", floor!=null ? floor+"°" : "—");
  // verdict bucket (recompute lightweight)
  let vtxt="—";
  try{ const bk=computeBuckets(nc); if(bk&&bk.buckets.length){ const top=bk.buckets.reduce((a,b)=>b.p>a.p?b:a); vtxt=top.k+"°"; } }catch(e){}
  const vEl=document.getElementById("hero-verdict"); if(vEl){ vEl.textContent=vtxt; vEl.classList.add("accent"); }
  // subtitle reflects time-to-peak
  const sub=document.getElementById("hero-sub");
  if(sub){
    const now=jstParts().dec;
    if(nc && nc.peakSet) sub.textContent="peak has passed — settling";
    else if(nc && nc.peakT!=null){ const hrs=Math.max(0,nc.peakT-now); sub.textContent=`~${hrs.toFixed(1)} h to expected peak`; }
    else sub.textContent="live nowcast of today’s maximum";
  }
}
function render(nc){
  S.analog = computeAnalogs();
  try{ window.S = S; }catch(e){}
  const t = jstParts();
  document.getElementById("m-date").textContent = `${todayISO()}`;
  document.getElementById("m-updated").textContent = `${hhmm(t.dec)}:${p2(t.s)} JST`;
  const thM = document.getElementById("th-modelnow");
  if(thM) thM.textContent = `Model @ ${hhmm(Math.min(t.dec,23.99))}`;

  updateHero(nc);
  if(window.__wxClassify) try{ window.__wxClassify(); }catch(e){}
  try{ renderSolar(nc); }catch(e){}
  try{ modelLogTick(); }catch(e){}

  // readouts
  const elN = document.getElementById("r-nowcast");
  elN.textContent = nc.high!=null ? `${fmt1(nc.high)}°C` : "—";
  const norm = normalHigh();
  document.getElementById("r-range").textContent =
    nc.high!=null
      ? `range ${fmt1(nc.lo)}–${fmt1(nc.hi)}°C · normal ${fmt1(norm)}°C (${(nc.high-norm>=0?"+":"")}${fmt1(nc.high-norm)}° vs normal)`
      : "model range —";
  // range bar scaled to ±2°C around blend
  const bar = document.getElementById("r-rangebar"); bar.innerHTML="";
  if(nc.high!=null){
    const span=4, left=nc.high-2;
    const x = v => Math.min(100,Math.max(0,(v-left)/span*100));
    const band=document.createElement("div"); band.className="band";
    band.style.left = x(nc.lo)+"%"; band.style.width = Math.max(1,(x(nc.hi)-x(nc.lo)))+"%";
    const tick=document.createElement("div"); tick.className="tick"; tick.style.left = x(nc.high)+"%";
    bar.append(band,tick);
  }
  document.getElementById("r-obsmax").textContent = S.obsMax!=null?`${fmt1(S.obsMax)}°C`:"—";
  document.getElementById("r-obsmax-time").textContent =
    S.obsMaxT!=null ? `at ${hhmm(S.obsMaxT)} JST` + (S.metarMax!=null?` · METAR max ${fmt1(S.metarMax)}°C`:"") : "no observations yet";
  document.getElementById("r-current").textContent = S.cur!=null?`${fmt1(S.cur)}°C`:"—";
  document.getElementById("r-current-time").textContent = S.curT!=null?`obs ${hhmm(S.curT)} JST`:"—";
  document.getElementById("r-peak").textContent = nc.peakT!=null?hhmm(nc.peakT):"—";
  const loc = analyzeLocal();
  document.getElementById("r-peak-note").textContent =
    (nc.peakT==null ? "—" : nc.peakSet ? "high likely already set" : "blend curve maximum, JST")
    + (loc.seaIn && !nc.peakSet ? " · sea breeze in, downside risk" : "");

  document.getElementById("s-sun").textContent = loc.sunTxt;
  document.getElementById("s-sun-note").innerHTML = loc.sunNote +
    ' · <a href="https://himawari8.nict.go.jp/" target="_blank" rel="noopener" style="color:var(--jma);font-weight:600">Himawari satellite ↗</a>';
  document.getElementById("s-wind").textContent = loc.windTxt;
  document.getElementById("s-wind-note").textContent = loc.windNote;
  const sSea = document.getElementById("s-sea");
  sSea.textContent = loc.seaTxt;
  sSea.style.color = loc.seaIn ? "var(--accent)" : "var(--ink)";
  document.getElementById("s-sea-note").textContent = loc.seaNote;
  const s850 = document.getElementById("s-t850");
  if(s850){
    if(S.t850){
      s850.textContent = `${fmt1(S.t850.mean)}°C`;
      const imLo = S.t850.mean + 9, imHi = S.t850.mean + 12;
      let adv = "";
      if(S.w850){
        const d8 = S.w850.dir, s8 = S.w850.spd;
        if(d8>=240 && d8<=330 && s8>=8) adv = ` · ⚠ 850 wind ${d8}°/${Math.round(s8)} m/s — dry inland/foehn advection off the Kanto–Chubu terrain: aggressive pre-breeze climb risk`;
        else if(d8>=70 && d8<=200 && s8>=6) adv = ` · 850 wind ${d8}°/${Math.round(s8)} m/s — maritime airmass aloft, suppression`;
        else adv = ` · 850 wind ${d8}°/${Math.round(s8)} m/s — neutral advection`;
      }
      document.getElementById("s-t850-note").innerHTML =
        `midday 850 hPa airmass (${S.t850.n} models, spread ${fmt1(S.t850.lo)}–${fmt1(S.t850.hi)}°) · sunny well-mixed implies sfc max ~${fmt1(imLo)}–${fmt1(imHi)}°; sea breeze/cloud lands below that${adv} · ` +
        `<a href="https://www.tropicaltidbits.com/analysis/models/?model=gfs&region=ea&pkg=T850a" target="_blank" rel="noopener" style="color:var(--jma);font-weight:600">GFS T850a ↗</a> ` +
        `<a href="https://www.tropicaltidbits.com/analysis/models/?model=ecmwf&region=ea&pkg=T850a" target="_blank" rel="noopener" style="color:var(--jma);font-weight:600">ECMWF ↗</a>`;
    } else {
      s850.textContent = "—";
      document.getElementById("s-t850-note").textContent = "no 850 hPa data returned";
    }
  }
  const sRain = document.getElementById("s-rain");
  if(sRain){
    sRain.textContent = loc.rainTxt;
    sRain.style.color = (loc.raining || loc.rainTxt==="RAIN RISK") ? "var(--accent)" : "var(--ink)";
    document.getElementById("s-rain-note").innerHTML = loc.rainNote +
      ' · <a href="https://tokyo-ame2.jwa.or.jp/" target="_blank" rel="noopener" style="color:var(--jma);font-weight:600">Amesh radar ↗</a>';
  }
  document.getElementById("s-dew").textContent = loc.dewTxt;
  document.getElementById("s-dew-note").textContent = loc.dewNote;
  document.getElementById("s-taf").textContent = loc.tafTxt;
  document.getElementById("s-taf-note").textContent = loc.tafNote;
  // settlement panel
  {
    const fEl = document.getElementById("st-floor");
    const fNote = document.getElementById("st-floor-note");
    if(S.metarMax!=null){
      fEl.textContent = `${Math.round(S.metarMax)}°C`;
      fNote.textContent = `highest METAR print so far today` +
        (S.obsMax!=null && S.obsMax - Math.round(S.metarMax) >= 0.5
          ? ` · AMeDAS has touched ${fmt1(S.obsMax)}° — next METAR may print ${Math.round(S.obsMax)}°`
          : ``);
    } else if(S.obsMax!=null){
      fEl.textContent = `~${Math.round(S.obsMax)}°C`;
      fNote.textContent = `estimated from AMeDAS ${fmt1(S.obsMax)}° (METAR feed blocked in this browser) — settlement itself uses METAR prints; confirm on Wunderground`;
    } else { fEl.textContent = "—"; fNote.textContent = "no observations yet today"; }
    const mi = jstParts().mi;
    const pf = printForecast(nc);
    const nEl = document.getElementById("st-next");
    const nNote = document.getElementById("st-next-note");
    if(pf && pf.rows.length){
      const r0 = pf.rows[0];
      nEl.textContent = `${r0.exp}° @ ${hhmm(r0.tP)}`;
      if(nNote) nNote.textContent =
        `in ~${(30 - (mi % 30))} min · ${(r0.prob*100).toFixed(0)}% · alt ${r0.alt.k}° ${(r0.alt.p*100).toFixed(0)}% · projected ${fmt1(r0.proj)}° · trend ${(pf.slope>=0?"+":"")}${(pf.slope/2).toFixed(1)}°/30min`;
      if(S.metarMax!=null && r0.exp > Math.round(S.metarMax)) nEl.style.color = "var(--accent)";
      else nEl.style.color = "var(--ink)";
    } else {
      nEl.textContent = `~${(30 - (mi % 30))} min`;
      if(nNote) nNote.textContent = "needs ~30 min of observations to project the print";
    }
    const pEl = document.getElementById("st-prints");
    if(pEl){
      if(!pf){
        pEl.textContent = "needs ~30 min of observations to read the trend";
      } else {
        const lines = pf.rows.slice(1).map(r =>
          `${hhmm(r.tP)}${r.isHour?" (hrly)":""} → <b>${r.exp}°</b> ${(r.prob*100).toFixed(0)}%`).join(" · ");
        let risk = "";
        const trueB = nc.high!=null ? Math.round(nc.high) : null;
        if(trueB!=null && pf.pHour!=null){
          if(pf.pHour < trueB && pf.pHalf!=null && pf.pHalf >= trueB){
            risk = `<br>⚠ ${trueB}° likely needs the :30 / SPECI prints — hourly-only sampling tops at ${pf.pHour}°`;
          } else if(pf.pHour < trueB && (pf.pHalf==null || pf.pHalf < trueB)){
            risk = `<br>⚠ print risk: the curve touches ${fmt1(nc.high)}° between prints — sampled prints may top at ${Math.max(pf.pHour, pf.pHalf ?? pf.pHour)}° and ${trueB}° may never print`;
          }
        }
        pEl.innerHTML =
          `then: ${lines || "—"}`
          + `<br>printed-max est: <b>${pf.pHalf??"—"}°</b> (half-hourly) / <b>${pf.pHour??"—"}°</b> (hourly-only)`
          + (pf.offN ? `<br>sensor offset (METAR−AMeDAS): ${(pf.off>=0?"+":"")}${pf.off.toFixed(1)}° over ${pf.offN} prints`
                     : `<br>sensor offset unknown (METAR feed blocked) — assuming 0; confirm prints on Wunderground`)
          + risk;
      }
    }
    const bWrap = document.getElementById("st-buckets");
    const bk = computeBuckets(nc);
    const vEl = document.getElementById("st-verdict");
    const vNote = document.getElementById("st-verdict-note");
    const vLabel = document.getElementById("st-verdict-label");
    if(bk && bk.buckets.length && vEl){
      const sorted = [...bk.buckets].sort((a,b)=>b.p-a.p);
      const best = sorted[0], second = sorted[1];
      const tossup = !!(second && (best.p - second.p) < 0.08 && Math.abs(best.k - second.k) === 1 && !nc.peakSet);
      bk.__top = best; bk.__second = second; bk.__tossup = tossup;
      const now2 = jstParts().dec;
      // is the temperature still falling / is it late enough that no climb is possible?
      const o = S.obs || [];
      let falling = false, sinceHigh = null;
      if(S.obsMax!=null && S.obsMaxT!=null){
        sinceHigh = now2 - S.obsMaxT;               // hours since the high was set
        const cur = (o.length? o[o.length-1].v : S.cur);
        falling = (cur!=null && S.cur!=null && (S.obsMax - S.cur) >= 0.3);  // cooled >=0.3 off the high
      }
      // a day is DECIDED when the peak is set AND (temp has fallen well off it, OR it's evening 18:00+)
      const decided = nc.peakSet && (sinceHigh!=null && sinceHigh >= 1.5 && (falling || now2 >= 18));
      // rounding-edge risk only matters if the max could still CLIMB into the next bucket.
      // 23.3 rounds to 23; bucket 24 needs >=23.5, i.e. the temp must RISE. If decided/falling, it can't.
      const frac = (S.obsMax!=null) ? (S.obsMax - Math.floor(S.obsMax)) : null;   // .3 for 23.3
      const couldClimb = !decided && !falling && now2 < 15.5;                      // any realistic upside left?
      const nearEdgeLive = frac!=null && frac >= 0.35 && frac < 0.5 && couldClimb; // e.g. 23.7 with climb still possible

      if(decided){
        // day is over: settlement is simply the rounded observed high. No bucket arbitration.
        const settledK = Math.round(S.obsMax);
        vEl.textContent = `${settledK}°C`;
        if(vLabel) vLabel.textContent = "Settlement (unofficial)";
        vNote.textContent = `day's high is in — ${fmt1(S.obsMax)}° at ${hhmm(S.obsMaxT)} JST, temp now falling → settles ${settledK}° · confirm the official print on Wunderground`;
        bk.__settledK = settledK;
      } else if(nc.peakSet && nearEdgeLive){
        vEl.textContent = `${best.k}°C`;
        if(vLabel) vLabel.textContent = "Likely final";
        const conf = Math.round(best.p*100);
        vNote.textContent = `${fmt1(S.obsMax)}° sits just below the rounding edge and a late nudge could still tip it up — adjacent bucket live; watch the prints · ${conf}%`;
      } else if(nc.peakSet){
        // peak set, not near a climbable edge: round the observed high
        const settledK = Math.round(S.obsMax);
        vEl.textContent = `${settledK}°C`;
        if(vLabel) vLabel.textContent = "Likely final";
        vNote.textContent = `peak has passed at ${fmt1(S.obsMax)}° (${hhmm(S.obsMaxT)} JST) → ${settledK}°; a late warm push before ~15:00 is the only upside`;
        bk.__settledK = settledK;
      } else {
        vEl.textContent = `${best.k}°C`;
        const conf = Math.round(best.p*100);
        if(vLabel) vLabel.textContent = "Most likely settlement";
        const hrs = Math.max(0,(nc.peakT??14) - now2);
        vNote.textContent = `${conf}% in this bucket · ~${hrs.toFixed(1)} h to expected peak — still in play`;
      }
      const conf = Math.round(best.p*100);
      if(tossup){
        const lo2 = Math.min(best.k, second.k), hi2 = Math.max(best.k, second.k);
        if(vLabel) vLabel.textContent = "Toss-up";
        vEl.textContent = `${lo2}/${hi2}°`;
        vNote.textContent = `dead heat — ${best.k}° ${(best.p*100).toFixed(0)}% vs ${second.k}° ${(second.p*100).toFixed(0)}% · distribution centre ${fmt1(bk.center)}° sits on the bucket boundary · don’t pay up for either side; the tiebreakers follow`;
      }
    } else if(vEl){ vEl.textContent="—"; vNote.textContent="needs model data"; if(vLabel) vLabel.textContent="Most likely settlement"; }
    if(nc.evid && nc.evid.mixBreak && vEl){
      vNote.textContent += ` · ⚡ MIXING BREAK — ${nc.evid.reasons.filter(r=>r.includes("MIXING")||r.includes("advection")).join("; ")}. Morning cap broke; warm models BOOSTED, expect a fast climb — lean HIGH, not low`;
    } else if(nc.evid && nc.evid.advect && nc.evid.trustWarm>1 && vEl){
      vNote.textContent += ` · strong onshore/SSW flow is HEATING not capping (warm advection) — warm models trusted, upside live`;
    } else if(nc.evid && nc.evid.trustWarm < 1 && vEl && bk && bk.buckets.length){
      vNote.textContent += ` · ⚠ warm pace discounted to ${Math.round(nc.evid.trustWarm*100)}% — ${nc.evid.reasons.join("; ")} (cloud-trapped night heat rarely carries to the peak)`;
    }
    if(bk && bk.analogUsed!=null && S.analog && S.analog.n && vEl){
      vNote.textContent += ` · ${S.analog.n} analog days lean ${fmt1(bk.analogUsed)}° (25% weight in the verdict)`;
    }
    if(nc && nc.memN && nc.memAdj!=null && vNote){
      const ranWord = nc.memMean > 0 ? "cold" : "warm";
      vNote.textContent += ` · memory: my calls ran ${fmt1(Math.abs(nc.memMean))}° ${ranWord} on ${nc.memN} graded day${nc.memN>1?"s":""} like this → ${nc.memAdj>0?"+":"-"}${fmt1(Math.abs(nc.memAdj))}° applied`;
    }
    if(nc && nc.jump && vNote){
      vNote.textContent += nc.jump.level===2
        ? ` · ⚡ TEMP JUMPING: +${fmt1(nc.jump.d10)}° in the last 10 min${nc.jump.headroom>0?` with ${fmt1(nc.jump.headroom)}° of model upside`:" — past the warmest model"} — break underway`
        : (nc.jump.sw && !nc.jump.windUp)
          ? ` · ⚡ jump watch: SOUTHERLY SWITCH INBOUND — bay sentinels already south with ${fmt1(nc.jump.headroom)}° of warm-model upside — spike likely as it reaches Haneda`
          : ` · ⚡ jump watch: south wind rising with ${fmt1(nc.jump.headroom)}° of warm-model upside left — upward break possible`;
      notifyJump(nc.jump);
    } else { try{ window.__jl = 0; }catch(e){} }
    // coherence check: does the verdict agree with the FOLLOW model?
    let followBk = null, followNm = null;
    if(bk && bk.buckets.length && vEl){
      const G2 = computeStrategy(nc, loc);
      if(G2.followHigh!=null){
        followBk = Math.round(G2.followHigh); followNm = G2.follow;
        const top = bk.__top || bk.buckets.reduce((a,b)=> b.p>a.p ? b : a);
        if(bk.__tossup && bk.__second && (followBk===top.k || followBk===bk.__second.k)){
          vNote.textContent += ` · FOLLOW model (${followNm}) breaks the tie toward ${followBk}°`;
        } else if(followBk !== top.k){
          vNote.textContent += ` · ⚠ DIVERGENCE: FOLLOW model (${followNm}) implies ${followBk}° — the ${top.k}° verdict is the pace-lifted ensemble. If the warmth everyone missed was cloud (Sunshine card broken/overcast), favor ${followBk}°; if it’s clear-sky advection, favor ${top.k}°`;
        } else {
          vNote.textContent += ` · FOLLOW model (${followNm}) agrees with the verdict`;
        }
      }
    }
    if(bk && bk.buckets.length){
      // If the day is DECIDED, collapse the distribution onto the settled high so the bars
      // match the verdict. Leave a small sliver on a neighbor only for unseen-print risk.
      let barBuckets = bk.buckets;
      if(bk.__settledK!=null && S.obsMax!=null){
        const sk = bk.__settledK;
        const frac = S.obsMax - Math.floor(S.obsMax);     // .3 for 23.3
        // residual chance an unseen METAR print already caught the next degree up
        // (only meaningful if the high is within ~0.3 of the upper edge)
        const upRisk = frac >= 0.2 ? Math.min(0.12, (frac-0.2)*0.6) : 0.02;
        barBuckets = [
          {k: sk, p: 1 - upRisk},
          {k: sk+1, p: upRisk}
        ];
      }
      const maxP = Math.max(...barBuckets.map(b=>b.p));
      bWrap.innerHTML = barBuckets.map(b =>
        `<div class="bucket${b.p===maxP?" top":""}">
           <span class="bk">${b.k}°C${followBk===b.k?" ◂":""}</span>
           <div class="bbar"><div style="width:${(b.p*100).toFixed(1)}%"></div></div>
           <span class="bp">${(b.p*100).toFixed(0)}%</span>
         </div>`).join("");
    } else {
      bWrap.innerHTML = `<div class="sub">needs model data to compute buckets</div>`;
    }

    // FINAL CALL: arbitrate verdict vs FOLLOW vs headline through the evidence chain
    const fcEl = document.getElementById("fc-val"), fcNote = document.getElementById("fc-note");
    if(fcEl && bk && bk.__settledK!=null){
      // day is decided — final call is the settled high, no arbitration
      fcEl.textContent = `${bk.__settledK}°C`;
      fcEl.style.color = "var(--ink)";
      fcNote.textContent = `day's high is in at ${fmt1(S.obsMax)}° → settles ${bk.__settledK}°; nothing left to arbitrate · confirm on Wunderground`;
    } else if(fcEl && bk && bk.buckets.length){
      const top = bk.__top || bk.buckets.reduce((a,b)=> b.p>a.p ? b : a);
      const second = bk.__second, tossup = bk.__tossup;
      const headB = nc.high!=null ? Math.round(nc.high) : null;
      const cands = new Set([top && top.k, (tossup && second) ? second.k : null, followBk, headB].filter(v=>v!=null));
      if(cands.size <= 1){
        fcEl.textContent = `${top.k}°C`;
        fcEl.style.color = "var(--accent)";
        fcNote.textContent = `${Math.round(top.p*100)}% — verdict, FOLLOW model and headline all agree; trade the number`;
      } else {
        const hot = Math.max(...cands), cool = Math.min(...cands);
        let hotV=0, coolV=0; const why=[];
        if(S.w850){
          if(S.w850.dir>=240 && S.w850.dir<=330 && S.w850.spd>=8){ hotV+=2; why.push("foehn W–NW aloft (strong hot vote)"); }
          else if(S.w850.dir>=70 && S.w850.dir<=200 && S.w850.spd>=6){ coolV+=1; why.push("maritime flow aloft"); }
        }
        if(loc.dewTrend!=null && loc.dewTrend<=-0.7){ hotV+=1; why.push("Td falling (drying)"); }
        else if(loc.dewTrend!=null && loc.dewTrend>=0.7){ coolV+=1; why.push("Td rising (moistening)"); }
        if(nc.evid && nc.evid.trustWarm<1){ coolV+=1; why.push("warm pace already discounted"); }
        if(S.t850 && hot > S.t850.mean+12.3){ coolV+=2; why.push(`T850 ceiling ~${fmt1(S.t850.mean+12)}° vetoes ${hot}°`); }
        if(loc.seaIn && !nc.peakSet){ coolV+=2; why.push("sea breeze already in"); }
        const su=S.suns||[];
        if(su.length>=4){
          const last=su[su.length-1], rec=su.filter(x=>x.t>last.t-1);
          const fr = rec.length ? rec.reduce((a,b)=>a+b.v,0)/(rec.length*10) : null;
          if(fr!=null){
            if(fr>=0.75){ hotV+=1; why.push("near-full sun"); }
            else if(fr<=0.4){ coolV+=1; why.push("mostly cloud"); }
          }
        }
        // The arbiter ADJUSTS FROM the bucket winner; it does not override it wholesale.
        // Evidence can only move the call off the top bucket when the race is close
        // (top bucket < 55%) AND the disputed neighbor is adjacent. A strong evidence
        // sweep (|diff|>=2) can move it even on a clearer bucket, but only by one degree.
        const margin = second ? (top.p - second.p) : 1;     // how decisive is the top bucket
        const evDiff = hotV - coolV;
        let pick = top.k;                                    // default: trust the distribution
        let conf = "holds";
        if(Math.abs(evDiff) >= 2){
          // strong evidence sweep: allow a one-degree move toward the evidence direction,
          // but never past the disputed neighbor and never more than 1° off the top bucket
          const dir = evDiff>0 ? 1 : -1;
          const target = top.k + dir;
          if(second && Math.abs(target - second.k) <= 0 || margin < 0.30){
            pick = target; conf = "clear";
          } else { pick = top.k; conf = (evDiff>0?"hot-lean held":"cool-lean held"); }
        } else if(Math.abs(evDiff) === 1 && margin < 0.18 && second){
          // weak evidence only breaks a genuine near-tie, toward the evidence side
          pick = evDiff>0 ? Math.max(top.k,second.k) : Math.min(top.k,second.k);
          conf = "lean";
        } else {
          pick = top.k; conf = "holds";
        }
        let printNote = "";
        if(pf && pick===hot && pf.pHalf!=null && pf.pHour!=null && pf.pHalf < hot && pf.pHour < hot){
          const pm = Math.max(pf.pHalf, pf.pHour);
          printNote = ` · ⚠ ${hot}° may never PRINT (printed-max est ${pm}°) — settlement gated to ${pm}°`;
          pick = pm; conf = "print-gated";
        }
        fcEl.textContent = `${pick}°C`;
        fcEl.style.color = (conf==="split") ? "var(--ink)" : "var(--accent)";
        // probability context from the bucket distribution (folds in the old toss-up box)
        let probCtx = "";
        if(bk.__tossup && bk.__second){
          const a=bk.__top, b=bk.__second;
          probCtx = ` · resolved from a near-tie (${a.k}° ${Math.round(a.p*100)}% vs ${b.k}° ${Math.round(b.p*100)}%)`;
        } else {
          probCtx = ` · ${Math.round(top.p*100)}% in the ${top.k}° bucket`;
        }
        const confPhrase =
          conf==="print-gated" ? "evidence leaned high, but the print gate demoted it"
          : conf==="clear" ? "strong evidence moved the call"
          : conf==="lean" ? "evidence broke a near-tie"
          : conf==="holds" ? "evidence noted, but the bucket distribution holds the call"
          : conf.endsWith("held") ? `${conf} — not enough to move off the lead bucket`
          : "evidence leans";
        fcNote.textContent = confPhrase
          + ` (${hotV} hot v ${coolV} cool: ${why.join("; ") || "no strong signals"})`
          + probCtx + printNote;
      }
    }
    // merged-box label reflects the day stage
    const vl=document.getElementById("st-verdict-label");
    if(vl){
      if(bk && bk.__settledK!=null) vl.textContent = "Settlement (day is in)";
      else if(nc.peakSet) vl.textContent = "Settlement call · likely final";
      else vl.textContent = "Settlement call";
    }
  }

  document.getElementById("o-flow").textContent = loc.flowTxt;
  document.getElementById("o-flow-note").textContent = loc.flowNote;
  document.getElementById("o-shift").textContent = loc.shiftTxt;
  document.getElementById("o-shift-note").textContent = loc.shiftNote;
  const oTurb = document.getElementById("o-turb");
  oTurb.textContent = loc.turbTxt;
  oTurb.style.color = (loc.turbTxt==="TURB RISK"||loc.turbTxt==="WS / TURB") ? "var(--accent)" : "var(--ink)";
  document.getElementById("o-turb-note").textContent = loc.turbNote;

  // spatial check vs neighbor stations
  const nb = Object.values(S.neighbors);
  const nbEls = [["n-1","n-1-note"],["n-2","n-2-note"]];
  nbEls.forEach((ids,i)=>{
    const el=document.getElementById(ids[0]), note=document.getElementById(ids[1]);
    if(!el) return;
    const n = nb[i];
    if(!n){ el.textContent="—"; note.textContent="no data"; return; }
    const d = (S.cur!=null) ? n.temp - S.cur : null;
    el.textContent = `${fmt1(n.temp)}°C${d!=null?` (${d>=0?"+":""}${fmt1(d)}°)`:""}`;
    note.textContent = n.name + (d==null ? "" :
      d>=1.5 ? " — running warmer than Haneda" :
      d<=-1.5 ? " — running cooler than Haneda" : " — in line with Haneda");
  });
  const sp = document.getElementById("n-read"), spn = document.getElementById("n-read-note");
  if(sp){
    const tokyo = S.neighbors["44132"];
    const dT = (tokyo && S.cur!=null) ? tokyo.temp - S.cur : null;
    if(dT==null){ sp.textContent="—"; spn.textContent="needs both stations"; }
    else if(loc.seaIn && dT>=1.5){
      sp.textContent="FRONT INLAND"; sp.style.color="var(--accent)";
      spn.textContent=`sea-breeze front sits between Haneda and central Tokyo — Haneda capped while inland runs +${fmt1(dT)}°; upside only if flow reverses`;
    } else if(dT>=1.5){
      sp.textContent="INLAND RESERVOIR"; sp.style.color="var(--ink)";
      spn.textContent=`central Tokyo +${fmt1(dT)}° warmer — that air reaches Haneda on W–NW flow; upside risk to the high`;
    } else {
      sp.textContent="UNIFORM"; sp.style.color="var(--ink)";
      spn.textContent="no meaningful gradient across the basin — models likely have the area right";
    }
  }

  // model table
  const rows = document.getElementById("model-rows"); rows.innerHTML="";
  const _sev = compute7d();
  for(const m of MODELS){
    const pm = nc.perModel[m.key];
    const tr = document.createElement("tr");
    const rk = nc.skill && nc.skill.ranks ? nc.skill.ranks[m.key] : null;
    const rkColor = rk==null ? "var(--ink-soft)" : rk<=2 ? "var(--ok)" : (nc.skill.n - rk < 2) ? "var(--bad)" : "var(--ink-soft)";
    const r7 = _sev.ranks[m.key] || null;
    let peakH=null; { const Tc=S.models[m.key]; if(Tc){ let pv=-1e9; for(let h=0;h<24;h++){ const v=Tc[h]; if(v!=null&&v>pv){pv=v;peakH=h;} } } }
    tr.innerHTML = pm ? `
      <td class="model-name"><span class="pen" style="background:${m.hex}"></span>${m.name}</td>
      <td style="text-align:left"><b style="color:${rkColor}">${rk!=null?"#"+rk:"—"}</b></td>
      <td style="text-align:left"><b style="color:${r7&&r7<=2?"var(--ok)":"var(--ink-soft)"}">${r7?"#"+r7:"·"}</b></td>
      <td>${fmt1(pm.rawMax)}°C</td>
      <td>${peakH!=null?p2(peakH)+":00":"—"}</td>
      <td>${fmt1(pm.modelNow)}°C</td>
      <td><span style="color:${pm.bias==null?"inherit":pm.bias>=0.3?"var(--accent)":pm.bias<=-0.3?"var(--jma)":"inherit"};font-weight:${pm.bias!=null&&Math.abs(pm.bias)>=0.3?"600":"400"}">${pm.bias==null?"—":(pm.bias>=0?"+":"")+fmt1(pm.bias)}°</span></td>
      <td>${(S.ydayModelMax[m.key]!=null && S.ydayObsMax!=null) ? ((S.ydayModelMax[m.key]-S.ydayObsMax>=0?"+":"")+fmt1(S.ydayModelMax[m.key]-S.ydayObsMax)+"°") : "—"}</td>
      <td class="proj">${fmt1(pm.projHigh)}°C</td>`
      : `<td class="model-name"><span class="pen" style="background:${m.hex}"></span>${m.name}</td><td colspan="8" style="color:var(--ink-soft)">unavailable</td>`;
    rows.appendChild(tr);
  }
  const tom = MODELS.filter(m=>S.tomorrow[m.key]!=null)
    .map(m=>`${m.name} ${fmt1(S.tomorrow[m.key])}°`).join(" · ");
  const refBits = [];
  if(S.cur!=null && S.curT!=null) refBits.push(`actual ${fmt1(S.cur)}°C @ ${hhmm(S.curT)} JST (AMeDAS)`);
  if(S.jmaFx) refBits.push(`JMA official ${S.jmaFx.name} high: ${S.jmaFx.max}°C`);
  if(S.ydayObsMax!=null) refBits.push(`yday actual: ${fmt1(S.ydayObsMax)}°C`);
  if(tom) refBits.push(`Tomorrow raw maxes: ${tom}C`);
  if(_sev.n) refBits.push(`7d rank: ${_sev.n} graded day${_sev.n>1?"s":""}`);
  document.getElementById("tomorrow-line").textContent = refBits.join("  ·  ");

  // strategist read
  {
    const G = computeStrategy(nc, loc);
    const set=(id,v)=>{const e=document.getElementById(id); if(e) e.textContent=v;};
    set("g-follow", G.follow); set("g-follow-note", G.followNote);
    set("g-discard", G.discard); set("g-discard-note", G.discardNote);
    const w=document.getElementById("g-watch");
    if(w){ w.textContent=G.watch; w.style.color = (G.watch!=="NONE" && G.watch!=="—") ? "var(--accent)" : "var(--ink)"; }
    set("g-watch-note", G.watchNote);
  }

  // analog days panel + track record
  {
    const set=(id,v)=>{const e=document.getElementById(id); if(e) e.textContent=v;};
    const a = S.analog;
    if(a && a.pending){
      set("a-high","—"); set("a-high-note","available from ~09:10 JST — needs this morning's 06→09 ramp");
      set("a-peak","—"); set("a-peak-note","—");
    } else if(a){
      set("a-high",`${fmt1(a.high)}°C`);
      set("a-high-note",`median of ${a.n} similar mornings, IQR ${fmt1(a.lo)}–${fmt1(a.hiQ)}° — matched on 09:00 temp, ramp, cloud, flow, season (2 yrs reanalysis)`);
      set("a-peak", hhmm(a.peak));
      set("a-peak-note","median hour those days peaked");
    } else {
      set("a-high","—"); set("a-high-note","building history — first load fetches ~2 years of hourly reanalysis (one-time, cached in this browser)");
      set("a-peak","—"); set("a-peak-note","—");
    }
    let jj;
    const bk2 = computeBuckets(nc);
    if(bk2 && bk2.buckets.length){
      const b = bk2.buckets.reduce((x,y)=> y.p>x.p ? y : x);
      jj = journalTick(b.k, nc.high);
    } else jj = journalLoad();
    const st = journalStats(jj);
    // how long has today's verdict been saying its current bucket?
    let sinceTxt = "";
    {
      const today = jj[todayISO()];
      const c = today && today.calls;
      if(c && c.length){
        let i = c.length-1;
        while(i>0 && c[i-1].b === c[c.length-1].b) i--;
        sinceTxt = ` · today: saying ${c[c.length-1].b}° since ${hhmm(c[i].t)} JST`;
      }
    }
    if(st){
      set("a-rec", `${st.hit}/${st.n}`);
      set("a-rec-note",
        `10:30 JST locked verdicts that hit the exact bucket, last ${st.n} graded days · high MAE ${fmt1(st.mae)}°`
        + (st.medCall!=null ? ` · verdict typically locks onto the right bucket by ${hhmm(st.medCall)} JST (median of ${st.callN} days)` : ``)
        + sinceTxt + ` — recorded in this browser`);
    } else {
      set("a-rec","0/0");
      set("a-rec-note","locks the verdict at 10:30 JST, grades it next morning, and records WHEN each day's verdict first settled on the correct bucket — builds automatically in this browser" + sinceTxt);
    }
  }

  // metar ticker
  document.getElementById("metar-ticker").innerHTML =
    (S.metars.length ? S.metars.map(m=>`<b>${(m.when||"").slice(11,16)}Z</b>  ${m.raw}`).join("\n")
                     : "METAR feed unavailable in this session.")
    + (S.taf && S.taf.raw ? `\n\n<b>TAF</b>   ${S.taf.raw}` : "");

  drawChart(nc);
  drawT850();
  drawSounding();
}

function drawSounding(){
  const svg=document.getElementById("sndchart"); if(!svg) return;
  const note=document.getElementById("snd-note");
  const S0=S.sounding;
  if(!S0||!S0.levels||S0.levels.length<4){
    svg.innerHTML=`<text x="350" y="180" text-anchor="middle" style="fill:var(--ink-soft)" font-size="13">sounding unavailable</text>`;
    if(note) note.textContent="";
    return;
  }
  const lv=S0.levels;
  const W=700,H=380,L=46,R=130,T=16,B=30, pw=W-L-R, ph=H-T-B;
  // y axis: pressure log scale (1000 bottom -> 500 top)
  const pTop=500,pBot=1000;
  const Y=p=>T+ph*(Math.log(p)-Math.log(pBot))/(Math.log(pTop)-Math.log(pBot));
  let tmin=1e9,tmax=-1e9;
  for(const r of lv){ tmin=Math.min(tmin,r.td!=null?r.td:r.t,r.t); tmax=Math.max(tmax,r.t); }
  tmin=Math.floor(tmin)-3; tmax=Math.ceil(tmax)+3;
  const X=t=>L+pw*(t-tmin)/(tmax-tmin);

  // ---- parcel ascent (compute BEFORE drawing so we can shade the mixed layer) ----
  const sfc=lv[0];
  const sfcMax = (S.obsMax!=null) ? Math.max(sfc.t, S.obsMax) : sfc.t;
  // dry adiabat from the surface parcel: T(z) = sfcMax - 9.8*(z-z0)/1000
  function adiabatT(p){
    // interpolate height at pressure p from the level array
    let zz=null;
    for(let i=0;i<lv.length-1;i++){
      const a=lv[i], b=lv[i+1];
      if((p<=a.p && p>=b.p)||(p>=a.p && p<=b.p)){
        const f=(Math.log(p)-Math.log(a.p))/(Math.log(b.p)-Math.log(a.p));
        zz=a.z+(b.z-a.z)*f; break;
      }
    }
    if(zz==null) zz=lv[lv.length-1].z;
    return sfcMax - 9.8*(zz-sfc.z)/1000;
  }
  let mixP=null, mixZ=null;
  for(let i=1;i<lv.length;i++){
    const dz=(lv[i].z - sfc.z)/1000;
    const parcelT = sfcMax - 9.8*dz;
    if(parcelT <= lv[i].t){ mixP=lv[i].p; mixZ=Math.round(lv[i].z - sfc.z); break; }
  }
  let inv=null;
  for(let i=1;i<lv.length;i++){ if(lv[i].t > lv[i-1].t + 0.3){ inv={p0:lv[i-1].p,p1:lv[i].p,z0:Math.round(lv[i-1].z-sfc.z)}; break; } }

  let g="";
  // shade the mixed layer (surface up to mixing-height pressure)
  if(mixP!=null){
    const yTop=Y(mixP), yBot=Y(pBot);
    g+=`<rect x="${L}" y="${yTop}" width="${pw}" height="${(yBot-yTop).toFixed(1)}" style="fill:rgba(215,71,46,.07)"/>`;
    g+=`<line x1="${L}" y1="${yTop}" x2="${L+pw}" y2="${yTop}" style="stroke:var(--accent);stroke-width:1.2;stroke-dasharray:5 4;opacity:.7"/>`;
    g+=`<text x="${L+8}" y="${yTop-6}" font-size="10.5" style="fill:var(--accent);font-weight:600">mixed layer top ≈ ${mixZ} m</text>`;
  }
  // grid
  for(const p of [1000,925,850,700,600,500]){
    g+=`<line x1="${L}" y1="${Y(p)}" x2="${L+pw}" y2="${Y(p)}" style="stroke:var(--grid);stroke-width:1"/>`;
    g+=`<text x="${L-6}" y="${Y(p)+4}" text-anchor="end" font-size="10.5" style="fill:var(--ink-soft)">${p}</text>`;
  }
  for(let t=Math.ceil(tmin/10)*10;t<=tmax;t+=10){
    g+=`<line x1="${X(t)}" y1="${T}" x2="${X(t)}" y2="${T+ph}" style="stroke:var(--grid);stroke-width:1;opacity:.6"/>`;
    g+=`<text x="${X(t)}" y="${H-12}" text-anchor="middle" font-size="10.5" style="fill:var(--ink-soft)">${t}°</text>`;
  }
  const line=(key,color,w)=>{
    const pts=lv.filter(r=>r[key]!=null).map(r=>`${X(r[key]).toFixed(1)},${Y(r.p).toFixed(1)}`).join(" ");
    return pts?`<polyline points="${pts}" fill="none" style="stroke:${color};stroke-width:${w}"/>`:"";
  };
  // dry adiabat the surface parcel follows (from surface up to mixing top)
  {
    const pts=[];
    for(const r of lv){
      if(mixP!=null && r.p < mixP) break;     // only draw up to the cap
      pts.push(`${X(adiabatT(r.p)).toFixed(1)},${Y(r.p).toFixed(1)}`);
    }
    if(pts.length>1) g+=`<polyline points="${pts.join(' ')}" fill="none" style="stroke:#E7B53C;stroke-width:1.6;stroke-dasharray:6 4;opacity:.85"/>`;
  }
  // dewpoint then temperature
  g+=line("td","var(--jma)",2.2);
  g+=line("t","var(--accent)",2.6);
  // dots + wind barbs on the right gutter
  for(const r of lv){
    g+=`<circle cx="${X(r.t).toFixed(1)}" cy="${Y(r.p).toFixed(1)}" r="2.4" style="fill:var(--accent)"/>`;
    if(r.wd!=null&&r.ws!=null){
      const bx=L+pw+22, by=Y(r.p);
      g+=`<g transform="translate(${bx},${by}) rotate(${(r.wd)})"><line x1="0" y1="0" x2="0" y2="-16" style="stroke:var(--ink-soft);stroke-width:1.5"/></g>`;
      g+=`<text x="${L+pw+40}" y="${by+3}" font-size="9.5" style="fill:var(--ink-soft)">${Math.round(r.ws*1.94384)}kt</text>`;
    }
  }
  svg.innerHTML=g;

  // ---- caption ----
  const parts=[];
  parts.push(`valid ~${p2(S0.validH)}:00 JST`);
  if(mixZ!=null) parts.push(`mixing height ≈ ${mixZ} m (to ${mixP} hPa)`);
  else parts.push(`deep mixing — no cap found below 500 hPa`);
  if(inv) parts.push(`⚠ inversion ${inv.p0}→${inv.p1} hPa (~${inv.z0} m) — lid on surface heating, suppresses the max`);
  else parts.push(`no low-level inversion — surface can mix freely toward the T850 ceiling`);
  parts.push(`shaded band = mixed layer · gold dashes = the dry adiabat a surface parcel follows`);
  if(note) note.innerHTML = parts.join(" · ");
}

function drawT850(){
  const svg = document.getElementById("t850chart");
  if(!svg) return;
  const keys = Object.keys(S.t850Curves || {});
  const W=1000, H=260, L=52, R=16, T=16, B=30;
  const pw=W-L-R, ph=H-T-B;
  if(!keys.length){
    svg.innerHTML = `<text x="${W/2}" y="${H/2}" text-anchor="middle" style="fill:var(--ink-soft)" font-size="13">no 850 hPa data returned by the models</text>`;
    return;
  }
  let vals=[];
  for(const k of keys) vals = vals.concat(S.t850Curves[k].filter(v=>v!=null));
  let ymin=Math.floor(Math.min(...vals))-1, ymax=Math.ceil(Math.max(...vals))+1;
  if(ymax-ymin<4){ const c=(ymax+ymin)/2; ymin=Math.floor(c-2); ymax=Math.ceil(c+2); }
  const X = h => L + h/24*pw;
  const Y = v => T + (ymax-v)/(ymax-ymin)*ph;
  const now = jstParts().dec;
  let g = "";
  // midday assessment window 11–15 JST
  g += `<rect x="${X(11)}" y="${T}" width="${X(15)-X(11)}" height="${ph}" style="fill:rgba(44,110,138,.08)"/>`;
  for(let h=0;h<=24;h+=3){
    g += `<line x1="${X(h)}" y1="${T}" x2="${X(h)}" y2="${T+ph}" style="stroke:var(--grid);stroke-width:1"/>`;
    g += `<text x="${X(h)}" y="${H-10}" text-anchor="middle" font-size="11" style="fill:var(--ink-soft)">${p2(h%24)}</text>`;
  }
  const step = (ymax-ymin>8)?2:1;
  for(let v=ymin; v<=ymax; v+=step){
    g += `<line x1="${L}" y1="${Y(v)}" x2="${W-R}" y2="${Y(v)}" style="stroke:var(--grid);stroke-width:1"/>`;
    g += `<text x="${L-8}" y="${Y(v)+4}" text-anchor="end" font-size="11" style="fill:var(--ink-soft)">${v}°</text>`;
  }
  for(const m of MODELS){
    const a = S.t850Curves[m.key]; if(!a) continue;
    const d = a.map((v,h)=> v==null?null:[h,v]).filter(Boolean)
               .map(p=>`${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ");
    if(d) g += `<polyline points="${d}" fill="none" stroke="${m.hex}" stroke-width="1.6" opacity="0.85"/>`;
  }
  // multi-model mean
  const mean = Array.from({length:24},(_,h)=>{
    const vs = keys.map(k=>S.t850Curves[k][h]).filter(v=>v!=null);
    return vs.length ? vs.reduce((a,b)=>a+b,0)/vs.length : null;
  });
  const dm = mean.map((v,h)=> v==null?null:[h,v]).filter(Boolean)
               .map(p=>`${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ");
  if(dm) g += `<polyline points="${dm}" fill="none" style="stroke:var(--ink);stroke-width:2.4;stroke-dasharray:6 4"/>`;
  // now marker
  g += `<line x1="${X(now)}" y1="${T}" x2="${X(now)}" y2="${T+ph}" style="stroke:var(--ink);stroke-width:1.2;stroke-dasharray:4 4;opacity:.6"/>`;
  // implied surface max annotation from midday mean
  if(S.t850){
    g += `<text x="${X(11)+6}" y="${T+16}" font-size="11.5" style="fill:var(--jma);font-weight:600">midday mean ${fmt1(S.t850.mean)}° → sunny mixed sfc max ~${fmt1(S.t850.mean+9)}–${fmt1(S.t850.mean+12)}°</text>`;
  }
  svg.innerHTML = g;
}

function drawChart(nc){
  const svg = document.getElementById("chart");
  const W=1000, H=400, L=52, R=16, T=18, B=34;
  const pw=W-L-R, ph=H-T-B;
  const now = jstParts().dec;

  // y domain
  let vals=[];
  for(const m of MODELS){ const a=S.models[m.key]; if(a) vals=vals.concat(a.filter(v=>v!=null)); }
  vals = vals.concat(S.obs.map(p=>p.v));
  if(nc.blendCurve) vals = vals.concat(nc.blendCurve.filter(v=>v!=null));
  if(!vals.length){ svg.innerHTML = `<text x="${W/2}" y="${H/2}" text-anchor="middle" style="fill:var(--ink-soft)" font-size="14">Waiting for data…</text>`; return; }
  let ymin=Math.floor(Math.min(...vals))-1, ymax=Math.ceil(Math.max(...vals))+1;
  if(ymax-ymin<6){ const c=(ymax+ymin)/2; ymin=Math.floor(c-3); ymax=Math.ceil(c+3); }
  const X = h => L + h/24*pw;
  const Y = v => T + (ymax-v)/(ymax-ymin)*ph;

  let g = "";
  // grid: every 3h vertical, every 2°C horizontal
  for(let h=0;h<=24;h+=3){
    g += `<line x1="${X(h)}" y1="${T}" x2="${X(h)}" y2="${T+ph}" style="stroke:var(--grid);stroke-width:1"/>`;
    g += `<text x="${X(h)}" y="${H-12}" text-anchor="middle" font-size="11" style="fill:var(--ink-soft)">${p2(h%24)}</text>`;
  }
  const step = (ymax-ymin>12)?4:2;
  for(let v=ymin; v<=ymax; v+=step){
    g += `<line x1="${L}" y1="${Y(v)}" x2="${W-R}" y2="${Y(v)}" style="stroke:var(--grid);stroke-width:1"/>`;
    g += `<text x="${L-8}" y="${Y(v)+4}" text-anchor="end" font-size="11" style="fill:var(--ink-soft)">${v}°</text>`;
  }
  // wind regime strip: blue = onshore (bay), umber = inland (metro)
  for(const p of (S.winds||[])){
    if(p.dir==null || p.dir===0) continue;
    const col = ONSHORE.has(p.dir) ? "#2C6E8A" : (INLAND.has(p.dir) ? "#9A6B4F" : "#AEBBB3");
    g += `<rect x="${(X(p.t)-1.6).toFixed(1)}" y="${T+ph+3}" width="3.2" height="6" style="fill:${col}"/>`;
  }
  // model spaghetti
  const poly = (pts, attrs) => {
    const d = pts.filter(p=>p[1]!=null).map(p=>`${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ");
    return d ? `<polyline points="${d}" fill="none" ${attrs}/>` : "";
  };
  for(const m of MODELS){
    const a=S.models[m.key]; if(!a) continue;
    g += poly(a.map((v,h)=>[h,v]), `stroke="${m.hex}" stroke-width="1.4" opacity="0.75"`);
  }
  // corrected blend (from now onward)
  if(nc.blendCurve){
    const pts = nc.blendCurve.map((v,h)=>[h, (h>=Math.floor(now))?v:null]);
    g += poly(pts, `style="stroke:var(--accent);stroke-width:2.4;stroke-dasharray:7 5"`);
  }
  {
    const norm = normalHigh();
    if(norm>=ymin && norm<=ymax){
      g += `<line x1="${L}" y1="${Y(norm)}" x2="${W-R}" y2="${Y(norm)}" style="stroke:var(--jma);stroke-width:1.2;stroke-dasharray:1 5;opacity:.8"/>`;
      g += `<text x="${L+4}" y="${Y(norm)-6}" font-size="10.5" style="fill:var(--jma)">normal high ~${fmt1(norm)}°</text>`;
    }
  }
  // high watermark
  if(nc.high!=null){
    g += `<line x1="${L}" y1="${Y(nc.high)}" x2="${W-R}" y2="${Y(nc.high)}" style="stroke:var(--accent);stroke-width:1.2;stroke-dasharray:2 4"/>`;
    g += `<text x="${W-R-4}" y="${Y(nc.high)-6}" text-anchor="end" font-size="11.5" style="fill:var(--accent);font-weight:600">nowcast high ${fmt1(nc.high)}°</text>`;
  }
  // observed trace, drawn last and heaviest
  g += poly(S.obs.map(p=>[p.t,p.v]), `style="stroke:var(--ink);stroke-width:2.8;stroke-linejoin:round;stroke-linecap:round"`);
  if(S.obsMax!=null && S.obsMaxT!=null){
    g += `<circle cx="${X(S.obsMaxT)}" cy="${Y(S.obsMax)}" r="4.5" style="fill:none;stroke:var(--ink);stroke-width:2"/>`;
  }
  // now marker
  g += `<line x1="${X(now)}" y1="${T}" x2="${X(now)}" y2="${T+ph}" style="stroke:var(--ink);stroke-width:1.2;stroke-dasharray:4 4;opacity:0.6"/>`;
  g += `<text x="${X(now)+5}" y="${T+14}" font-size="11" style="fill:var(--ink)">現在 ${hhmm(now)}</text>`;

  svg.innerHTML = g;
}

/* ================= orchestration ================= */
async function refresh(){
  document.getElementById("btn-refresh").disabled = true;
  S = { obs:[], obsMax:null, obsMaxT:null, cur:null, curT:null, winds:[], hum:null, metars:[], metarMax:null, dewp:null, metarWind:null, taf:null, suns:[], press:[], rains:[], cloud:null, models:{}, tomorrow:{}, ok:{}, neighbors:{}, ydayObsMax:null, ydayModelMax:{}, d2ObsMax:null, d2ModelMax:{}, jmaFx:null, fxRain:null, t850:null, t850Curves:{}, w850:null, hums:[], fxBreeze:null, sounding:null };
  try{ window.S = S; }catch(e){}
  const [a, m, o, tf] = await Promise.allSettled([fetchAmedas(), fetchMetar(), fetchModels(), fetchTaf()]);
  await Promise.allSettled([fetchSounding()]);
  await Promise.allSettled([fetchNeighbors(), fetchYdayObs(), fetchJmaForecast(), maybeFetchArchive()]);
  cloudSync();
  setChip("chip-amedas", a.status==="fulfilled");
  setChip("chip-metar", m.status==="fulfilled");
  setChip("chip-models", o.status==="fulfilled");
  setChip("chip-taf", tf.status==="fulfilled");
  render(computeNowcast());
  document.querySelector(".readouts").classList.remove("flash");
  void document.querySelector(".readouts").offsetWidth;
  document.querySelector(".readouts").classList.add("flash");
  document.getElementById("btn-refresh").disabled = false;
}
/* ===== smart auto-refresh =====
   JMA publishes new 10-min obs at :00/:10/:20... plus ~90s of processing, so instead
   of a blind 5-min timer we fetch ~100s after every 10-min boundary — fresh obs land
   ~1.5 min after each print, every print. Plus: instant catch-up when the tab wakes
   or the connection returns, an overlap guard, and a visible countdown. */
const PUB_DELAY_MS = 100*1000, TEN_MIN = 600*1000;
function nextWaitMs(now){
  const phase = now % TEN_MIN;
  let wait = (phase <= PUB_DELAY_MS) ? (PUB_DELAY_MS - phase) : (TEN_MIN - phase + PUB_DELAY_MS);
  if(!isFinite(wait) || wait < 0 || wait > TEN_MIN + PUB_DELAY_MS) wait = 5*60*1000;
  return wait;
}
let _fetching=false, _nextTimer=null, NEXT_AT=0;
async function safeRefresh(){
  if(_fetching) return;
  _fetching=true;
  try{ await refresh(); }
  catch(e){}
  finally{ _fetching=false; S.lastFetch=Date.now(); }
}
function scheduleNext(){
  clearTimeout(_nextTimer);
  const wait=nextWaitMs(Date.now());
  NEXT_AT=Date.now()+wait;
  _nextTimer=setTimeout(async()=>{ await safeRefresh(); scheduleNext(); }, wait);
}
function freshen(){
  // waking a stale tab (or reconnecting): if data older than 2.5 min, fetch right now
  if(Date.now() - (S.lastFetch||0) > 150*1000){ safeRefresh().then(scheduleNext); }
}
document.addEventListener("visibilitychange", ()=>{ if(!document.hidden) freshen(); });
window.addEventListener("focus", freshen);

/* ===== fast obs loop: pick up each new 10-min AMeDAS print within ~1 min =====
   latest_time.txt is a tiny file; poll it every 60s and only refetch the
   observation + sentinel data when a NEW print has actually landed. The heavy
   stuff (models, sounding, archive) stays on the normal 5-min cycle. */
let __lastObsStamp = null;
async function fastObsTick(){
  try{
    if(_fetching) return;
    const r = await fetch("https://www.jma.go.jp/bosai/amedas/data/latest_time.txt", {cache:"no-store"});
    if(!r.ok) return;
    const t = (await r.text()).trim();
    if(t === __lastObsStamp) return;       // no new print yet
    __lastObsStamp = t;
    await Promise.allSettled([fetchAmedas(), fetchNeighbors()]);
    render(computeNowcast());
    const el=document.getElementById("m-updated");
    if(el){ const j=jstParts(); el.textContent = `${p2(j.h)}:${p2(j.m)}:${p2(j.s)} JST`; }
  }catch(e){}
}
setInterval(fastObsTick, 60*1000);
window.addEventListener("online", ()=>{ safeRefresh().then(scheduleNext); });
document.getElementById("btn-refresh").addEventListener("click", ()=>{ safeRefresh().then(scheduleNext); });
// countdown so the automation is visible
setInterval(()=>{
  const el=document.getElementById("auto-next"); if(!el) return;
  if(_fetching){ el.textContent="refreshing now…"; return; }
  const sLeft=Math.max(0, Math.round((NEXT_AT-Date.now())/1000));
  el.textContent=`next update in ${Math.floor(sLeft/60)}:${p2(sLeft%60)}`;
}, 1000);
safeRefresh().then(scheduleNext);

/* ================= PWA: register service worker ================= */
/* Only registers over http(s) — silently skipped on file:// so local
   double-click still works. */
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  let _reloading = false;
  // when a new worker activates, it posts SW_UPDATED -> reload once to pick up fresh files
  navigator.serviceWorker.addEventListener("message", (ev) => {
    if (ev.data && ev.data.type === "SW_UPDATED" && !_reloading) {
      _reloading = true;
      location.reload();
    }
  });
  // if the controlling worker changes (new version took over), reload once
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!_reloading) { _reloading = true; location.reload(); }
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      // check for updates every load and every 60s while open
      reg.update();
      setInterval(() => reg.update(), 60 * 1000);
    }).catch(() => {/* offline shell is optional */});
  });
}


/* ================= journal export / import ================= */
(function(){
  function dl(){
    let data="{}"; try{ data=localStorage.getItem("rjtt_jr_v1")||"{}"; }catch(e){}
    const blob=new Blob([data],{type:"application/json"});
    const a=document.createElement("a");
    a.href=URL.createObjectURL(blob);
    a.download=`rjtt-journal-${todayISO()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  }
  function up(file){
    const r=new FileReader();
    r.onload=()=>{
      try{
        const incoming=JSON.parse(r.result);
        if(typeof incoming!=="object"||Array.isArray(incoming)) throw new Error("bad file");
        // MERGE rather than overwrite: keep the most-complete record per day
        let cur={}; try{ cur=JSON.parse(localStorage.getItem("rjtt_jr_v1")||"{}"); }catch(e){}
        let added=0;
        for(const k in incoming){
          const a=cur[k], b=incoming[k];
          if(!a){ cur[k]=b; added++; continue; }
          // prefer the entry that has been graded (actual!=null); else keep more calls
          const aGraded=a.actual!=null, bGraded=b.actual!=null;
          if(bGraded && !aGraded){ cur[k]=b; added++; }
          else if(bGraded===aGraded){
            const an=(a.calls||[]).length, bn=(b.calls||[]).length;
            if(bn>an){ cur[k]=b; added++; }
          }
        }
        localStorage.setItem("rjtt_jr_v1", JSON.stringify(cur));
        const n=Object.keys(cur).length;
        alert(`Journal loaded — merged ${added} day(s), ${n} total now stored. Refreshing…`);
        location.reload();
      }catch(e){ alert("Couldn't read that file — make sure it's a journal saved from this dashboard."); }
    };
    r.readAsText(file);
  }
  const be=document.getElementById("jr-export"), bi=document.getElementById("jr-import"), fi=document.getElementById("jr-file");
  if(be) be.addEventListener("click", dl);
  if(bi && fi){ bi.addEventListener("click", ()=>fi.click()); fi.addEventListener("change", e=>{ if(e.target.files[0]) up(e.target.files[0]); }); }
})();

/* ================= live weather background ================= */
(function(){
  const bt=document.getElementById("build-tag"); if(bt) bt.textContent="v35";
  try{ console.log("[rjtt] sky engine v35"); }catch(e){}
  const cv=document.getElementById("wx"); if(!cv) return;
  const ctx=cv.getContext("2d");
  let W=0,Hh=0, dpr=Math.min(2,window.devicePixelRatio||1);
  function size(){ W=window.innerWidth; Hh=window.innerHeight;
    cv.width=W*dpr; cv.height=Hh*dpr; ctx.setTransform(dpr,0,0,dpr,0,0); }
  window.addEventListener("resize", size); size();

  // particles
  let drops=[], clouds=[], flakesInit=false;
  function makeRain(n){ drops=[]; for(let i=0;i<n;i++) drops.push({x:Math.random()*W,y:Math.random()*Hh,l:8+Math.random()*14,v:380+Math.random()*320,w:Math.random()*0.6+0.4}); }
  function makeClouds(n){ clouds=[]; for(let i=0;i<n;i++) clouds.push({x:Math.random()*W,y:Math.random()*Hh*0.7,r:120+Math.random()*220,v:6+Math.random()*12,a:0.05+Math.random()*0.08}); }

  // state set from the dashboard's live data
  let mode="clear", intensity=0.4, windPush=0.15, last=performance.now();

  function setSky(){
    const sky=document.getElementById("sky");
    if(!sky) return;
    const dark = document.documentElement.getAttribute("data-theme")==="dark";
    if(dark){
      if(mode==="rain"||mode==="storm") sky.style.background="linear-gradient(160deg,#0b0e13 0%,#10151c 55%,#161b22 100%)";
      else if(mode==="cloud") sky.style.background="linear-gradient(160deg,#0e1219 0%,#161c25 55%,#1c222b 100%)";
      else sky.style.background="linear-gradient(160deg,#0d1016 0%,#141a24 45%,#241a0f 100%)";
    } else {
      // LIGHT mode skies: soft daylight tints
      if(mode==="rain"||mode==="storm") sky.style.background="linear-gradient(160deg,#c4ccd6 0%,#d2dae2 55%,#dce0e4 100%)";
      else if(mode==="cloud") sky.style.background="linear-gradient(160deg,#cfd7e0 0%,#dde2e8 55%,#e6e9ec 100%)";
      else sky.style.background="linear-gradient(160deg,#dfe6ee 0%,#eef2f0 45%,#f5efe2 100%)";
    }
  }

  function classify(){
    // DEMO override: if a scene is forced, render it and skip live detection
    if(window.__wxForce){
      mode = window.__wxForce;
      intensity = (mode==="storm")?0.9:(mode==="rain")?0.6:0.5;
      if(mode==="rain"||mode==="storm") makeRain(Math.round(160+intensity*420));
      if(mode==="cloud"||mode==="clear") makeClouds(mode==="cloud"?9:4);
      setSky();
      const b=document.getElementById("wx-badge");
      if(b) b.textContent = ({clear:"\u2600 clear",cloud:"\u2601 cloudy",rain:"\u2602 rain",storm:"\u26c8 heavy rain"})[mode] + " (demo)";
      return;
    }
    try{
      const SS = (typeof S!=="undefined" && S) ? S : (window.S||null);
      if(!SS) { mode="clear"; }
      const rains=(SS&&SS.rains)||[];
      const lastR = rains.length?rains[rains.length-1].v:0;
      // recent accumulation: total rain over the last ~hour (catches "it rained, now between showers")
      let recentR = 0;
      if(rains.length){ const tEnd=rains[rains.length-1].t; recentR = rains.filter(r=>r.t>tEnd-1).reduce((a,b)=>a+b.v,0); }
      const fxR = (SS&&SS.fxRain)||0;
      let cloudNow=null;
      if(SS&&SS.cloud){ const h=Math.floor(((Date.now()+9*3600*1000)/3600000)%24); const c=SS.cloud[h]; if(c!=null) cloudNow=c; }
      let sunFrac=null;
      const suns=(SS&&SS.suns)||[];
      if(suns.length){ const last=suns[suns.length-1]; const rec=suns.filter(x=>x.t>last.t-1); if(rec.length) sunFrac=rec.reduce((a,b)=>a+b.v,0)/(rec.length*10); }

      // RAIN if: falling now, OR fell recently (last hour), OR forecast to rain soon.
      const rainSignal = Math.max(lastR, recentR*0.6, fxR);
      if(lastR>0.3 || recentR>=0.5 || fxR>=1.5){
        mode = (lastR>2 || fxR>=6 || recentR>=4) ? "storm" : "rain";
        intensity = Math.min(1, Math.max(0.4, rainSignal/6));
      }
      else if((cloudNow!=null && cloudNow>=60) || (sunFrac!=null && sunFrac<0.35)){ mode="cloud"; intensity=cloudNow!=null?cloudNow/100:0.7; }
      else { mode="clear"; intensity=0.4; }

      // wind push from station feed if present
      const w=(SS&&SS.winds)||[];
      if(w.length && w[w.length-1].spd!=null) windPush=Math.max(0.05,Math.min(0.6,w[w.length-1].spd/12));
    }catch(e){ mode="clear"; }

    if(mode==="rain"||mode==="storm") makeRain(Math.round(160+intensity*420));
    if(mode==="cloud"||mode==="clear") makeClouds(mode==="cloud"?9:4);
    setSky();
    const badge=document.getElementById("wx-badge");
    if(badge) badge.textContent = ({clear:"☀ clear",cloud:"☁ cloudy",rain:"☂ rain",storm:"⛈ heavy rain"})[mode];
  }

  let flash=0;
  function frame(t){
    const dt=Math.min(0.05,(t-last)/1000); last=t;
    ctx.clearRect(0,0,W,Hh);

    if(mode==="cloud"||mode==="clear"){
      for(const c of clouds){
        c.x+=c.v*dt*10*(0.4+windPush);
        if(c.x-c.r>W) c.x=-c.r;
        const g=ctx.createRadialGradient(c.x,c.y,0,c.x,c.y,c.r);
        g.addColorStop(0,`rgba(220,225,232,${c.a})`); g.addColorStop(1,"rgba(220,225,232,0)");
        ctx.fillStyle=g; ctx.beginPath(); ctx.arc(c.x,c.y,c.r,0,7); ctx.fill();
      }
      if(mode==="clear"){ // soft sun glow upper area
        const g=ctx.createRadialGradient(W*0.5,Hh*0.05,0,W*0.5,Hh*0.05,Hh*0.5);
        g.addColorStop(0,"rgba(255,200,120,0.10)"); g.addColorStop(1,"rgba(255,200,120,0)");
        ctx.fillStyle=g; ctx.fillRect(0,0,W,Hh);
      }
    }

    if(mode==="rain"||mode==="storm"){
      ctx.strokeStyle="rgba(170,200,230,0.45)"; ctx.lineWidth=1;
      const slant=windPush*60;
      for(const d of drops){
        d.y+=d.v*dt; d.x+=slant*dt;
        if(d.y>Hh){ d.y=-d.l; d.x=Math.random()*W; }
        ctx.globalAlpha=d.w; ctx.beginPath(); ctx.moveTo(d.x,d.y); ctx.lineTo(d.x+slant*0.06,d.y+d.l); ctx.stroke();
      }
      ctx.globalAlpha=1;
      if(mode==="storm"){
        flash-=dt;
        if(flash<=0 && Math.random()<0.012){ flash=0.18; }
        if(flash>0){ ctx.fillStyle=`rgba(255,255,255,${flash*0.6})`; ctx.fillRect(0,0,W,Hh); }
      }
    }
    requestAnimationFrame(frame);
  }
  function safeClassify(){
    try{ classify(); }
    catch(err){
      const b=document.getElementById("wx-badge");
      if(b) b.textContent="sky error";
      try{ console.error("[rjtt] sky engine:", err); }catch(e){}
    }
  }
  // URL override for instant testing: index.html?sky=rain (or storm / cloud / clear)
  try{
    const q=new URLSearchParams(location.search).get("sky");
    if(q && ["clear","cloud","rain","storm"].indexOf(q)>=0) window.__wxForce=q;
  }catch(e){}
  safeClassify();
  requestAnimationFrame(frame);
  setInterval(safeClassify, 60*1000);
  window.addEventListener("focus", safeClassify);
  // expose so render() can refresh the sky the instant new data lands
  window.__wxClassify = safeClassify;
  // sky demo buttons: force a scene (or return to live)
  document.querySelectorAll(".skydemo").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const sky = btn.getAttribute("data-sky");
      document.querySelectorAll(".skydemo").forEach(b=>b.classList.remove("on"));
      if(sky==="live"){ window.__wxForce = null; }
      else { window.__wxForce = sky; btn.classList.add("on"); }
      safeClassify();
    });
  });
})();
