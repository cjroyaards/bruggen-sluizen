/* Windvoorspelling-laag voor de hoofdkaart (open data via Open-Meteo, GFS/ICON/HARMONIE).
   Zichtgebied-gebaseerd: bemonstert het zichtbare kaartdeel en werkt daardoor wereldwijd.
   window.Wind.init(map) → setLayers({arrows,particles,color}), setTime(tf), setPlaying, onTime, getTimes, nowIndex, anyOn.
   Wind waait ook over land, dus geen zeemasker. Snelheid in knopen, kleur naar Beaufort. */
(function () {
  'use strict';
  const NHOURS = 168, PLAY_HPS = 1.4;
  const PAD = 0.25, MAXPTS = 300, D0 = 0.1;   // basis-rasterafstand (°), verschaald tot ≤MAXPTS per zichtgebied
  // Beaufort-kleuren (knopen)
  const RAMP = [[0,'#86b6e8'],[1,'#5b9bd6'],[4,'#3fa579'],[7,'#4aa62f'],[11,'#98ba26'],
    [17,'#e6bd15'],[22,'#f6a63c'],[28,'#ee6f3a'],[34,'#e0463f'],[41,'#cf3670'],[48,'#9b4bb0'],[56,'#6d3b9e']];
  function windColor(kn){ for(let k=RAMP.length-1;k>=0;k--) if(kn>=RAMP[k][0]) return RAMP[k][1]; return RAMP[0][1]; }
  function beaufort(kn){ const b=[1,4,7,11,17,22,28,34,41,48,56,64]; let n=0; for(const t of b){ if(kn>=t) n++; } return n; }

  let map=null, times=null, field=null;   // field={lat0,lon0,dLat,dLon,nLat,nLon,nH,U,V,SP,GU}
  let tFloat=0, playing=false, loading=false, everLoaded=false, fieldKey='', fieldTimer=0;
  let canvas=null, ctx=null, colorCanvas=null, cctx=null, particles=[], rafId=0, lastTs=0, colorDirty=true;
  let want={ arrows:false, particles:false, color:false };
  let onTimeChange=null, statusCb=null;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));

  /* ---- data: zichtgebied ophalen ---- */
  const CHUNK=100;
  async function fetchChunk(ch, attempt){
    attempt=attempt||0;
    const url='https://api.open-meteo.com/v1/forecast?latitude='+ch.map(p=>p[0]).join(',')
      +'&longitude='+ch.map(p=>p[1]).join(',')
      +'&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&forecast_days=7'
      +'&wind_speed_unit=kn&timeformat=unixtime&timezone=GMT';
    try{
      const r=await fetch(url,{cache:'no-store'});
      if((r.status===429||r.status>=500)&&attempt<4){ await sleep(700*(attempt+1)); return fetchChunk(ch,attempt+1); }
      if(!r.ok) throw new Error('HTTP '+r.status);
      const j=await r.json(); return Array.isArray(j)?j:[j];
    }catch(e){ if(attempt<3){ await sleep(600*(attempt+1)); return fetchChunk(ch,attempt+1); } return null; }
  }
  function viewportGrid(){
    const b=map.getBounds().pad(PAD);
    let dLat=D0, dLon=D0;
    let nLat=Math.ceil((b.getNorth()-b.getSouth())/dLat)+1, nLon=Math.ceil((b.getEast()-b.getWest())/dLon)+1;
    while(nLat*nLon>MAXPTS){ dLat*=1.3; dLon*=1.3; nLat=Math.ceil((b.getNorth()-b.getSouth())/dLat)+1; nLon=Math.ceil((b.getEast()-b.getWest())/dLon)+1; }
    return {lat0:b.getSouth(), lon0:b.getWest(), dLat, dLon, nLat, nLon};
  }
  function fieldCovers(b){
    return field && b.getSouth()>=field.lat0 && b.getNorth()<=field.lat0+(field.nLat-1)*field.dLat
      && b.getWest()>=field.lon0 && b.getEast()<=field.lon0+(field.nLon-1)*field.dLon;
  }
  function scheduleField(){ clearTimeout(fieldTimer); fieldTimer=setTimeout(loadField,700); }
  async function loadField(){
    if(!map||loading) return;
    if(!(want.arrows||want.particles||want.color)) return;
    if(fieldCovers(map.getBounds().pad(0.05))) return;         // huidig beeld al gedekt
    const g=viewportGrid();
    const key=g.lat0.toFixed(3)+','+g.lon0.toFixed(3)+','+g.nLat+'x'+g.nLon;
    if(key===fieldKey) return;
    loading=true; if(statusCb) statusCb('Winddata laden…');
    const pts=[]; for(let i=0;i<g.nLat;i++) for(let j=0;j<g.nLon;j++) pts.push([+(g.lat0+i*g.dLat).toFixed(3),+(g.lon0+j*g.dLon).toFixed(3)]);
    const responses=[]; let ok=true;
    for(let s=0;s<pts.length;s+=CHUNK){ const r=await fetchChunk(pts.slice(s,s+CHUNK)); if(!r){ ok=false; break; } responses.push(...r); }
    loading=false;
    if(!ok||!responses.length||!responses[0].hourly){ if(statusCb) statusCb('Winddata niet bereikbaar'); setTimeout(scheduleField,8000); return; }
    if(statusCb) statusCb('');
    const nH=Math.min(NHOURS, responses[0].hourly.time.length);
    if(!times) times=responses[0].hourly.time.slice(0,NHOURS);
    const n=g.nLat*g.nLon;
    const FU=new Float32Array(nH*n).fill(NaN), FV=new Float32Array(nH*n).fill(NaN), FSP=new Float32Array(nH*n).fill(NaN), FGU=new Float32Array(nH*n).fill(NaN);
    for(let p=0;p<n&&p<responses.length;p++){ const h=responses[p].hourly; if(!h) continue;
      const sp=h.wind_speed_10m, dir=h.wind_direction_10m, gu=h.wind_gusts_10m;
      for(let t=0;t<nH;t++){ const s=sp[t], dd=dir[t]; if(s==null||dd==null) continue;
        const radTo=(dd+180)*Math.PI/180;   // richting waarheen de wind waait
        FU[t*n+p]=s*Math.sin(radTo); FV[t*n+p]=s*Math.cos(radTo); FSP[t*n+p]=s; FGU[t*n+p]=gu?gu[t]:NaN; } }
    field={lat0:g.lat0,lon0:g.lon0,dLat:g.dLat,dLon:g.dLon,nLat:g.nLat,nLon:g.nLon,nH,U:FU,V:FV,SP:FSP,GU:FGU};
    fieldKey=key;
    if(!everLoaded){ everLoaded=true; setTimeFloat(nowIndex()); }
    colorDirty=true; if(onTimeChange) onTimeChange(tFloat);
    if(want.particles) resetParticles();
    scheduleField();                                            // dek zo nodig het inmiddels verschoven beeld
  }

  /* ---- interpolatie ---- */
  function sampleUVi(lat,lon,t){
    if(!field || t<0 || t>=field.nH) return null;
    const n=field.nLat*field.nLon, fi=(lat-field.lat0)/field.dLat, fj=(lon-field.lon0)/field.dLon;
    const i0=Math.floor(fi), j0=Math.floor(fj);
    if(i0<0||j0<0||i0>=field.nLat-1||j0>=field.nLon-1) return null;
    const wi=fi-i0, wj=fj-j0; let su=0,sv=0,sw=0;
    for(let di=0;di<=1;di++) for(let dj=0;dj<=1;dj++){ const idx=t*n+(i0+di)*field.nLon+(j0+dj); const u=field.U[idx]; if(Number.isNaN(u)) continue; const w=(di?wi:1-wi)*(dj?wj:1-wj); su+=u*w; sv+=field.V[idx]*w; sw+=w; }
    if(sw<0.25) return null; return [su/sw,sv/sw];
  }
  function sampleUV(lat,lon,tf){
    const t0=Math.floor(tf), w=tf-t0, a=sampleUVi(lat,lon,t0);
    if(w<1e-3||t0>=NHOURS-1) return a; const b=sampleUVi(lat,lon,t0+1);
    if(!a) return b; if(!b) return a; return [a[0]*(1-w)+b[0]*w,a[1]*(1-w)+b[1]*w];
  }

  /* ---- kleurveld (canvas, alleen hertekenen bij move/zoom/tijd) ---- */
  function drawColor(){
    if(!colorCanvas||!field) return;
    const sz=map.getSize(); if(colorCanvas.width!==sz.x||colorCanvas.height!==sz.y){ colorCanvas.width=sz.x; colorCanvas.height=sz.y; }
    cctx.clearRect(0,0,sz.x,sz.y); const B=10;
    for(let x=0;x<sz.x;x+=B) for(let y=0;y<sz.y;y+=B){
      const ll=map.containerPointToLatLng([x+B/2,y+B/2]); const uv=sampleUV(ll.lat,ll.lng,tFloat); if(!uv) continue;
      const kn=Math.hypot(uv[0],uv[1]); cctx.fillStyle=windColor(kn); cctx.globalAlpha=0.42; cctx.fillRect(x,y,B,B);
    }
    cctx.globalAlpha=1; colorDirty=false;
  }

  /* ---- pijlen ---- */
  function drawArrows(){
    const sz=map.getSize(), step=46;
    ctx.lineWidth=1.6; ctx.lineCap='round'; ctx.lineJoin='round'; ctx.globalAlpha=1;
    for(let x=step*0.6;x<sz.x;x+=step) for(let y=step*0.6;y<sz.y;y+=step){
      const ll=map.containerPointToLatLng([x,y]); const uv=sampleUV(ll.lat,ll.lng,tFloat); if(!uv) continue;
      const u=uv[0], v=uv[1], kn=Math.hypot(u,v); if(kn<0.5) continue;
      const dx=u, dy=-v, m=Math.hypot(dx,dy)||1, ux=dx/m, uy=dy/m;
      const len=Math.min(step*0.52, 8+kn*0.9);
      const hx=x+ux*len*0.5, hy=y+uy*len*0.5, tx=x-ux*len*0.5, ty=y-uy*len*0.5;
      const ah=Math.min(6, len*0.42), ang=Math.atan2(uy,ux);
      ctx.strokeStyle=windColor(kn);
      ctx.beginPath(); ctx.moveTo(tx,ty); ctx.lineTo(hx,hy);
      ctx.lineTo(hx-ah*Math.cos(ang-0.45),hy-ah*Math.sin(ang-0.45));
      ctx.moveTo(hx,hy); ctx.lineTo(hx-ah*Math.cos(ang+0.45),hy-ah*Math.sin(ang+0.45));
      ctx.stroke();
    }
  }

  /* ---- deeltjes ---- */
  function resizeCanvas(){ const sz=map.getSize();
    [canvas,colorCanvas].forEach(c=>{ if(!c) return; c.width=sz.x*devicePixelRatio; c.height=sz.y*devicePixelRatio; c.style.width=sz.x+'px'; c.style.height=sz.y+'px'; });
    ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0); cctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
    colorCanvas.width=sz.x; colorCanvas.height=sz.y; // kleurveld in css-pixels
  }
  function reposition(){ if(map){ if(canvas) L.DomUtil.setPosition(canvas,map.containerPointToLayerPoint([0,0])); if(colorCanvas) L.DomUtil.setPosition(colorCanvas,map.containerPointToLayerPoint([0,0])); } }
  function spawnParticle(pt){ const s=map.getSize(), ll=map.containerPointToLatLng([Math.random()*s.x,Math.random()*s.y]); pt.lat=ll.lat; pt.lon=ll.lng; pt.age=40+Math.random()*120; return pt; }
  function resetParticles(){ if(!canvas) return; const z=map.getZoom(); const count=Math.min(2600,Math.round(300*Math.pow(1.5,z-5))); particles=Array.from({length:count},()=>spawnParticle({})); ctx.clearRect(0,0,canvas.width,canvas.height); }

  function frame(ts){
    rafId=requestAnimationFrame(frame);
    const dt=lastTs?Math.min(0.08,(ts-lastTs)/1000):0; lastTs=ts;
    if(playing&&times){ tFloat+=dt*PLAY_HPS; if(tFloat>=NHOURS-1) tFloat=0; colorDirty=true; if(onTimeChange) onTimeChange(tFloat); }
    if(want.color && colorDirty) drawColor();
    if(!canvas||(!want.particles&&!want.arrows)||!field) return;
    const sz=map.getSize();
    if(want.particles&&playing){
      ctx.globalCompositeOperation='destination-out'; ctx.fillStyle='rgba(0,0,0,0.045)'; ctx.fillRect(0,0,sz.x,sz.y);
      ctx.globalCompositeOperation='source-over'; ctx.lineWidth=1.5; ctx.lineCap='round';
      const speedScale=0.00050*Math.pow(1.18,map.getZoom()-6);
      for(const p of particles){
        if(--p.age<=0){ spawnParticle(p); continue; }
        const uv=sampleUV(p.lat,p.lon,tFloat); if(!uv){ spawnParticle(p); continue; }
        const u=uv[0], v=uv[1], kn=Math.hypot(u,v);
        const nLat=p.lat+v*speedScale/1.5, nLon=p.lon+u*speedScale/(1.5*Math.cos(p.lat*Math.PI/180));
        const a=map.latLngToContainerPoint([p.lat,p.lon]), b=map.latLngToContainerPoint([nLat,nLon]);
        if(b.x<-20||b.y<-20||b.x>sz.x+20||b.y>sz.y+20){ spawnParticle(p); continue; }
        p.lat=nLat; p.lon=nLon;
        ctx.strokeStyle=windColor(kn); ctx.globalAlpha=Math.min(0.95,0.4+kn/25);
        ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
      }
      ctx.globalAlpha=1;
    } else if(!want.particles){ ctx.clearRect(0,0,sz.x,sz.y); }
    if(want.arrows) drawArrows();
  }

  function pointInfo(lat,lon,tf){
    const uv=sampleUV(lat,lon,tf); if(!uv) return null;
    const u=uv[0], v=uv[1], kn=Math.hypot(u,v);
    const dirTo=(Math.atan2(u,v)*180/Math.PI+360)%360, dirFrom=(dirTo+180)%360;
    return { kn, kmh:kn*1.852, ms:kn*0.514444, bft:beaufort(kn), dirFrom };
  }

  /* ---- tijd ---- */
  function defaultTimes(){ const midnight=Math.floor(Date.now()/86400000)*86400; return Array.from({length:NHOURS},(_,i)=>midnight+i*3600); }
  function nowIndex(){ const now=Date.now()/1000; let best=0; for(let i=0;i<times.length;i++) if(Math.abs(times[i]-now)<Math.abs(times[best]-now)) best=i; return best; }
  function setTimeFloat(tf){ tFloat=Math.max(0,Math.min(NHOURS-1,tf)); colorDirty=true; }
  function sync(){
    const on=want.arrows||want.particles||want.color;
    if(canvas) canvas.style.display=(want.arrows||want.particles)?'block':'none';
    if(colorCanvas) colorCanvas.style.display=want.color?'block':'none';
    if(on) scheduleField();
    if(want.particles) resetParticles();
    colorDirty=true;
  }

  const API={
    init(m){
      if(map) return API; map=m;
      map.createPane('windPane'); const pane=map.getPane('windPane');
      pane.style.zIndex=448; pane.style.pointerEvents='none';
      colorCanvas=document.createElement('canvas'); colorCanvas.style.cssText='position:absolute;left:0;top:0;pointer-events:none;display:none';
      canvas=document.createElement('canvas'); canvas.style.cssText='position:absolute;left:0;top:0;pointer-events:none;display:none';
      pane.appendChild(colorCanvas); pane.appendChild(canvas);
      ctx=canvas.getContext('2d'); cctx=colorCanvas.getContext('2d');
      times=defaultTimes();
      map.on('resize',()=>{ resizeCanvas(); reposition(); resetParticles(); colorDirty=true; });
      map.on('moveend zoomend',()=>{ reposition(); resetParticles(); colorDirty=true; if(want.arrows||want.particles||want.color) scheduleField(); if(want.color) drawColor(); });
      map.on('movestart zoomstart',()=>{ if(ctx) ctx.clearRect(0,0,canvas.width,canvas.height); if(cctx) cctx.clearRect(0,0,colorCanvas.width,colorCanvas.height); });
      resizeCanvas(); reposition(); setTimeFloat(nowIndex()); requestAnimationFrame(frame);
      return API;
    },
    setLayers(w){ const wasP=want.particles; want=Object.assign({},want,w); if(want.particles&&!wasP) playing=true; if(!(want.arrows||want.particles||want.color)) playing=false; sync(); if(onTimeChange) onTimeChange(tFloat); },
    anyOn(){ return want.arrows||want.particles||want.color; },
    pointNow(lat,lon){ return field?pointInfo(lat,lon,tFloat):null; },
    pointSeries(lat,lon){ if(!field) return null; const out=[]; for(let i=0;i<NHOURS;i++) out.push(pointInfo(lat,lon,i)); return out; },
    isLoaded(){ return !!field; },
    setTime(tf){ playing=false; setTimeFloat(tf); if(want.color) drawColor(); if(onTimeChange) onTimeChange(tFloat); },
    setPlaying(v){ playing=v; },
    isPlaying(){ return playing; },
    onTime(cb){ onTimeChange=cb; },
    onStatus(cb){ statusCb=cb; },
    getTimes(){ return times; },
    getTFloat(){ return tFloat; },
    nowIndex, NHOURS
  };
  window.Wind=API;
})();
