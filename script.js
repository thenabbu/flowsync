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
// Minimum gap (in the same pos units as STOP_LINE) a queued vehicle keeps
// behind the car ahead of it in the same lane, so a red-light queue renders
// as a visible line of cars instead of every arrival overlapping the last.
const MIN_GAP=38;
// Palette assigned per-vehicle (by id) instead of by travel axis, so the
// network reads as varied real traffic rather than two flat colors.
const CAR_COLORS=['#5ec8ff','#ff9f5e','#a78bfa','#34d399','#f472b6','#fbbf24','#60a5fa','#fb7185'];
// Vehicles leaving the grid at a corner with no connecting road fade out
// over this pos range (430 = edge of the intersection box, 610 = old hard
// despawn point) instead of popping out of existence.
const EXIT_FADE_START=430,EXIT_FADE_END=610;

let state,raf=null,last=0,acc=0,seed=42,nextIdCounter=1;

// --- Aerial map backdrop -----------------------------------------------
// The 2x2 intersection grid leaves a 3x3 pattern of "city blocks" between
// the roads (see CENTERS/TILE_HALF above). We render those as a light
// aerial-map backdrop — parks, a central plaza, building blocks — behind
// the roads, so the network reads like a real live map instead of a bare
// dark grid. Tree/building positions are generated once from a seeded RNG
// (not per frame) so they stay put instead of jittering every redraw.
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function makeTrees(x,y,w,h,n,sd){const rnd=mulberry32(sd),out=[];for(let i=0;i<n;i++)out.push({x:x+10+rnd()*(w-20),y:y+10+rnd()*(h-20),r:3+rnd()*3.2});return out}
function makeBuildings(x,y,w,h,n,sd){const rnd=mulberry32(sd),out=[];for(let i=0;i<n;i++){const bw=16+rnd()*24,bh=16+rnd()*24;out.push({x:x+6+rnd()*Math.max(4,w-bw-12),y:y+6+rnd()*Math.max(4,h-bh-12),w:bw,h:bh})}return out}
const MAP_BLOCKS=[
  {x:0,y:0,w:150,h:150,type:'park',label:'Willow Park'},
  {x:230,y:0,w:220,h:150,type:'building',label:'Civic Institute'},
  {x:530,y:0,w:150,h:150,type:'building',label:'Market Row'},
  {x:0,y:230,w:150,h:220,type:'building',label:'Sector 10'},
  {x:230,y:230,w:220,h:220,type:'plaza',label:''},
  {x:530,y:230,w:150,h:220,type:'building',label:'Sector 11'},
  {x:0,y:530,w:150,h:150,type:'pond-park',label:'Rose Garden'},
  {x:230,y:530,w:220,h:150,type:'building',label:'Foundry Blocks'},
  {x:530,y:530,w:150,h:150,type:'park',label:'Leisure Valley'},
];
MAP_BLOCKS.forEach((b,i)=>{
  b.trees=b.type!=='building'?makeTrees(b.x,b.y,b.w,b.h,b.type==='plaza'?11:7,100+i):[];
  b.buildings=b.type==='building'?makeBuildings(b.x,b.y,b.w,b.h,5,300+i):[];
});
function drawMapBg(){
  ctx.fillStyle='#e7e0ca';ctx.fillRect(0,0,680,680);
  ctx.textAlign='left';
  for(const b of MAP_BLOCKS){
    ctx.save();
    roundRect(ctx,b.x+2,b.y+2,b.w-4,b.h-4,12);ctx.clip();
    if(b.type==='building'){
      ctx.fillStyle='#dad3bc';ctx.fillRect(b.x,b.y,b.w,b.h);
      for(const r of b.buildings){
        ctx.fillStyle='rgba(20,20,15,.10)';ctx.fillRect(r.x+2,r.y+3,r.w,r.h);
        ctx.fillStyle='#b7af96';ctx.fillRect(r.x,r.y,r.w,r.h);
      }
    }else{
      ctx.fillStyle=b.type==='plaza'?'#b9d19d':'#9ec686';
      ctx.fillRect(b.x,b.y,b.w,b.h);
      if(b.type==='pond-park'){
        ctx.fillStyle='#8dc3d9';
        ctx.beginPath();ctx.ellipse(b.x+b.w*0.36,b.y+b.h*0.62,26,15,.3,0,Math.PI*2);ctx.fill();
      }
      if(b.type==='plaza'){
        ctx.strokeStyle='rgba(255,255,255,.35)';ctx.lineWidth=6;ctx.lineCap='round';
        ctx.beginPath();ctx.moveTo(b.x+20,b.y+b.h-20);ctx.quadraticCurveTo(b.x+b.w/2,b.y+b.h/2,b.x+b.w-20,b.y+20);ctx.stroke();
      }
      for(const t of b.trees){
        ctx.fillStyle='rgba(20,30,15,.14)';ctx.beginPath();ctx.arc(t.x+1.5,t.y+2,t.r,0,Math.PI*2);ctx.fill();
        ctx.fillStyle='#5c8c4f';ctx.beginPath();ctx.arc(t.x,t.y,t.r,0,Math.PI*2);ctx.fill();
      }
    }
    ctx.restore();
    if(b.label){
      const align=b.x<=2?'left':(b.x+b.w>=678?'right':'center');
      const lx=align==='left'?b.x+10:(align==='right'?b.x+b.w-10:b.x+b.w/2);
      ctx.textAlign=align;
      ctx.fillStyle='rgba(35,42,30,.7)';ctx.font='600 11px Inter, Segoe UI';
      ctx.fillText(b.label,lx,b.y+18);
    }
  }
  ctx.textAlign='left';
}

function roundRect(c,x,y,w,h,r){
  c.beginPath();
  c.moveTo(x+r,y);
  c.arcTo(x+w,y,x+w,y+h,r);
  c.arcTo(x+w,y+h,x,y+h,r);
  c.arcTo(x,y+h,x,y,r);
  c.arcTo(x,y,x+w,y,r);
  c.closePath();
}

function lcg(s0){let s=s0>>>0;return function(){s=(s*1664525+1013904223)>>>0;return s/4294967296}}

function buildSchedules(profile,baseSeed){
  return SPAWNS.map((sp,idx)=>{
    const rnd=lcg((baseSeed+idx*7919)>>>0);
    const d=sp[1];
    const rate=profile==='rush'?.85:profile==='easy-heavy'?(d==='E'?.95:d==='W'?.65:.25):.22;
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

function phaseName(iState){return ['North','East','South','West'][iState.phase]+' only'}
function greenFor(iState,d){return iState.signalState==='green' && iState.phase===({N:0,E:1,S:2,W:3}[d])}
function isYellowFor(iState,d){return iState.signalState==='yellow' && iState.phase===({N:0,E:1,S:2,W:3}[d])}
function effectiveGreen(iState,d){if(iState.pedestrian&&iState.pedestrian.active)return false;return greenFor(iState,d)}
function queueCount(iState,d){return iState.queues[d].length}

// A single approach gets green at a time. This keeps the intersection simple
// and makes turning movements safe to explain: every incoming lane has its own phase.
function controllerFor(id){
  const iState=state.intersections[id];
  if(iState.preempting||iState.signalState==='yellow')return;
  if(state.mode==='fixed'){iState.phaseDuration=20;return}
  const dirs=['N','E','S','W'];
  const activeDir=dirs[iState.phase];
  const active=queueCount(iState,activeDir);
  const others=dirs.filter(d=>d!==activeDir).map(d=>({d,q:queueCount(iState,d)}));
  const best=others.reduce((a,b)=>b.q>a.q?b:a,{d:activeDir,q:active});
  iState.phaseDuration=Math.max(10,Math.min(30,10+active*1.8));
  if(iState.phaseTime>=10 && best.q>Math.max(1,active)*1.35){
    const reasoning=`${best.d} queue (${best.q}) is ${(best.q/Math.max(1,active)).toFixed(2)}× the ${activeDir} queue (${active}), past the 1.35× threshold after the 10s minimum green → yellow, then switching to ${best.d}.`;
    iState.signalState='yellow';iState.amberTimer=0;
    iState.nextPhase=dirs.indexOf(best.d);
    iState.lastDecision=`${activeDir} yielding — yellow before switching to ${best.d}.`;
    logMsg(id,iState.lastDecision);
    pushDecision({id,type:'switch',t:state.t,reasoning,queues:{N:queueCount(iState,'N'),E:queueCount(iState,'E'),S:queueCount(iState,'S'),W:queueCount(iState,'W')}});
  }
}

function turnOptions(inD){
  // Compass-relative: when travelling N, left=W/right=E; travelling S, left=E/right=W.
  return {
    N:{left:'W',straight:'N',right:'E',uturn:'S'},
    E:{left:'N',straight:'E',right:'S',uturn:'W'},
    S:{left:'E',straight:'S',right:'W',uturn:'N'},
    W:{left:'S',straight:'W',right:'N',uturn:'E'}
  }[inD];
}

function chooseTurn(id,inD){
  const opts=turnOptions(inD);
  // Every turn option is available, including ones that lead off the edge
  // of the grid — a corner intersection has no neighbour in 2 of the 4
  // compass directions, and vehicles need to actually be able to pick those
  // to ever leave the network instead of looping through it forever.
  const entries=Object.entries(opts);
  // Prefer straight, then left/right, with U-turn less common.
  const weights={straight:0.50,left:0.22,right:0.22,uturn:0.06};
  const total=entries.reduce((a,[type])=>a+weights[type],0);
  let r=Math.random()*total;
  for(const [type,outD] of entries){r-=weights[type];if(r<=0)return {type,outD};}
  const [type,outD]=entries[0];return {type,outD};
}

function handleExit(id,v){
  const iState=state.intersections[id];
  iState.served++;iState.totalWait+=v.wait;
  const outD=v.outD||v.d;
  const nb=CONN[id][outD];
  if(nb){addVehicle(nb,outD,0,v.emergency,v.tripWait)}
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
          iState.phase=iState.nextPhase!==undefined?iState.nextPhase:(iState.phase+1)%4;
          iState.nextPhase=undefined;iState.phaseTime=0;iState.signalState='green';iState.amberTimer=0;
          const active=queueCount(iState,['N','E','S','W'][iState.phase]);
          iState.phaseDuration=Math.max(10,Math.min(30,10+active*1.8));
          iState.lastDecision=`Phase changed to ${phaseName(iState)}.`;
          logMsg(id,iState.lastDecision);
        }
      }else{
        if(iState.phaseTime>=iState.phaseDuration){
          iState.signalState='yellow';iState.amberTimer=0;
          iState.nextPhase=(iState.phase+1)%4;
          iState.lastDecision=`${phaseName(iState)} ending — yellow, then switching.`;
          logMsg(id,iState.lastDecision);
        }
        controllerFor(id);
      }
    }
    for(const v of iState.vehicles){
      if(v.passed)continue;
      const green=effectiveGreen(iState,v.d);
      // A vehicle commits either because it reaches the stop line on a green,
      // or because the signal changed while it was already past the stop
      // line (an abrupt preemption/pedestrian call) — too far in to stop
      // safely, so let it clear the junction instead of freezing mid-road.
      if(!v.committed && v.pos>=STOP_LINE-2 && (green||v.pos>STOP_LINE)){
        v.committed=true;
        const choice=chooseTurn(id,v.d);
        v.turnType=choice.type;v.outD=choice.outD;
      }
      // Once committed, the vehicle is allowed through the junction even if
      // the signal changes. Turning animation is rendered from the centre.
      // Non-committed vehicles keep driving at normal speed even on red, so
      // they approach and queue right behind the zebra crossing instead of
      // freezing wherever they happened to be when the light changed — they
      // only actually stop once they reach the stop line itself.
      const mustStop=!green && !v.committed && !v.exiting && v.pos>=STOP_LINE;
      const speed=mustStop?0:.95;
      const nextPos=v.pos+speed*dt*35;
      if(!v.committed && !green && !v.exiting){v.pos=Math.min(nextPos,STOP_LINE)}
      else v.pos=nextPos;
      // Vehicles that have no connected intersection in their outgoing direction
      // keep moving until they visibly leave the entire simulation map.
      if(v.committed && v.pos>=430){
        const outD=v.outD||v.d;
        const nb=CONN[id][outD];
        if(nb){
          v.passed=true;
          handleExit(id,v);
          continue;
        }
        v.exiting=true;
      }
      if(v.exiting && v.pos>=610){
        v.passed=true;
        handleExit(id,v);
        continue;
      }
      if(v.pos>=105&&!green&&!v.committed){v.wait+=dt;v.tripWait+=dt}
    }
    // Enforce a following gap among queued (not-yet-committed) vehicles in
    // each lane so arrivals stack up single-file behind the car ahead
    // rather than occupying the exact same spot.
    for(const d of ['N','E','S','W']){
      const lane=iState.vehicles.filter(v=>v.d===d&&!v.committed&&!v.exiting&&!v.passed);
      lane.sort((a,b)=>b.pos-a.pos);
      for(let i=1;i<lane.length;i++){
        const maxAllowed=lane[i-1].pos-MIN_GAP;
        if(lane[i].pos>maxAllowed)lane[i].pos=maxAllowed;
      }
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
      const reqPhase={N:0,E:1,S:2,W:3}[emVeh.d];
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
            ns2.phase={N:0,E:1,S:2,W:3}[emVeh.d];
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
      pushDecision({id,type:'resume',t:state.t,reasoning:'Emergency vehicle cleared the intersection; normal adaptive control resumes.'});
    }
    if(iState.pedestrian.active){
      iState.pedestrian.timer-=dt;
      if(iState.pedestrian.timer<=0){
        iState.pedestrian.active=false;iState.pedestrian.timer=0;iState.phaseTime=0;
        iState.lastDecision='Crosswalk cleared — vehicles released, signal control resumed.';
        logMsg(id,iState.lastDecision);
        pushDecision({id,type:'resume',t:state.t,reasoning:'Pedestrian crossing completed; vehicle phases resume.'});
      }
    }
  }
  state.globalMaxQueue=Math.max(state.globalMaxQueue,...IDS.map(id=>state.intersections[id].maxQueue));
  state.historyGlobal.push({t:state.t,q:IDS.reduce((a,id)=>a+['N','E','S','W'].reduce((b,d)=>b+queueCount(state.intersections[id],d),0),0)});
  if(state.historyGlobal.length>180)state.historyGlobal.shift();
}

function spawnEmergency(){
  const [id,d]=SPAWNS[Math.floor(Math.random()*SPAWNS.length)];
  addVehicle(id,d,0,true,0);
  logMsg(id,`🚨 Emergency vehicle dispatched, entering grid heading ${d}.`);
  pushDecision({id,type:'dispatch',t:state.t,reasoning:`New emergency vehicle spawned at ${id} heading ${d}. Signals along its path will preempt as it approaches.`});
}

// Triggered by the "Call pedestrian crossing" button. Picks an intersection
// that isn't already mid-crossing or under emergency preemption, forces all
// four approaches to red for PED_DURATION seconds, and logs the decision.
function callPedestrian(){
  const candidates=IDS.filter(id=>{
    const s=state.intersections[id];
    return !s.pedestrian.active && !s.preempting;
  });
  if(!candidates.length){
    logMsg('NET','🚶 Pedestrian call ignored — every intersection is already mid-crossing or under emergency preemption.');
    return;
  }
  const id=candidates[Math.floor(Math.random()*candidates.length)];
  const side=['N','E','S','W'][Math.floor(Math.random()*4)];
  const iState=state.intersections[id];
  iState.pedestrian={active:true,timer:PED_DURATION,side};
  iState.phaseTime=0;
  state.pedCount++;
  iState.lastDecision=`🚶 Pedestrian crossing called on the ${side} side — all approaches stop.`;
  logMsg(id,iState.lastDecision);
  pushDecision({id,type:'pedestrian',t:state.t,reasoning:`Pedestrian requested a walk phase on the ${side} crosswalk — all vehicle phases paused for ${PED_DURATION}s.`});
}

function posToOffset(pos){return ((pos+30)/460)*280-140}

function drawIntersection(id,iState){
  const [cx,cy]=CENTERS[id];
  const half=TILE_HALF,roadHalf=40,boxHalf=35;
  ctx.fillStyle='#33383f';
  ctx.fillRect(cx-roadHalf,cy-half,roadHalf*2,half*2);
  ctx.fillRect(cx-half,cy-roadHalf,half*2,roadHalf*2);
  // Corners of the grid have two approaches with no neighbouring intersection.
  // Fade the road out toward the canvas edge on those approaches so an exiting
  // vehicle looks like it's driving off-frame, not floating over bare canvas.
  for(const d of ['N','E','S','W']){
    if(CONN[id][d])continue;
    let grad;
    ctx.save();
    if(d==='N'){grad=ctx.createLinearGradient(0,cy-half,0,0);grad.addColorStop(0,'#33383f');grad.addColorStop(1,'rgba(51,56,63,0)');ctx.fillStyle=grad;ctx.fillRect(cx-roadHalf,0,roadHalf*2,cy-half);}
    else if(d==='S'){grad=ctx.createLinearGradient(0,cy+half,0,680);grad.addColorStop(0,'#33383f');grad.addColorStop(1,'rgba(51,56,63,0)');ctx.fillStyle=grad;ctx.fillRect(cx-roadHalf,cy+half,roadHalf*2,680-(cy+half));}
    else if(d==='E'){grad=ctx.createLinearGradient(cx+half,0,680,0);grad.addColorStop(0,'#33383f');grad.addColorStop(1,'rgba(51,56,63,0)');ctx.fillStyle=grad;ctx.fillRect(cx+half,cy-roadHalf,680-(cx+half),roadHalf*2);}
    else{grad=ctx.createLinearGradient(cx-half,0,0,0);grad.addColorStop(0,'#33383f');grad.addColorStop(1,'rgba(51,56,63,0)');ctx.fillStyle=grad;ctx.fillRect(0,cy-roadHalf,cx-half,roadHalf*2);}
    ctx.restore();
  }
  ctx.fillStyle='#262a30';
  ctx.fillRect(cx-boxHalf,cy-boxHalf,boxHalf*2,boxHalf*2);
  ctx.strokeStyle=iState.preempting?'#ff5c70':(iState.signalState==='yellow'?'#ffc94a':'#4a5058');
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
  // One approach at a time gets green: N, E, S or W.
  const lightPos={
    N:[cx-14,cy-boxHalf-9,12,6],
    E:[cx+boxHalf+3,cy-2,6,12],
    S:[cx+2,cy+boxHalf+3,12,6],
    W:[cx-boxHalf-9,cy+2,6,12]
  };
  // Small traffic-light housing (dark pill with red/amber/green dots, lit
  // dot bright) at each approach, instead of a single flat colour block.
  for(const d of ['N','E','S','W']){
    const [lx,ly,lw,lh]=lightPos[d];
    const active=lightColor(d);
    const vertical=lh>lw;
    ctx.save();ctx.translate(lx+lw/2,ly+lh/2);
    if(!vertical)ctx.rotate(Math.PI/2);
    roundRect(ctx,-4.5,-8.5,9,17,3);ctx.fillStyle='#1b1f24';ctx.fill();
    const dots=['#ff5c70','#ffc94a','#39d98a'];
    dots.forEach((c,i)=>{
      ctx.beginPath();ctx.arc(0,-5+i*5,1.7,0,Math.PI*2);
      ctx.fillStyle=c===active?c:'rgba(255,255,255,.18)';
      ctx.fill();
    });
    ctx.restore();
  }
  for(const v of iState.vehicles){
    if(v.passed)continue;
    const off=posToOffset(v.pos);
    let x=cx,y=cy,ang=0;
    if(v.committed&&v.turnType&&v.outD&&v.turnType!=='straight'&&v.pos>250){
      // Cubic curve makes left/right/U-turns visible inside the junction.
      const p=Math.max(0,Math.min(1,(v.pos-250)/180));
      const start={N:[cx,cy+30],E:[cx-30,cy],S:[cx,cy-30],W:[cx+30,cy]}[v.d];
      const end={N:[cx,cy-140],E:[cx+140,cy],S:[cx,cy+140],W:[cx-140,cy]}[v.outD];
      const c1=[cx+(start[0]-cx)*0.25,cy+(start[1]-cy)*0.25];
      const c2=[cx+(end[0]-cx)*0.25,cy+(end[1]-cy)*0.25];
      const q=1-p;
      x=q*q*q*start[0]+3*q*q*p*c1[0]+3*q*p*p*c2[0]+p*p*p*end[0];
      y=q*q*q*start[1]+3*q*q*p*c1[1]+3*q*p*p*c2[1]+p*p*p*end[1];
      const tx=3*q*q*(c1[0]-start[0])+6*q*p*(c2[0]-c1[0])+3*p*p*(end[0]-c2[0]);
      const ty=3*q*q*(c1[1]-start[1])+6*q*p*(c2[1]-c1[1])+3*p*p*(end[1]-c2[1]);
      ang=Math.atan2(ty,tx)+Math.PI/2;
    }else{
      if(v.d==='N'){x=cx-12;y=cy-off;ang=0}
      else if(v.d==='S'){x=cx+12;y=cy+off;ang=Math.PI}
      else if(v.d==='E'){x=cx+off;y=cy+12;ang=Math.PI/2}
      else{x=cx-off;y=cy-12;ang=-Math.PI/2}
    }
    const exitAlpha=v.exiting?Math.max(0,1-(v.pos-EXIT_FADE_START)/(EXIT_FADE_END-EXIT_FADE_START)):1;
    ctx.save();ctx.translate(x,y);ctx.rotate(ang);ctx.globalAlpha=exitAlpha;
    if(v.emergency){
      ctx.fillStyle='rgba(0,0,0,.35)';roundRect(ctx,-6,-10,14,26,3);ctx.fill();
      ctx.fillStyle=(Math.floor(state.t*4)%2)?'#ff5c70':'#eef5ff';
      roundRect(ctx,-7,-13,14,26,3);ctx.fill();
      ctx.fillStyle='#39d98a';roundRect(ctx,-5,-3,10,6,1.5);ctx.fill();
    }else{
      ctx.fillStyle='rgba(0,0,0,.35)';roundRect(ctx,-6,-9,12,22,3);ctx.fill();
      ctx.fillStyle=CAR_COLORS[v.id%CAR_COLORS.length];
      roundRect(ctx,-6,-11,12,22,3);ctx.fill();
      ctx.fillStyle='#dbeafe';roundRect(ctx,-4,-6,8,5,1.5);ctx.fill();
    }
    ctx.restore();
  }
}

function draw(){
  ctx.clearRect(0,0,680,680);
  drawMapBg();
  for(const id of IDS)drawIntersection(id,state.intersections[id]);
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
    if(d.queues){
      const mx=Math.max(1,d.queues.N,d.queues.E,d.queues.S,d.queues.W);
      bars=`<div class="grid grid-cols-2 gap-x-3 gap-y-1 mt-2">${['N','E','S','W'].map(x=>`<div class="flex items-center gap-1 text-[11px] opacity-70"><span class="w-3">${x}</span><progress class="progress progress-info flex-1" value="${d.queues[x]}" max="${mx}"></progress><b>${d.queues[x]}</b></div>`).join('')}</div>`;
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

// --- Map overlay bar: segmented buttons mirror the (hidden) native
// selects, so the simulation logic above is untouched — clicking a
// segment just sets the select's value and fires its existing change
// handler.
function syncMapBar(){
  document.querySelectorAll('#modeSeg .seg-btn').forEach(b=>b.classList.toggle('active',b.dataset.mode===$('modeSelect').value));
  document.querySelectorAll('#trafficSeg .seg-btn').forEach(b=>b.classList.toggle('active',b.dataset.traffic===$('trafficSelect').value));
  const label=$('signalsLabel');
  if(label)label.textContent=$('modeSelect').value==='adaptive'?'Adaptive Signals':'Fixed-Time Signals';
}
document.querySelectorAll('#modeSeg .seg-btn').forEach(b=>b.onclick=()=>{$('modeSelect').value=b.dataset.mode;$('modeSelect').dispatchEvent(new Event('change'));syncMapBar()});
document.querySelectorAll('#trafficSeg .seg-btn').forEach(b=>b.onclick=()=>{$('trafficSelect').value=b.dataset.traffic;$('trafficSelect').dispatchEvent(new Event('change'));syncMapBar()});
syncMapBar();

fresh();
