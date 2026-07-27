/* Luchtdruk-laag voor de hoofdkaart: isobaren (marching squares, elke 4 hPa) + H/L-centra.
   Viewport-veld via Open-Meteo pressure_msl (ECMWF). Volgt de gedeelde tijd via Pressure.setTime(tf).
   window.Pressure.init(map) → setOn(bool), setTime(tf), isOn(). */
(function () {
  'use strict';
  const NHOURS = 168, PAD = 0.35, MAXPTS = 400, D0 = 0.18, STEP = 4;   // STEP = isobaar-interval (hPa)
  let map=null, times=null, field=null, tFloat=0, on=false;
  let loading=false, pending=false, fieldKey='', fieldTimer=0, lastHr=-999;
  let canvas=null, ctx=null, hlLayer=null;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const CHUNK=100;

  async function fetchChunk(ch, attempt){
    attempt=attempt||0;
    const url='https://api.open-meteo.com/v1/forecast?latitude='+ch.map(p=>p[0]).join(',')
      +'&longitude='+ch.map(p=>p[1]).join(',')
      +'&hourly=pressure_msl&forecast_days=7&timeformat=unixtime&timezone=GMT&models=ecmwf_ifs025';
    try{
      const r=await fetch(url,{cache:'no-store'});
      if((r.status===429||r.status>=500)&&attempt<4){ await sleep(700*(attempt+1)); return fetchChunk(ch,attempt+1); }
      if(!r.ok) throw new Error('HTTP '+r.status);
      const j=await r.json(); return Array.isArray(j)?j:[j];
    }catch(e){ if(attempt<3){ await sleep(600*(attempt+1)); return fetchChunk(ch,attempt+1); } return null; }
  }
  function viewportGrid(){
    const b=map.getBounds().pad(PAD); let dLat=D0,dLon=D0;
    let nLat=Math.ceil((b.getNorth()-b.getSouth())/dLat)+1, nLon=Math.ceil((b.getEast()-b.getWest())/dLon)+1;
    while(nLat*nLon>MAXPTS){ dLat*=1.3; dLon*=1.3; nLat=Math.ceil((b.getNorth()-b.getSouth())/dLat)+1; nLon=Math.ceil((b.getEast()-b.getWest())/dLon)+1; }
    return {lat0:b.getSouth(),lon0:b.getWest(),dLat,dLon,nLat,nLon};
  }
  function covers(b){ return field && b.getSouth()>=field.lat0 && b.getNorth()<=field.lat0+(field.nLat-1)*field.dLat && b.getWest()>=field.lon0 && b.getEast()<=field.lon0+(field.nLon-1)*field.dLon; }
  function schedule(){ clearTimeout(fieldTimer); fieldTimer=setTimeout(load,450); }
  async function load(){
    if(!map||!on) return;
    if(covers(map.getBounds().pad(0.05))){ draw(); return; }
    if(loading){ pending=true; return; }
    const g=viewportGrid();
    const key=g.lat0.toFixed(3)+','+g.lon0.toFixed(3)+','+g.nLat+'x'+g.nLon;
    if(key===fieldKey){ draw(); return; }
    loading=true;
    const pts=[]; for(let i=0;i<g.nLat;i++) for(let j=0;j<g.nLon;j++) pts.push([+(g.lat0+i*g.dLat).toFixed(3),+(g.lon0+j*g.dLon).toFixed(3)]);
    const chunks=[]; for(let s=0;s<pts.length;s+=CHUNK) chunks.push(pts.slice(s,s+CHUNK));
    const results=await Promise.all(chunks.map(c=>fetchChunk(c)));   // parallel i.p.v. serieel
    const resp=[]; let ok=true;
    for(const r of results){ if(!r){ ok=false; break; } resp.push(...r); }
    loading=false; if(pending){ pending=false; schedule(); }
    if(!ok||!resp.length||!resp[0].hourly){ setTimeout(schedule,8000); return; }
    const nH=Math.min(NHOURS,resp[0].hourly.time.length); if(!times) times=resp[0].hourly.time.slice(0,NHOURS);
    const n=g.nLat*g.nLon; const P=new Float32Array(nH*n).fill(NaN);
    for(let p=0;p<n&&p<resp.length;p++){ const h=resp[p].hourly; if(!h) continue; const pr=h.pressure_msl; for(let t=0;t<nH;t++){ const v=pr[t]; if(v!=null) P[t*n+p]=v; } }
    field={lat0:g.lat0,lon0:g.lon0,dLat:g.dLat,dLon:g.dLon,nLat:g.nLat,nLon:g.nLon,nH,P};
    fieldKey=key; lastHr=-999; draw(); schedule();
  }

  function sliceAt(tf){
    if(!field) return null; const ti=Math.max(0,Math.min(field.nH-1,Math.round(tf))); const n=field.nLat*field.nLon;
    const G=[]; for(let i=0;i<field.nLat;i++){ const row=[]; for(let j=0;j<field.nLon;j++) row.push(field.P[ti*n+i*field.nLon+j]); G.push(row); } return G;
  }
  function resizeCanvas(){ if(!canvas) return; const sz=map.getSize(); canvas.width=sz.x*devicePixelRatio; canvas.height=sz.y*devicePixelRatio; canvas.style.width=sz.x+'px'; canvas.style.height=sz.y+'px'; ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0); }
  function reposition(){ if(map&&canvas) L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0,0])); }

  function draw(){
    if(!ctx) return;
    const sz=map.getSize(); ctx.clearRect(0,0,sz.x,sz.y);
    if(hlLayer) hlLayer.clearLayers();
    if(!on||!field) return;
    const G=sliceAt(tFloat); if(!G) return;
    const nLat=field.nLat, nLon=field.nLon;
    const latAt=i=>field.lat0+i*field.dLat, lonAt=j=>field.lon0+j*field.dLon;
    const pt=(lat,lon)=>map.latLngToContainerPoint([lat,lon]);
    let mn=Infinity,mx=-Infinity;
    for(let i=0;i<nLat;i++) for(let j=0;j<nLon;j++){ const v=G[i][j]; if(Number.isNaN(v)) continue; if(v<mn)mn=v; if(v>mx)mx=v; }
    if(mn===Infinity) return;
    const lo=Math.ceil(mn/STEP)*STEP, hi=Math.floor(mx/STEP)*STEP;
    const cx=sz.x/2, cy=sz.y/2;
    for(let lev=lo; lev<=hi; lev+=STEP){
      const bold = (lev%20===0);
      ctx.lineWidth = bold?1.8:1.0; ctx.strokeStyle = bold?'rgba(45,55,75,0.85)':'rgba(70,80,100,0.6)';
      let labelPt=null, labelBest=Infinity;
      for(let i=0;i<nLat-1;i++) for(let j=0;j<nLon-1;j++){
        const v00=G[i][j], v01=G[i][j+1], v10=G[i+1][j], v11=G[i+1][j+1];
        if(Number.isNaN(v00)||Number.isNaN(v01)||Number.isNaN(v10)||Number.isNaN(v11)) continue;
        const edge=(va,vb,la,lna,lb,lnb)=>{ if((va<lev)===(vb<lev)) return null; const tt=(lev-va)/(vb-va); return [la+(lb-la)*tt, lna+(lnb-lna)*tt]; };
        const cr=[];
        let e;
        if((e=edge(v00,v01,latAt(i),lonAt(j),latAt(i),lonAt(j+1)))) cr.push(e);
        if((e=edge(v10,v11,latAt(i+1),lonAt(j),latAt(i+1),lonAt(j+1)))) cr.push(e);
        if((e=edge(v00,v10,latAt(i),lonAt(j),latAt(i+1),lonAt(j)))) cr.push(e);
        if((e=edge(v01,v11,latAt(i),lonAt(j+1),latAt(i+1),lonAt(j+1)))) cr.push(e);
        for(let k=0;k+1<cr.length;k+=2){
          const a=pt(cr[k][0],cr[k][1]), b=pt(cr[k+1][0],cr[k+1][1]);
          ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
          const mx2=(a.x+b.x)/2, my2=(a.y+b.y)/2, d=(mx2-cx)*(mx2-cx)+(my2-cy)*(my2-cy);
          if(d<labelBest && mx2>20 && mx2<sz.x-20 && my2>20 && my2<sz.y-20){ labelBest=d; labelPt=[mx2,my2]; }
        }
      }
      if(labelPt){ ctx.save(); ctx.font='700 10.5px system-ui'; ctx.fillStyle=bold?'rgba(45,55,75,0.95)':'rgba(70,80,100,0.85)'; ctx.strokeStyle='rgba(255,255,255,0.85)'; ctx.lineWidth=3; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.strokeText(lev, labelPt[0], labelPt[1]); ctx.fillText(lev, labelPt[0], labelPt[1]); ctx.restore(); }
    }
    // H/L-centra: strikt lokaal min/max in 5×5-omgeving, binnen het beeld
    if(hlLayer){
      const b=map.getBounds(); const m=2;
      for(let i=m;i<nLat-m;i++) for(let j=m;j<nLon-m;j++){
        const v=G[i][j]; if(Number.isNaN(v)) continue;
        const la=latAt(i), ln=lonAt(j);
        if(!b.contains([la,ln])) continue;
        let isMin=true, isMax=true;
        for(let di=-m;di<=m&&(isMin||isMax);di++) for(let dj=-m;dj<=m;dj++){ if(!di&&!dj) continue; const w=G[i+di][j+dj]; if(Number.isNaN(w)) continue; if(w>=v) isMax=false; if(w<=v) isMin=false; }
        if(isMin||isMax){
          const H=isMax; const html='<div class="hlmark '+(H?'hl-h':'hl-l')+'"><b>'+(H?'H':'L')+'</b><span>'+Math.round(v)+'</span></div>';
          L.marker([la,ln],{icon:L.divIcon({className:'',html,iconSize:[30,30],iconAnchor:[15,15]}),interactive:false,keyboard:false}).addTo(hlLayer);
        }
      }
    }
  }

  const API={
    init(m){
      if(map) return API; map=m;
      map.createPane('presPane'); const pane=map.getPane('presPane'); pane.style.zIndex=446; pane.style.pointerEvents='none';
      canvas=document.createElement('canvas'); canvas.style.cssText='position:absolute;left:0;top:0;pointer-events:none'; pane.appendChild(canvas); ctx=canvas.getContext('2d');
      hlLayer=L.layerGroup();
      map.on('resize',()=>{ resizeCanvas(); reposition(); if(on) draw(); });
      map.on('moveend zoomend',()=>{ reposition(); if(on){ draw(); schedule(); } });
      map.on('movestart zoomstart',()=>{ if(ctx){ const sz=map.getSize(); ctx.clearRect(0,0,sz.x,sz.y); } });
      resizeCanvas(); reposition();
      return API;
    },
    setOn(v){ on=v; if(canvas) canvas.style.display=v?'block':'none'; if(v){ hlLayer.addTo(map); resizeCanvas(); reposition(); schedule(); draw(); } else { if(hlLayer) hlLayer.clearLayers(); map.removeLayer(hlLayer); const sz=map.getSize(); if(ctx) ctx.clearRect(0,0,sz.x,sz.y); } },
    setTime(tf){ tFloat=tf; const hr=Math.round(tf); if(on && hr!==lastHr){ lastHr=hr; draw(); } },
    isOn(){ return on; }
  };
  window.Pressure=API;
})();
