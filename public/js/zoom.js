// The zoom engine: discrete stages, focal-anchored continuous zoom, month/week panning,
// and the Level-0 (year grid) toggle.
import { S, D, isPhone } from './state.js';
import {
  GAP, metrics, blockTemplate, blockXFor, blockColFor,
  monthGap, monthOfWeek, nearestWeekToX, monthCenterX, nearestMonthToX,
  monthCenterXCont, nearestMonthToXCont, colCenterX, nearestColToX,
  xToTrackPos, trackPosToX, weekOfDate,
} from './layout.js';
import { buildMonthly } from './monthly.js';

// Displayed levels 1..5 (Level 0 is the separate year grid). cls = stage CSS class (z1..z5).
const STAGE_META=[
  {cls:'z1', lvl:'1', name:'Heatmap'},
  {cls:'z2', lvl:'2', name:'Finished'},
  {cls:'z3', lvl:'3', name:'Covers'},
  {cls:'z4', lvl:'4', name:'Compact'},
  {cls:'z5', lvl:'5', name:'Full detail'},
];
function stageNum(v, m){
  if(v<22) return 0;                // heatmap (floor)
  if(v<33) return 1;                // + finished
  if(v<=m.maxCh) return 2;          // square covers
  if(v < m.cw45) return 3;          // wide compact card
  return 4;                          // wide full-detail card
}
function levelTargetCw(n, m){        // where arrows/buttons snap for each level
  switch(n){
    case 0: return 16;
    case 1: return 28;
    case 2: {                                  // covers
      if(!isPhone) return Math.max(40, Math.round(m.maxCh*0.7));
      // phone: shrink (~25%) so the widest whole month fits the screen width
      const maxWk=S.months.reduce((a,b)=>Math.max(a,b.weeks),5);
      const fit=Math.floor(D.scroller.clientWidth/maxWk) - GAP;
      return Math.max(40, Math.min(Math.round(m.maxCh*0.75), fit));
    }
    case 3: return m.cwCompact;
    default: return isPhone ? Math.max(m.cw45+1, m.maxCw) : m.maxCw;           // detail; phone ≈ full width
  }
}

function setLabel(text, px){ D.zlname.textContent=text; D.zlpx.textContent=px||''; }

function relayoutMonths(){
  const pitch=S.cw+GAP;
  for(const el of S.monthEls){
    el.style.left=((S.blocksMode ? blockXFor(+el.dataset.cb, +el.dataset.tb, S.cw, S.thinFactor)
                                 : (+el.dataset.cont)*pitch + (+el.dataset.mi)*S.monthShift) + S.padX)+'px';
  }
}
function setMode(toBlocks){
  // cells already carry both columns (--cc/--cb); CSS picks via the .blocks class, so this is O(1)
  D.grid.classList.toggle('blocks', toBlocks);
  D.grid.style.gridTemplateColumns = toBlocks ? blockTemplate() : '';
  S.blocksMode=toBlocks;
}

export function applyZoom(){
  if(S.monthlyView){ setLabel('Level 0 · Months',''); return; }
  const m=metrics();
  S.ch = Math.min(S.cw, m.maxCh);   // never taller than wide
  const root=document.documentElement.style;
  root.setProperty('--cw',S.cw+'px');
  root.setProperty('--ch',S.ch+'px');
  const n=stageNum(S.cw,m), wide=S.cw>m.maxCh;
  if(n!==S.appliedLevel || wide!==S.appliedWide){
    D.stage.className='stage '+STAGE_META[n].cls+(wide?' wide':'');
    if(n!==S.appliedLevel){
      setLabel('Level '+STAGE_META[n].lvl+' · '+STAGE_META[n].name, Math.round(S.cw)+'px');
      S.thinFactor = (n===4)?0.25:0.5;                   // thin month-gap: ¼ cell in detail, ½ in compact
      if(n>=3) D.grid.style.setProperty('--thingap','calc(var(--cw) * '+S.thinFactor+')');
      document.body.classList.toggle('lvl-covers', n===2);
      if(_onLevelChange) _onLevelChange(n);
    }
    S.appliedLevel=n; S.appliedWide=wide;
  }
  document.body.classList.toggle('lvl-heatmap', n<=1);   // gates the phone usage-info band
  // continuous-mode month fracture (Heatmap–Covers); block mode (Compact/Detail) uses real gap tracks.
  S.monthShift = (n>=3) ? 0 : monthGap(S.cw, m);
  D.grid.style.setProperty('--mgap', S.monthShift+'px');
  // From Covers up, pad both ends by half the viewport so the first/last month can be centered.
  S.padX = (n>=2) ? Math.round(D.scroller.clientWidth/2) : 0;
  D.grid.style.paddingLeft = S.padX+'px';
  D.grid.style.paddingRight = ((S.monthShift>0 ? (S.monthEls.length-1)*S.monthShift : 0) + S.padX)+'px';
  D.zlpx.textContent=Math.round(S.cw)+'px';
  relayoutMonths();
}

export function setZoom(next, focalX){
  const oldCw=S.cw, oldMode=S.blocksMode, oldThin=S.thinFactor, oldShift=S.monthShift, oldPad=S.padX;
  const cx=D.scroller.scrollLeft+focalX-oldPad;   // content-coordinate point under the cursor
  // continuous-stream week under the cursor, undoing the old fracture shift (negligible in block mode)
  const contWeekAt=(x,cwv,shiftv)=>{ let w=Math.round(x/(cwv+GAP)); return Math.round((x - monthOfWeek(Math.max(0,w))*shiftv)/(cwv+GAP)); };
  const m=metrics();
  S.cw=Math.max(7, Math.min(m.maxCw, next));
  const newMode = stageNum(S.cw,m)>=3;
  applyZoom();
  if(newMode!==oldMode){
    // re-anchor across the layout change.
    const focalWeek = oldMode ? nearestWeekToX(cx, oldCw, oldThin) : contWeekAt(cx, oldCw, oldShift);
    setMode(newMode);
    relayoutMonths();
    if(newMode){
      D.scroller.scrollLeft = monthCenterX(monthOfWeek(Math.max(0,focalWeek)), S.cw, S.thinFactor) - focalX + S.padX;
    } else {
      const nx = focalWeek*(S.cw+GAP) + monthOfWeek(Math.max(0,focalWeek))*S.monthShift;
      D.scroller.scrollLeft = nx + S.cw/2 - focalX + S.padX;
    }
  } else if(S.blocksMode){
    // same (block) mode, but cw and/or the thin-gap width may have changed (Compact <-> Detail)
    D.scroller.scrollLeft = trackPosToX(xToTrackPos(cx, oldCw, oldThin), S.cw, S.thinFactor) - focalX + S.padX;
  } else {
    // continuous mode
    const w=contWeekAt(cx, oldCw, oldShift), mi=monthOfWeek(Math.max(0,w));
    if(stageNum(S.cw,m)===2 && stageNum(oldCw,m)<2){
      D.scroller.scrollLeft = monthCenterXCont(mi, S.cw, S.monthShift) - focalX + S.padX;
    } else {
      const baseColPos=(cx - mi*oldShift)/(oldCw+GAP);
      D.scroller.scrollLeft = baseColPos*(S.cw+GAP) + mi*S.monthShift - focalX + S.padX;
    }
  }
}

let _onLevelChange=null;
export function setOnLevelChange(fn){ _onLevelChange=fn; }
export function currentMonthIndex(){
  const half=D.scroller.clientWidth/2;
  const centerX=D.scroller.scrollLeft+half-S.padX;
  return nearestMonthToXCont(centerX, S.cw, S.monthShift);
}

let anim=null;
export function animateZoom(target, focalX){
  cancelAnimationFrame(anim);
  target=Math.max(7, Math.min(metrics().maxCw, target));
  const startCw=S.cw, t0=performance.now(), dur=320;
  function step(now){
    const k=Math.min(1,(now-t0)/dur);
    const e=k<0.5 ? 2*k*k : 1-Math.pow(-2*k+2,2)/2;   // easeInOutQuad
    setZoom(startCw+(target-startCw)*e, focalX);
    if(k<1) anim=requestAnimationFrame(step);
  }
  anim=requestAnimationFrame(step);
}

// ----- Level-0 (year grid) toggle -----
export function enterMonthly(){
  S.monthlyView=true;
  buildMonthly();
  document.body.classList.add('monthly');
  document.body.classList.remove('lvl-heatmap');
  setLabel('Level 0 · Months','');
}
export function exitMonthly(){
  S.monthlyView=false;
  document.body.classList.remove('monthly');
  const m=metrics();
  S.cw=levelTargetCw(0,m);
  applyZoom();
}
// tap a month in the year grid -> open it at Covers, centered
export function jumpToMonthCovers(y, mo){
  S.monthlyView=false;
  document.body.classList.remove('monthly');
  const m=metrics();
  S.cw=levelTargetCw(2,m);
  applyZoom();
  const i=S.monthIndex[y+'-'+mo];
  if(i!=null){
    D.scroller.scrollLeft = monthCenterXCont(i, S.cw, S.monthShift) - D.scroller.clientWidth/2 + S.padX;
  }
}

function todayViewportX(){
  let contentX;
  if(S.blocksMode){
    contentX = colCenterX(todayCol(), S.cw, S.thinFactor);
  } else {
    const w=weekOfDate(S.today), mi=S.monthIndex[S.today.getFullYear()+'-'+S.today.getMonth()]||0;
    contentX = w*(S.cw+GAP) + mi*S.monthShift + S.cw/2;
  }
  return contentX - D.scroller.scrollLeft + S.padX;
}

export function stepLevel(dir){
  const m=metrics();
  if(S.monthlyView){ if(dir>0) exitMonthly(); return; }    // zoom in leaves monthly; further out = no-op
  const cur=stageNum(S.cw,m);
  if(dir<0 && cur===0){ enterMonthly(); return; }          // zoom out from Heatmap -> monthly
  let ni=cur+dir;
  if(isPhone && ni===3) ni+=dir;                           // phone skips Compact
  ni=Math.max(0, Math.min(STAGE_META.length-1, ni));
  // When zooming in, anchor on today if it's visible; otherwise fall back to viewport centre.
  const half=D.scroller.clientWidth/2;
  const vx=dir>0 ? todayViewportX() : half;
  const focalX=(dir>0 && vx>=0 && vx<=D.scroller.clientWidth) ? vx : half;
  animateZoom(levelTargetCw(ni,m), focalX);
}

// the timeline renders ghost cells through the end of the current month, so snapping/stepping
// must stop at today's set, not the grid's last (future) column / month block.
function todayCol(){ const k=S.cellTracks.indexOf(blockColFor(S.today)); return k<0 ? S.cellTracks.length-1 : k; }
function todayMonthBlock(){ const i=S.monthIndex[S.today.getFullYear()+'-'+S.today.getMonth()]; return i==null ? S.months.length-1 : i; }

// step one "set" left/right and snap it to centre (desktop arrows + phone discrete swipe)
export function panBy(dir){
  if(S.monthlyView) return;
  const m=metrics(), n=stageNum(S.cw,m), half=D.scroller.clientWidth/2, centerX=D.scroller.scrollLeft+half-S.padX;
  let left;
  if(n===4){           // Detail: step one week-column
    const k=Math.max(0, Math.min(todayCol(), nearestColToX(centerX, S.cw, S.thinFactor)+dir));
    left=colCenterX(k, S.cw, S.thinFactor)-half+S.padX;
  } else if(n===3){    // Compact: step one month block
    const i=Math.max(0, Math.min(todayMonthBlock(), nearestMonthToX(centerX, S.cw, S.thinFactor)+dir));
    left=monthCenterX(i, S.cw, S.thinFactor)-half+S.padX;
  } else if(n===2){    // Covers: step one month (continuous stream)
    const i=Math.max(0, Math.min(S.monthEls.length-1, nearestMonthToXCont(centerX, S.cw, S.monthShift)+dir));
    left=monthCenterXCont(i, S.cw, S.monthShift)-half+S.padX;
  } else {             // heatmap levels: plain pan by ~one screen
    left=D.scroller.scrollLeft + dir*D.scroller.clientWidth*0.85;
  }
  D.scroller.scrollTo({left, behavior:'smooth'});
}

// snap to the NEAREST set centre (phone settle-snap after a free drag). No-op on heatmap levels.
export function snapToNearestSet(){
  if(S.monthlyView) return;
  const m=metrics(), n=stageNum(S.cw,m), half=D.scroller.clientWidth/2, centerX=D.scroller.scrollLeft+half-S.padX;
  let left=null;
  if(n===4){ const k=Math.min(todayCol(), nearestColToX(centerX, S.cw, S.thinFactor)); left=colCenterX(k, S.cw, S.thinFactor)-half+S.padX; }
  else if(n===3){ const i=Math.min(todayMonthBlock(), nearestMonthToX(centerX, S.cw, S.thinFactor)); left=monthCenterX(i, S.cw, S.thinFactor)-half+S.padX; }
  else if(n===2){ const i=nearestMonthToXCont(centerX, S.cw, S.monthShift); left=monthCenterXCont(i, S.cw, S.monthShift)-half+S.padX; }
  if(left!=null) D.scroller.scrollTo({left, behavior:'smooth'});
}

// true when the current level snaps to a "set" (Covers month / Compact month / Detail week) —
// used by the phone controls to turn a short horizontal swipe into a one-set jump.
export function setLevelActive(){ return !S.monthlyView && stageNum(S.cw, metrics())>=2; }

// "Now" button: jump instantly to Detail level centered on today's week.
export function jumpToNow(){
  if(S.monthlyView){
    S.monthlyView=false;
    document.body.classList.remove('monthly');
  }
  const m=metrics();
  S.cw=levelTargetCw(4,m);                   // Full Detail (phone ≈ full viewport width)
  const wasBlocks=S.blocksMode;
  applyZoom();                                // sets thinFactor, padX, relayouts months (in old mode)
  if(!wasBlocks){ setMode(true); relayoutMonths(); }  // switch grid + reposition month labels
  scrollTodayToCenter();
}

// Centre today's week in the viewport. Accepts optional smooth flag (End key / Now button).
export function scrollTodayToCenter(smooth){
  if(S.monthlyView) return;
  const half=D.scroller.clientWidth/2;
  let left;
  if(S.blocksMode){
    left = colCenterX(todayCol(), S.cw, S.thinFactor) - half + S.padX;
  } else {
    const w=weekOfDate(S.today), mi=S.monthIndex[S.today.getFullYear()+'-'+S.today.getMonth()]||0;
    left = w*(S.cw+GAP) + mi*S.monthShift + S.cw/2 - half + S.padX;
  }
  D.scroller.scrollTo({left, behavior: smooth ? 'smooth' : 'auto'});
}

export { stageNum };
