const $=id=>document.getElementById(id);
const canvas=$('trafficCanvas'),ctx=canvas.getContext('2d'),chart=$('chartCanvas'),cctx=chart.getContext('2d');

const IDS=['I00','I10','I01','I11'];
const CONN={
  I00:{N:null,S:'I01',E:'I10',W:null},
  I10:{N:null,S:'I11',E:null,W:'I00'},
  I01:{N:'I00',S:null,E:'I11',W:null},
  I11:{N:'I10',S:null,E:null,W:'I01'}
};
const CENTERS={I00:[190,190],I10:[490,190],I01:[190,490],I11:[490,490]};
const SPAWNS=[['I00','S'],['I00','E'],['I10','S'],['I10','W'],['I01','N'],['I01','E'],['I11','N'],['I11','W']];
const HORIZON=24000;
const TILE_HALF=150;
const PED_DURATION=5;
const PED_CHANCE=0.0012;
const YELLOW_DURATION=3;
// Stop line sits at the zebra crossing (drawIntersection draws the stripes at
// offset = boxHalf+7 = 42 from center). Solving posToOffset(pos) = -42 for pos
// gives ~131; we stop a hair earlier so the car's front bumper lands behind
// the stripes rather than on them.
const STOP_LINE=124;

let state,raf=null,last=0,acc=0,seed=42,nextIdCounter=1;

function lcg(s0){let s=s0>>>0;return function(){s=(s*1664525+1013904223)>>>0;return s/4294967296}}

function buildSchedules(profile,baseSeed){
  return SPAWNS.map((sp,idx)=>{
    const rnd=lcg((baseSeed+idx*7919)>>>0);
    const d=sp[1];
    const rate=profile==='rush'?.85:profile==='imbalanced'?(d==='E'?.95:d==='W'?.65:.25):.22;
    const arr=new Uint8Array(HORIZON);
    for(let i=0;i<HORIZON;i++){arr[i]=rnd()<rate*.05*.75?1:0}
    return arr;
  });
}

function freshIntersection(){return {phase:0,phaseTime:0,phaseDuration:20,signalState:'green',amberTimer:0,queues:{N:[],E:[],S:[],W:[]},vehicles:[],served:0,totalWait:0,maxQueue:0,lastDecision:'Waiting to start',preempting:false,pedestrian:{active:false,timer:0,side:null},history:[]}}

function fresh(){
  state={
    running:false,
    mode:$('modeSelect').value,
    traffic:$('trafficSelect').value,
    speed:+$('speedRange').value,
    t:0,stepIndex:0,
    schedules:buildSchedules($('trafficSelect').value,seed),
    intersections:{},decisions:[],logs:[],
    globalServed:0,globalTotalWait:0,globalMaxQueue:0,historyGlobal:[],pedCount:0
  };
  for(const id of IDS)state.intersections[id]=freshIntersection();
  nextIdCounter=1;
  for(let i=0;i<8;i++){
    const [id,d]=SPAWNS[i%8];
    addVehicle(id,d,Math.floor(i/8)*3+(i%8)*0.4);
  }
  logMsg('NET','Simulation reset — 2×2 grid online.');
  render();
}

function addVehicle(id,d,delay=0,emergency=false,tripWait=0){
  state.intersections[id].vehicles.push({id:nextIdCounter++,d,pos:-30-delay*22,wait:0,tripWait,passed:false,emergency,committed:false});
}

function logMsg(id,s){
  state.logs.unshift(`[${state.t.toFixed(1)}s] ${id!=='NET'?'['+id+'] ':''}${s}`);
  state.logs=state.logs.slice(0,20);
  $('log').innerHTML=state.logs.map(x=>`<div class="border-b border-base-300/60 py-0.5">${x}</div>`).join('');
}

function pushDecision(d){state.decisions.unshift(d);state.decisions=state.decisions.slice(0,8)}

function phaseName(iState){return iState.phase===0?'North ↕ South':'East ↔ West'}
function greenFor(iState,d){return iState.signalState==='green'&&(iState.phase===0?(d==='N'||d==='S'):(d==='E'||d==='W'))}
function isYellowFor(iState,d){return iState.signalState==='yellow'&&(iState.phase===0?(d==='N'||d==='S'):(d==='E'||d==='W'))}
function effectiveGreen(iState,d){if(iState.pedestrian&&iState.pedestrian.active)return false;return greenFor(iState,d)}
function queueCount(iState,d){return iState.queues[d].length}

function controllerFor(id){
  const iState=state.intersections[id];
  if(iState.preempting||iState.signalState==='yellow')return;
  const ns=queueCount(iState,'N')+queueCount(iState,'S'),ew=queueCount(iState,'E')+queueCount(iState,'W');
  if(state.mode==='fixed'){iState.phaseDuration=20;return}
  const active=iState.phase===0?ns:ew,other=iState.phase===0?ew:ns;
  const activeName=iState.phase===0?'N/S':'E/W',otherName=iState.phase===0?'E/W':'N/S';
  iState.phaseDuration=Math.max(10,Math.min(30,10+active*1.8));
  if(iState.phaseTime>=10&&other>active*1.35){
    const reasoning=`${otherName} queue (${other}) is ${(other/Math.max(1,active)).toFixed(2)}× the ${activeName} queue (${active}), past the 1.35× threshold after the 10s minimum green → yellow, then switching to ${otherName}.`;
    iState.signalState='yellow';iState.amberTimer=0;
    iState.lastDecision=`${activeName} yielding — yellow before switching to ${otherName}.`;
    logMsg(id,iState.lastDecision);
    pushDecision({id,type:'switch',t:state.t,reasoning,ns,ew});
  }
}

function handleExit(id,v){
  const iState=state.intersections[id];
  iState.served++;iState.totalWait+=v.wait;
  const nb=CONN[id][v.d];
  if(nb){addVehicle(nb,v.d,0,v.emergency,v.tripWait)}
  else{state.globalServed++;state.globalTotalWait+=v.tripWait}
}

function tick(dt){
  state.t+=dt;
  const step=state.stepIndex++;
  SPAWNS.forEach((sp,idx)=>{if(step<HORIZON&&state.schedules[idx][step])addVehicle(sp[0],sp[1])});
  for(const id of IDS){
    const iState=state.intersections[id];
    iState.phaseTime+=dt;
    if(!iState.preempting&&!iState.pedestrian.active){
      if(iState.signalState==='yellow'){
        iState.amberTimer+=dt;
        if(iState.amberTimer>=YELLOW_DURATION){
          iState.phase=1-iState.phase;iState.phaseTime=0;iState.signalState='green';iState.amberTimer=0;
          const active=iState.phase===0?(queueCount(iState,'N')+queueCount(iState,'S')):(queueCount(iState,'E')+queueCount(iState,'W'));
          iState.phaseDuration=Math.max(10,Math.min(30,10+active*1.8));
          iState.lastDecision=`Phase changed to ${phaseName(iState)}.`;
          logMsg(id,iState.lastDecision);
        }
      }else{
        if(iState.phaseTime>=iState.phaseDuration){
          iState.signalState='yellow';iState.amberTimer=0;
          iState.lastDecision=`${phaseName(iState)} ending — yellow, then switching.`;
          logMsg(id,iState.lastDecision);
        }
        controllerFor(id);
      }
    }
    for(const v of iState.vehicles){
      if(v.passed)continue;
      const green=effectiveGreen(iState,v.d);
      const beforeStop=!v.committed && v.pos<STOP_LINE;
      // A vehicle may cross the stop line only while its approach is green.
      // While red/yellow/pedestrian phase is active, clamp it at the stop line.
      if(!v.committed && green && v.pos>=STOP_LINE-2){
        v.committed=true;
      }
      let speed=(green||v.committed)?.95:0;
      const nextPos=v.pos+speed*dt*35;
      if(!v.committed && !green){
        v.pos=Math.min(v.pos,STOP_LINE);
      }else{
        v.pos=nextPos;
      }
      if(!v.committed && !green && v.pos>=STOP_LINE)v.pos=STOP_LINE;
      if(v.committed&&v.pos>=430){v.passed=true;handleExit(id,v);continue}
      if(v.pos>=105&&!green&&!v.committed){v.wait+=dt;v.tripWait+=dt}
    }
    iState.vehicles=iState.vehicles.filter(v=>!v.passed);
    for(const d of ['N','E','S','W'])iState.queues[d]=iState.vehicles.filter(v=>v.d===d&&v.pos>100&&v.pos<250&&!v.passed);
    iState.maxQueue=Math.max(iState.maxQueue,...['N','E','S','W'].map(d=>queueCount(iState,d)));
    iState.history.push({t:state.t,q:['N','E','S','W'].reduce((a,d)=>a+queueCount(iState,d),0)});
    if(iState.history.length>160)iState.history.shift();

    const emVeh=iState.vehicles.find(v=>v.emergency&&!v.passed);
    if(emVeh&&iState.pedestrian.active){
      iState.pedestrian.active=false;iState.pedestrian.timer=0;
      iState.lastDecision='🚶 Pedestrian crossing cut short — emergency vehicle approaching.';
      logMsg(id,iState.lastDecision);
      pushDecision({id,type:'ped-clear',t:state.t,reasoning:'Emergency vehicle detected — the walk phase was ended early so the signal can preempt.'});
    }
    if(emVeh){
      const reqPhase=(emVeh.d==='N'||emVeh.d==='S')?0:1;
      if(iState.phase!==reqPhase||iState.signalState!=='green'){iState.phase=reqPhase;iState.phaseTime=0;iState.signalState='green';iState.amberTimer=0}
      if(!iState.preempting){
        iState.preempting=true;
        iState.lastDecision=`🚨 Preemption — forcing ${phaseName(iState)} for emergency vehicle.`;
        logMsg(id,iState.lastDecision);
        pushDecision({id,type:'preempt',t:state.t,reasoning:`Emergency vehicle detected on the ${emVeh.d} approach — adaptive control suspended, immediate green forced.`});
      }
      if(emVeh.pos>320){
        const nb=CONN[id][emVeh.d];
        if(nb){
          const ns2=state.intersections[nb];
          if(!ns2.preempting){
            ns2.preempting=true;
            ns2.phase=(emVeh.d==='N'||emVeh.d==='S')?0:1;
            ns2.phaseTime=0;ns2.signalState='green';ns2.amberTimer=0;
            ns2.lastDecision='🚨 Pre-clearing ahead of approaching emergency vehicle.';
            logMsg(nb,ns2.lastDecision);
            const eta=((430-emVeh.pos)/(0.95*35)).toFixed(1);
            pushDecision({id:nb,type:'preempt',t:state.t,reasoning:`Emergency vehicle inbound from ${id} (ETA ~${eta}s) — pre-clearing the corridor before it arrives.`});
          }
        }
      }
    }else if(iState.preempting){
      iState.preempting=false;iState.phaseTime=0;
      iState.lastDecision='Emergency corridor cleared — resuming normal control.';
      logMsg(id,iState.lastDecision);
      pushDecision({id,type:'resume',t:state.t,reasoning:'No emergency vehicle present at this node anymore — adaptive controller resumed.'});
    }

    if(!iState.preempting){
      if(iState.pedestrian.active){
        iState.pedestrian.timer+=dt;
        if(iState.pedestrian.timer>=PED_DURATION){
          iState.pedestrian.active=false;iState.pedestrian.timer=0;iState.phaseTime=0;
          iState.lastDecision='Crosswalk cleared — vehicles released, signal control resumed.';
          logMsg(id,iState.lastDecision);
          pushDecision({id,type:'ped-clear',t:state.t,reasoning:`Pedestrian finished crossing after ${PED_DURATION}s — all approaches released.`});
        }
      }else if(Math.random()<PED_CHANCE){
        triggerPedestrian(id);
      }
    }
  }
  state.historyGlobal.push({t:state.t,q:IDS.reduce((a,id)=>a+['N','E','S','W'].reduce((b,d)=>b+queueCount(state.intersections[id],d),0),0)});
  if(state.historyGlobal.length>160)state.historyGlobal.shift();
  state.globalMaxQueue=Math.max(...IDS.map(id=>state.intersections[id].maxQueue));
}

function triggerPedestrian(id){
  const iState=state.intersections[id];
  if(iState.preempting||iState.pedestrian.active)return false;
  const side=['N','S','E','W'][Math.floor(Math.random()*4)];
  iState.pedestrian.active=true;iState.pedestrian.timer=0;iState.pedestrian.side=side;
  state.pedCount++;
  iState.lastDecision=`🚶 Pedestrian crossing called on the ${side} crosswalk — all approaches held for ${PED_DURATION}s.`;
  logMsg(id,iState.lastDecision);
  pushDecision({id,type:'pedestrian',t:state.t,reasoning:`Walk button pressed at ${id} (${side} crosswalk) — every approach stops at that zebra crossing for ${PED_DURATION}s, regardless of signal phase.`});
  return true;
}

function callPedestrian(){
  const order=[...IDS].sort(()=>Math.random()-0.5);
  const id=order.find(i=>!state.intersections[i].preempting&&!state.intersections[i].pedestrian.active)||order[0];
  if(!triggerPedestrian(id))logMsg(id,'Crosswalk already in use or intersection is under emergency preemption — try again shortly.');
}

function spawnEmergency(){
  const [id,d]=SPAWNS[Math.floor(Math.random()*SPAWNS.length)];
  addVehicle(id,d,0,true,0);
  logMsg(id,`🚨 Emergency vehicle dispatched, entering grid heading ${d}.`);
  pushDecision({id,type:'dispatch',t:state.t,reasoning:`New emergency vehicle spawned at ${id} heading ${d}. Signals along its path will preempt as it approaches.`});
}

function posToOffset(pos){return ((pos+30)/460)*280-140}

function drawIntersection(id,iState){
  const [cx,cy]=CENTERS[id];
  const half=TILE_HALF,roadHalf=40,boxHalf=35;
  ctx.fillStyle='#16333a';
  ctx.fillRect(cx-roadHalf,cy-half,roadHalf*2,half*2);
  ctx.fillRect(cx-half,cy-roadHalf,half*2,roadHalf*2);
  ctx.fillStyle='#0b2228';
  ctx.fillRect(cx-boxHalf,cy-boxHalf,boxHalf*2,boxHalf*2);
  ctx.strokeStyle=iState.preempting?'#ff5c70':(iState.signalState==='yellow'?'#ffc94a':'#3a5a5e');
  ctx.lineWidth=iState.preempting||iState.signalState==='yellow'?3:1;
  ctx.strokeRect(cx-boxHalf,cy-boxHalf,boxHalf*2,boxHalf*2);
  ctx.strokeStyle='#b7a86b';ctx.setLineDash([8,8]);ctx.lineWidth=1.5;
  ctx.beginPath();ctx.moveTo(cx,cy-half);ctx.lineTo(cx,cy+half);ctx.moveTo(cx-half,cy);ctx.lineTo(cx+half,cy);ctx.stroke();
  ctx.setLineDash([]);

  const walking=iState.pedestrian&&iState.pedestrian.active;
  const activeSide=walking?iState.pedestrian.side:null;
  const gap=boxHalf+7;

  // Geometry for each of the 4 crosswalk bands, keyed by compass side.
  // Each band is a strip laid straight across its approach road, exactly
  // where the pedestrian actually walks (not through the middle of the box).
  const BANDS={
    N:{axis:'h', cx1:cx-roadHalf, cx2:cx+roadHalf, line:cy-gap, stopA:cy-gap-18, stopB:null},
    S:{axis:'h', cx1:cx-roadHalf, cx2:cx+roadHalf, line:cy+gap, stopA:cy+gap+15, stopB:null},
    E:{axis:'v', cy1:cy-roadHalf, cy2:cy+roadHalf, line:cx+gap, stopA:cx+gap+15, stopB:null},
    W:{axis:'v', cy1:cy-roadHalf, cy2:cy+roadHalf, line:cx-gap, stopA:cx-gap-18, stopB:null}
  };

  // Localized on-road alert glow, drawn only under the crosswalk band that is
  // actually in use — replaces a screen-wide banner with a spot alert right
  // where the pedestrian is crossing.
  if(walking){
    const glowAlpha=0.20+0.14*Math.sin(state.t*8);
    const hb=20;
    const b=BANDS[activeSide];
    ctx.save();ctx.globalAlpha=glowAlpha;ctx.fillStyle='#ff5c70';
    if(b.axis==='h')ctx.fillRect(cx-roadHalf,b.line-hb,roadHalf*2,hb*2);
    else ctx.fillRect(b.line-hb,cy-roadHalf,hb*2,roadHalf*2);
    ctx.restore();
  }

  for(const side of ['N','S','E','W']){
    const isActive=side===activeSide;
    const b=BANDS[side];
    const pulse=isActive?(0.78+0.22*Math.sin(state.t*8)):0.58;
    ctx.save();
    ctx.globalAlpha=pulse;
    ctx.fillStyle=isActive?'#ff5c70':'#f8fafc';
    if(b.axis==='h'){
      for(let s=-roadHalf+2;s<roadHalf-2;s+=8)ctx.fillRect(cx+s,b.line-7,5,14);
    }else{
      for(let s=-roadHalf+2;s<roadHalf-2;s+=8)ctx.fillRect(b.line-7,cy+s,14,5);
    }
    ctx.restore();
    // Stop line for this band — turns red only while this band is in use.
    ctx.save();ctx.globalAlpha=pulse;
    ctx.fillStyle=isActive?'#ff5c70':'#f8fafc';
    if(b.axis==='h')ctx.fillRect(cx-roadHalf,b.stopA,roadHalf*2,3);
    else ctx.fillRect(b.stopA,cy-roadHalf,3,roadHalf*2);
    ctx.restore();
  }

  if(walking){
    // Label sits right beside the active crossing, not floating generically
    // over the tile, so it's obvious which crosswalk the alert refers to.
    const b=BANDS[activeSide];
    ctx.font='bold 10px Segoe UI';
    ctx.fillStyle='#ff5c70';
    if(b.axis==='h'){
      ctx.textAlign='center';
      ctx.fillText('🚶 WALK — VEHICLES STOP',cx,activeSide==='N'?b.line-24:b.line+34);
    }else{
      ctx.textAlign=activeSide==='E'?'left':'right';
      ctx.fillText('🚶 WALK',activeSide==='E'?b.line+8:b.line-8,cy-roadHalf-6);
    }

    // Animated pedestrian, walking along the actual zebra band (not through
    // the middle of the box) with a real leg/arm swing so the motion reads
    // as "walking" rather than "sliding".
    const b2=BANDS[activeSide];
    const walkT=(state.t%PED_DURATION)/PED_DURATION;
    const travel=roadHalf*2-18;
    const dir=1;
    let px,py;
    if(b2.axis==='h'){ px=cx-roadHalf+9+walkT*travel; py=b2.line; }
    else{ px=b2.line; py=cy-roadHalf+9+walkT*travel; }
    const vertical=b2.axis==='v';
    const swing=Math.sin(state.t*9)*0.55;
    ctx.save();
    ctx.translate(px,py);
    ctx.strokeStyle='#f8fafc';ctx.fillStyle='#f8fafc';
    ctx.lineWidth=2.4;ctx.lineCap='round';ctx.lineJoin='round';
    // head
    ctx.beginPath();ctx.arc(0,-15,3.6,0,Math.PI*2);ctx.fill();
    // torso
    ctx.beginPath();ctx.moveTo(0,-11);ctx.lineTo(0,1);ctx.stroke();
    // legs (pendulum from the hip, opposite phase)
    ctx.beginPath();
    ctx.moveTo(0,1);ctx.lineTo(7*Math.sin(swing),1+8*Math.cos(swing));
    ctx.moveTo(0,1);ctx.lineTo(7*Math.sin(-swing),1+8*Math.cos(-swing));
    ctx.stroke();
    // arms (opposite phase to legs, like a natural walk)
    ctx.beginPath();
    ctx.moveTo(0,-9);ctx.lineTo(6*Math.sin(-swing),-9+7*Math.cos(-swing));
    ctx.moveTo(0,-9);ctx.lineTo(6*Math.sin(swing),-9+7*Math.cos(swing));
    ctx.stroke();
    ctx.restore();

    // Small arrow ahead of the pedestrian, making the direction of travel obvious.
    ctx.save();
    if(vertical){ctx.translate(px,py+dir*16);ctx.rotate(Math.PI/2);}
    else{ctx.translate(px+dir*16,py-1);}
    ctx.strokeStyle='#38d9a9';ctx.fillStyle='#38d9a9';ctx.lineWidth=2;ctx.lineCap='round';
    ctx.beginPath();ctx.moveTo(-6,0);ctx.lineTo(6,0);ctx.stroke();
    ctx.beginPath();ctx.moveTo(6,0);ctx.lineTo(1,-4);ctx.lineTo(1,4);ctx.closePath();ctx.fill();
    ctx.restore();
  }
  ctx.textAlign='left';
  function lightColor(d){if(iState.pedestrian&&iState.pedestrian.active)return'#ff5c70';if(isYellowFor(iState,d))return'#ffc94a';return greenFor(iState,d)?'#39d98a':'#ff5c70'}
  ctx.fillStyle=lightColor('N');ctx.fillRect(cx-14,cy-boxHalf-9,12,6);
  ctx.fillStyle=lightColor('E');ctx.fillRect(cx+boxHalf+3,cy-2,6,12);
  for(const v of iState.vehicles){
    if(v.passed)continue;
    const off=posToOffset(v.pos);
    let x=cx,y=cy,ang=0;
    if(v.d==='N'){x=cx-12;y=cy-off;ang=0}
    else if(v.d==='S'){x=cx+12;y=cy+off;ang=Math.PI}
    else if(v.d==='E'){x=cx+off;y=cy+12;ang=Math.PI/2}
    else{x=cx-off;y=cy-12;ang=-Math.PI/2}
    ctx.save();ctx.translate(x,y);ctx.rotate(ang);
    if(v.emergency){
      ctx.fillStyle=(Math.floor(state.t*4)%2)?'#ff5c70':'#eef5ff';
      ctx.fillRect(-7,-13,14,26);
      ctx.fillStyle='#39d98a';ctx.fillRect(-5,-3,10,6);
    }else{
      ctx.fillStyle=v.d==='N'||v.d==='S'?'#5ec8ff':'#ff9f5e';
      ctx.fillRect(-6,-11,12,22);
      ctx.fillStyle='#dbeafe';ctx.fillRect(-4,-6,8,5);
    }
    ctx.restore();
  }
  ctx.fillStyle='#7fa8ac';ctx.font='11px Segoe UI';ctx.fillText(id,cx-half+4,cy-half+14);
}

function draw(){
  ctx.clearRect(0,0,680,680);
  ctx.fillStyle='#050a10';ctx.fillRect(0,0,680,680);
  for(const id of IDS)drawIntersection(id,state.intersections[id]);
  ctx.fillStyle='#7fa8ac';ctx.font='12px "JetBrains Mono",monospace';
  ctx.fillText(`t = ${state.t.toFixed(1)}s`,10,16);
  ctx.fillText(`mode: ${state.mode}`,10,32);
}

function drawChart(){
  cctx.clearRect(0,0,700,220);
  cctx.fillStyle='#050a10';cctx.fillRect(0,0,700,220);
  cctx.strokeStyle='#1f3d44';cctx.lineWidth=1;
  for(let y=30;y<210;y+=45){cctx.beginPath();cctx.moveTo(35,y);cctx.lineTo(680,y);cctx.stroke()}
  const h=state.historyGlobal;
  if(!h.length)return;
  const max=Math.max(10,...h.map(p=>p.q));
  cctx.strokeStyle='#35e0ff';cctx.lineWidth=3;cctx.beginPath();
  h.forEach((p,i)=>{const x=35+i/(Math.max(1,h.length-1))*640,y=205-p.q/max*165;i?cctx.lineTo(x,y):cctx.moveTo(x,y)});
  cctx.stroke();
  cctx.fillStyle='#7fa8ac';cctx.font='11px "JetBrains Mono",monospace';
  cctx.fillText('Total queued vehicles — whole network',35,18);
  cctx.fillText('0',15,208);cctx.fillText(String(max),8,42);
}

function render(){
  draw();
  const modeBadge=$('modeBadge');
  modeBadge.textContent=state.mode==='adaptive'?'ADAPTIVE MODE':'FIXED-TIME MODE';
  modeBadge.className='badge badge-lg font-bold '+(state.mode==='adaptive'?'badge-primary':'badge-secondary');
  $('intersectionsRow').innerHTML=IDS.map(id=>{
    const s=state.intersections[id];
    const total=['N','E','S','W'].reduce((a,d)=>a+queueCount(s,d),0);
    const badge=s.preempting?' 🚨':(s.pedestrian.active?' 🚶':(s.signalState==='yellow'?' 🟡':''));
    const phaseLabel=s.pedestrian.active?`Crosswalk (${s.pedestrian.side}) — all stop`:(s.signalState==='yellow'?`${phaseName(s)} — yellow`:phaseName(s));
    const countdown=s.signalState==='yellow'?Math.max(0,YELLOW_DURATION-s.amberTimer):Math.max(0,s.phaseDuration-s.phaseTime);
    const ring=s.preempting?'border-error shadow-[0_0_16px_-2px_var(--color-error)]':(s.pedestrian.active?'shadow-[0_0_16px_-2px_rgba(255,255,255,.35)]':(s.signalState==='yellow'?'border-warning shadow-[0_0_16px_-2px_var(--color-warning)]':''));
    return `<div class="tile-card ${ring} rounded-box p-3 text-center transition-colors"><div class="text-primary font-extrabold text-xs mono">${id}${badge}</div><div class="text-xs mt-1">${phaseLabel}</div><div class="text-xs opacity-60 mt-0.5 mono">${countdown.toFixed(1)}s · Q:${total}</div></div>`;
  }).join('');
  $('avgWait').textContent=(state.globalServed?state.globalTotalWait/state.globalServed:0).toFixed(1)+'s';
  $('maxQueue').textContent=state.globalMaxQueue;
  $('throughput').textContent=state.globalServed;
  $('totalDelay').textContent=Math.round(state.globalTotalWait)+'s';
  const activeVehicles=IDS.reduce((a,id)=>a+state.intersections[id].vehicles.length,0);
  $('activeVehicles').textContent=activeVehicles;
  $('pedCrossings').textContent=state.pedCount;
  const preemptCount=IDS.filter(id=>state.intersections[id].preempting).length;
  const emStatus=$('emergencyStatus');
  emStatus.textContent=preemptCount?`${preemptCount} intersection(s) under preemption`:'No active emergency';
  emStatus.className='text-xs mt-1 '+(preemptCount?'text-error font-bold':'opacity-60');
  $('decisions').innerHTML=state.decisions.map(d=>{
    let bars='';
    if(d.ns!==undefined){
      const mx=Math.max(1,d.ns,d.ew);
      bars=`<div class="flex flex-col gap-1 mt-2">
        <div class="flex items-center gap-2 text-[11px] opacity-70"><span class="w-8">N/S</span><progress class="progress progress-info flex-1" value="${d.ns}" max="${mx}"></progress><b>${d.ns}</b></div>
        <div class="flex items-center gap-2 text-[11px] opacity-70"><span class="w-8">E/W</span><progress class="progress progress-accent flex-1" value="${d.ew}" max="${mx}"></progress><b>${d.ew}</b></div>
      </div>`;
    }
    const icon=d.type==='preempt'?'🚨':d.type==='resume'?'✅':d.type==='dispatch'?'🚑':d.type==='pedestrian'?'🚶':d.type==='ped-clear'?'🚦':'🔁';
    return `<div class="tile-card rounded-box p-3">
      <div class="flex justify-between items-center text-xs font-bold mb-1.5"><span class="badge badge-ghost badge-sm">${icon} ${d.id}</span><span class="opacity-50 font-normal mono">${d.t.toFixed(1)}s</span></div>
      <div class="text-xs opacity-70 leading-relaxed">${d.reasoning}</div>${bars}
    </div>`;
  }).join('')||'<div class="text-xs opacity-50">No decisions yet — start the simulation.</div>';
  $('runLabel').textContent=state.running?'Running':'Paused';
  $('runDot').className='inline-block w-2 h-2 rounded-full '+(state.running?'bg-success shadow-[0_0_8px_var(--color-success)]':'bg-base-300');

  drawChart();
}

function loop(ts){
  if(!state.running)return;
  const dt=Math.min(.08,(ts-last)/1000||0);last=ts;
  acc+=dt*state.speed;
  while(acc>.05){tick(.05);acc-=.05}
  render();
  raf=requestAnimationFrame(loop);
}

$('startBtn').onclick=()=>{state.running=!state.running;$('startBtn').textContent=state.running?'Ⅱ Pause':'▶ Start simulation';if(state.running){last=performance.now();raf=requestAnimationFrame(loop)}else cancelAnimationFrame(raf);render()};
$('stepBtn').onclick=()=>{state.running=false;$('startBtn').textContent='▶ Start simulation';tick(.25);render()};
$('resetBtn').onclick=fresh;
$('modeSelect').onchange=()=>{state.mode=$('modeSelect').value;logMsg('NET',`Mode changed to ${state.mode}`);render()};
$('trafficSelect').onchange=()=>{state.traffic=$('trafficSelect').value;state.schedules=buildSchedules(state.traffic,seed);state.stepIndex=0;logMsg('NET',`Traffic profile changed to ${state.traffic}`);render()};
$('speedRange').oninput=()=>state.speed=+$('speedRange').value;
$('emergencyBtn').onclick=()=>{spawnEmergency();render()};
$('pedBtn').onclick=()=>{callPedestrian();render()};

$('compareBtn').onclick=()=>{
  const run=(mode)=>{
    const old=state;seed=42;fresh();
    state.mode=mode;state.traffic=$('trafficSelect').value;state.schedules=buildSchedules(state.traffic,seed);
    for(let i=0;i<1200;i++)tick(.05);
    const result={avg:state.globalServed?state.globalTotalWait/state.globalServed:0,served:state.globalServed};
    state=old;return result;
  };
  const f=run('fixed'),a=run('adaptive');
  $('fixedResult').textContent=f.avg.toFixed(1)+'s avg wait';
  $('adaptiveResult').textContent=a.avg.toFixed(1)+'s avg wait';
  $('improvement').textContent=(f.avg?((f.avg-a.avg)/f.avg*100):0).toFixed(1)+'%';
  $('compareNote').textContent=`Fixed: ${f.served} vehicles exited the network · Adaptive: ${a.served} vehicles exited. Same seed & traffic profile, no emergency vehicles.`;
  render();
};

fresh();
