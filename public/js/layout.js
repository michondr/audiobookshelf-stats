// Month-block column layout + all the pixel<->position math used by zoom/pan/snap.
import { S, D, isPhone } from './state.js';

export const GAP = 3;

// ----- month-block column layout (used in Compact + Detail) -----
// Each month is its own block of week-columns (with leading/trailing blanks for partial weeks),
// separated by a thin (¼ / ½ cell) gap — regardless of which weekday the month starts on.
export function computeMonthBlocks(){
  const bt=S.blockTracks, ct=S.cellTracks, ms=S.months;
  bt.length=0; ct.length=0; ms.length=0;
  for(const k in S.monthBase) delete S.monthBase[k];
  for(const k in S.monthIndex) delete S.monthIndex[k];
  const lastDate=new Date(S.start); lastDate.setDate(S.start.getDate()+S.WEEKS*7-1);
  let m=new Date(S.start.getFullYear(), S.start.getMonth(), 1);
  const endM=new Date(lastDate.getFullYear(), lastDate.getMonth(), 1);
  let first=true;
  while(m<=endM){
    const firstDow=(m.getDay()+6)%7;
    const dim=new Date(m.getFullYear(), m.getMonth()+1, 0).getDate();
    const weeks=Math.ceil((firstDow+dim)/7);
    if(!first) bt.push('gapthin');
    S.monthBase[m.getFullYear()+'-'+m.getMonth()]=bt.length;
    S.monthIndex[m.getFullYear()+'-'+m.getMonth()]=ms.length;
    ms.push({base:bt.length, weeks});
    for(let i=0;i<weeks;i++) bt.push('cell');
    first=false;
    m=new Date(m.getFullYear(), m.getMonth()+1, 1);
  }
  for(let i=0;i<bt.length;i++) if(bt[i]==='cell') ct.push(i);
}
export function blockColFor(d){
  const fd=(new Date(d.getFullYear(),d.getMonth(),1).getDay()+6)%7;
  return S.monthBase[d.getFullYear()+'-'+d.getMonth()] + Math.floor((d.getDate()-1+fd)/7);
}
export function tracksBefore(idx){ let c=0,t=0; for(let i=0;i<idx;i++){ if(S.blockTracks[i]==='gapthin') t++; else c++; } return {c,t}; }
export function blockTemplate(){ return S.blockTracks.map(x=> x==='gapthin'?'var(--thingap)':'var(--cw)').join(' '); }

// ----- viewport-derived zoom metrics -----
export function metrics(){
  const sw=D.scroller.clientWidth;
  const cwForCols=c=>Math.max(40, Math.floor(sw/c) - GAP);   // cw at which `c` week-columns span the viewport
  const maxCh=Math.max(40, Math.floor((D.scroller.clientHeight - 20 /*monthsbar*/ - 6*GAP - 4) / 7));
  return {
    maxCh,                                        // height cap so all 7 weekday rows fit; past it the cell goes wide
    // max zoom: desktop = two week-columns; phone = one week ≈ full viewport width (Detail set)
    maxCw: Math.max(200, isPhone ? (sw-12) : Math.floor((sw-GAP)/2)),
    cwCompact: Math.max(maxCh+1, cwForCols(6.5)), // Compact cell width (wide enough for a 2-book day)
    cw45: cwForCols(4.5),                         // boundary between Compact and Full detail
  };
}

// ----- block-mode (Compact/Detail) pixel math -----
export function blockXFor(cellsBefore, thinBefore, cwv, thinv){ return cellsBefore*(cwv+GAP) + thinBefore*(thinv*cwv+GAP); }
export function weekBlockX(w, cwv, thinv){ const tb=tracksBefore(S.weekBlockCol[w]); return blockXFor(tb.c, tb.t, cwv, thinv); }
export function nearestWeekToX(x, cwv, thinv){ let best=0,bd=Infinity; for(let w=0;w<S.WEEKS;w++){ const d=Math.abs(weekBlockX(w,cwv,thinv)-x); if(d<bd){bd=d;best=w;} } return best; }
export function monthCenterX(i, cwv, thinv){ const mo=S.months[i], tb=tracksBefore(mo.base); return blockXFor(tb.c, tb.t, cwv, thinv) + (mo.weeks*cwv + (mo.weeks-1)*GAP)/2; }
export function nearestMonthToX(x, cwv, thinv){ let best=0,bd=Infinity; for(let i=0;i<S.months.length;i++){ const d=Math.abs(monthCenterX(i,cwv,thinv)-x); if(d<bd){bd=d;best=i;} } return best; }

// ----- continuous-stream (Finished/Covers) pixel math -----
// dataset.cont = the week column a month begins on (months share boundary weeks in the stream).
export function monthContStart(i){ return +S.monthEls[i].dataset.cont; }
export function monthOfWeek(w){ let mi=0; for(let i=0;i<S.monthEls.length;i++){ if(monthContStart(i)<=w) mi=i; else break; } return mi; }
// week (continuous-stream column) containing date d; per-day rounding absorbs DST hour shifts
export function weekOfDate(d){ return Math.floor(Math.round((d-S.start)/864e5)/7); }
export function monthCenterXCont(i, cwv, shiftv){
  // centre of the month's VISUAL span — its first day's week through its last day's week — so
  // months that start mid-week (whose first cells sit in the previous month's boundary column,
  // pushed right by the fracture shift) come out centred rather than half a column off.
  const [y,mo]=S.monthKeys[i].split('-').map(Number);
  const wf=Math.max(0, weekOfDate(new Date(y,mo,1)));
  const wl=Math.min(S.WEEKS-1, weekOfDate(new Date(y,mo+1,0)));
  return ((wf+wl)/2)*(cwv+GAP) + cwv/2 + i*shiftv;
}
export function nearestMonthToXCont(x, cwv, shiftv){ let best=0,bd=Infinity; for(let i=0;i<S.monthEls.length;i++){ const d=Math.abs(monthCenterXCont(i,cwv,shiftv)-x); if(d<bd){bd=d;best=i;} } return best; }
// fracture amount per month for the continuous stream: slight gap at the Finished level, opening
// to ~1.1cw by the top of Covers, where it hands off to the block gap.
export function monthGap(cwv, m){
  if(cwv < 22 || S.monthEls.length<2) return 0;                     // Overview/Intensity stay continuous
  const t = Math.min(1, (cwv - 22) / Math.max(1, m.maxCh - 22));    // 0 at Finished → 1 at top of Covers
  return Math.round(cwv * (0.18 + 0.95*t));
}

// ----- day-column (week) math for Detail navigation -----
export function colCenterX(k, cwv, thinv){ const tb=tracksBefore(S.cellTracks[k]); return blockXFor(tb.c, tb.t, cwv, thinv) + cwv/2; }
export function nearestColToX(x, cwv, thinv){ let best=0,bd=Infinity; for(let k=0;k<S.cellTracks.length;k++){ const d=Math.abs(colCenterX(k,cwv,thinv)-x); if(d<bd){bd=d;best=k;} } return best; }

// ----- continuous pixel<->track-position mapping in block mode (non-uniform pitch) -----
function trackWidth(i, cwv, thinv){ return (S.blockTracks[i]==='gapthin'?thinv*cwv:cwv); }
export function xToTrackPos(x, cwv, thinv){
  let acc=0;
  for(let i=0;i<S.blockTracks.length;i++){ const w=trackWidth(i,cwv,thinv)+GAP; if(x<acc+w) return i+Math.max(0,Math.min(1,(x-acc)/w)); acc+=w; }
  return S.blockTracks.length;
}
export function trackPosToX(p, cwv, thinv){
  const i=Math.min(Math.floor(p), Math.max(0,S.blockTracks.length-1)), frac=p-i;
  let acc=0; for(let j=0;j<i;j++) acc+=trackWidth(j,cwv,thinv)+GAP;
  return acc+frac*(trackWidth(i,cwv,thinv)+GAP);
}
