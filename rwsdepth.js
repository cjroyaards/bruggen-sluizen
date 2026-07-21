/* RWS-bodemhoogte (20 m, CC-0) live in de browser herkleurd naar blauwe zeekaart-stijl.
   Haalt de RWS-tegels op (layers=show:1), matcht elke pixelkleur op de RWS-legenda,
   en tekent 'm in onze blauwe kleuren + fijne contourlijnen op de klassegrenzen.
   window.makeRwsDepthLayer(opts) -> L.GridLayer  (CORS is toegestaan door RWS). */
(function(){
  'use strict';
  // [srcR,srcG,srcB, tgtR,tgtG,tgtB,tgtA, rank]
  var PAL = [[114, 0, 77, 243, 248, 253, 235, 46], [121, 25, 91, 243, 248, 253, 235, 45], [123, 43, 105, 243, 248, 253, 235, 44], [127, 64, 125, 243, 248, 253, 235, 43], [129, 81, 142, 243, 248, 253, 235, 42], [128, 97, 161, 235, 244, 251, 235, 41], [129, 116, 181, 223, 238, 248, 235, 40], [127, 134, 202, 223, 238, 248, 235, 39], [123, 151, 222, 207, 230, 243, 235, 38], [120, 172, 247, 207, 230, 243, 235, 37], [117, 182, 253, 207, 230, 243, 235, 36], [116, 189, 250, 188, 220, 238, 235, 35], [117, 200, 247, 188, 220, 238, 235, 34], [117, 207, 243, 168, 207, 230, 235, 33], [118, 216, 241, 147, 195, 224, 235, 32], [120, 224, 238, 121, 179, 216, 235, 31], [116, 230, 232, 91, 158, 203, 235, 30], [118, 241, 230, 63, 134, 189, 235, 29], [117, 247, 224, 188, 214, 168, 235, 28], [114, 255, 221, 188, 214, 168, 235, 27]];
  var EXPORT = "https://geo.rijkswaterstaat.nl/arcgis/rest/services/GDR/bodemhoogte_20mtr/MapServer/export";
  function tileBbox(c){ var n=Math.pow(2,c.z), span=40075016.686/n, W=20037508.343, x=((c.x%n)+n)%n;
    return [-W+x*span, W-(c.y+1)*span, -W+(x+1)*span, W-c.y*span]; }
  function tileUrl(c){ var b=tileBbox(c);
    return EXPORT+"?bbox="+b[0]+","+b[1]+","+b[2]+","+b[3]
      +"&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&layers=show:1&f=image"; }
  function nearest(r,g,b){ var best=-1,bd=1e9; for(var k=0;k<PAL.length;k++){ var p=PAL[k];
      var dr=r-p[0],dg=g-p[1],db=b-p[2],d=dr*dr+dg*dg+db*db; if(d<bd){bd=d;best=k;} }
    return bd<1600?best:-1; }   // drempel ~40 per kanaal
  function recolor(src,dst){
    var N=256*256, rank=new Int16Array(N).fill(-999);
    for(var i=0;i<N;i++){ var o=i*4;
      if(src[o+3]<20){ dst[o+3]=0; continue; }
      var k=nearest(src[o],src[o+1],src[o+2]);
      if(k<0){ dst[o+3]=0; continue; }
      var p=PAL[k]; dst[o]=p[3]; dst[o+1]=p[4]; dst[o+2]=p[5]; dst[o+3]=p[6]; rank[i]=p[7];
    }
    // contourlijnen: donkerder waar de diepteklasse verandert (rechts/onder)
    for(var y=0;y<256;y++) for(var x=0;x<256;x++){ var i2=y*256+x, r0=rank[i2];
      if(r0===-999) continue;
      var rr=(x<255)?rank[i2+1]:r0, rd=(y<255)?rank[i2+256]:r0;
      if((rr!==-999&&rr!==r0)||(rd!==-999&&rd!==r0)){ var o=i2*4;
        dst[o]=(dst[o]*0.45)|0; dst[o+1]=(dst[o+1]*0.55)|0; dst[o+2]=(dst[o+2]*0.7)|0; dst[o+3]=255; }
    }
  }
  window.makeRwsDepthLayer=function(opts){
    opts=opts||{};
    var L_=window.L;
    var Layer=L_.GridLayer.extend({
      createTile:function(coords,done){
        var tile=document.createElement("canvas"); tile.width=256; tile.height=256;
        var ctx=tile.getContext("2d");
        var img=new Image(); img.crossOrigin="anonymous";
        var self=this;
        img.onload=function(){ try{
            var tmp=document.createElement("canvas"); tmp.width=256; tmp.height=256;
            var tc=tmp.getContext("2d"); tc.drawImage(img,0,0,256,256);
            var s=tc.getImageData(0,0,256,256), d=ctx.createImageData(256,256);
            recolor(s.data,d.data); ctx.putImageData(d,0,0); done(null,tile);
          }catch(e){ done(null,tile); } };
        img.onerror=function(){ done(null,tile); };
        img.src=tileUrl(coords);
        return tile;
      }
    });
    return new Layer(Object.assign({pane:opts.pane||"bathyPane",minZoom:8,maxZoom:19,
      opacity:opts.opacity||1,attribution:'Diepte NL: © Rijkswaterstaat bodemhoogte (CC-0)'},opts));
  };
})();
