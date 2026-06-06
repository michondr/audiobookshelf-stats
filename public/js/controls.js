// Input wiring. Desktop: wheel / ▲▼ zoom, ◄► pan, shift+wheel native pan. Phone: vertical swipe
// zoom (up = in), horizontal drag = native scroll with settle-snap, tap a month to dive in.
import { S, D, isPhone } from './state.js';
import { applyZoom, setZoom, stepLevel, panBy, snapToNearestSet, enterMonthly, jumpToMonthCovers, setLevelActive, currentMonthIndex, setOnLevelChange } from './zoom.js';
import { sizeMonthly } from './monthly.js';
import { esc, MONTH } from './format.js';
import { drawAndShare } from './share.js';

// mobile: a day's books -> a modal to open one in Audiobookshelf
function openAbsModal(cell){
  const absBase=(S.data&&S.data.absBase)||''; if(!absBase) return false;
  let list=[]; try{ list=JSON.parse(cell.dataset.books||'[]'); }catch{}
  if(!list.length) return false;
  D.abslist.innerHTML=list.map(b=>
    '<a class="absitem" href="'+esc(absBase)+'/item/'+encodeURIComponent(b.i)+'" target="_blank" rel="noopener">'+
      (b.img ? '<img class="aci" src="'+esc(b.img)+'" alt="" loading="lazy" onerror="this.remove()">' : '<div class="aci aciph"></div>')+
      '<div class="acmeta"><div class="act">'+esc(b.t)+'</div>'+(b.a?'<div class="aca">'+esc(b.a)+'</div>':'')+'</div>'+
      '<span class="acgo">↗</span>'+
    '</a>'
  ).join('');
  D.absmodal.classList.add('show');
  return true;
}
function closeAbsModal(){ D.absmodal.classList.remove('show'); }

export function initControls(){
  // ----- desktop: wheel zoom -----
  D.scroller.addEventListener('wheel',(e)=>{
    if(e.shiftKey) return;                 // shift+wheel = native horizontal pan
    e.preventDefault();
    if(S.monthlyView){ if(e.deltaY<0) stepLevel(1); return; }   // zoom in leaves monthly
    if(e.deltaY>0 && S.cw<=7.5){ enterMonthly(); return; }      // zoom out at the floor -> monthly
    const focalX=e.clientX-D.scroller.getBoundingClientRect().left;
    setZoom(S.cw*(e.deltaY<0?1.15:1/1.15), focalX);
  },{passive:false});

  // ----- desktop: keyboard -----
  document.addEventListener('keydown',(e)=>{
    if(e.key==='ArrowUp'||e.key==='ArrowDown'){ e.preventDefault(); stepLevel(e.key==='ArrowUp'?1:-1); }
    else if(e.key==='ArrowLeft'||e.key==='ArrowRight'){ e.preventDefault(); panBy(e.key==='ArrowRight'?1:-1); }
    else if(e.key==='Home'||e.key==='End'){            // jump to oldest / today
      if(S.monthlyView) return;
      e.preventDefault();
      D.scroller.scrollTo({left: e.key==='Home'?0:D.scroller.scrollWidth, behavior:'smooth'});
    }
  });

  // ----- buttons (both platforms) -----
  D.zin.onclick=()=>stepLevel(1);
  D.zout.onclick=()=>stepLevel(-1);

  // ----- year grid: tap a month -> dive into its covers -----
  D.monthly.addEventListener('click',(e)=>{
    const cell=e.target.closest('.mcell[data-y]');
    if(cell) jumpToMonthCovers(+cell.dataset.y, +cell.dataset.m);
  });

  window.addEventListener('resize',()=>{ applyZoom(); if(S.monthlyView) sizeMonthly(); });

  // click a day at Covers/Compact/Detail (desktop + mobile) -> open-in-ABS modal
  D.grid.addEventListener('click', (e)=>{
    if(!setLevelActive()) return;
    const cell=e.target.closest('.cell');
    if(cell) openAbsModal(cell);
  });
  // ABS modal close: backdrop, cancel, or after picking a book
  D.absback.addEventListener('click', closeAbsModal);
  D.abscancel.addEventListener('click', closeAbsModal);
  D.abslist.addEventListener('click', (e)=>{ if(e.target.closest('.absitem')) closeAbsModal(); });

  if(isPhone) initShareBtn();
  if(isPhone) initTouch();
}

function updateShareLabel(){
  const i = currentMonthIndex();
  const key = S.monthKeys[i];
  if (!key || !D.sharemon) return;
  const [y, mo] = key.split('-').map(Number);
  D.sharemon.textContent = MONTH[mo] + ' ' + y;
}

function initShareBtn(){
  setOnLevelChange(n => { if(n===2) updateShareLabel(); });
  D.scroller.addEventListener('scroll', updateShareLabel, {passive:true});

  D.sharebtn.addEventListener('click', async () => {
    const i = currentMonthIndex();
    const key = S.monthKeys[i];
    if (!key) return;
    D.sharebtn.disabled = true;
    const prev = D.sharemon.textContent;
    D.sharemon.textContent = '…';
    try { await drawAndShare(key); } catch(e) { console.error('share:', e); }
    D.sharebtn.disabled = false;
    D.sharemon.textContent = prev;
  });
}

// ----- phone: swipe to zoom (vertical) / scroll-through with settle-snap (horizontal) -----
function initTouch(){
  let sx=0, sy=0, axis=null, zoomed=false, stepped=false;
  const STEP=70;    // vertical px per one zoom level
  const SWIPE=36;   // horizontal px to jump one set (Covers month / Detail week)
  const onStart=(e)=>{ const t=e.touches[0]; sx=t.clientX; sy=t.clientY; axis=null; zoomed=false; stepped=false; };
  const onMove=(e)=>{
    const t=e.touches[0], dx=t.clientX-sx, dy=t.clientY-sy;
    // Lock the gesture axis once it's moved enough. Bias HARD toward horizontal (side-scroll through
    // time is the common gesture) — only treat it as a zoom when the swipe is clearly vertical.
    if(!axis){
      if(Math.abs(dx)<8 && Math.abs(dy)<8) return;
      axis = (Math.abs(dy) > Math.abs(dx)*1.7) ? 'v' : 'h';
    }
    if(axis==='v'){
      e.preventDefault();                    // vertical = zoom, not page scroll
      if(!zoomed && Math.abs(dy)>=STEP){ zoomed=true; stepLevel(dy<0?1:-1); }   // swipe up = zoom in
    } else if(setLevelActive()){
      // Covers/Detail: a SHORT horizontal swipe jumps exactly one set (no long drag needed)
      e.preventDefault();
      if(!stepped && Math.abs(dx)>=SWIPE){ stepped=true; panBy(dx<0?1:-1); }
    }
    // heatmap horizontal: let native scroll run free
  };
  const onEnd=()=>{
    // a tap (no axis lock) falls through to the native click, which opens the modal (see grid click
    // handler) — opening on click avoids the touch "ghost click" that flickered the modal closed.
    if(axis==='h' && !stepped) snapToNearestSet();
    axis=null;
  };
  for(const el of [D.board, D.monthly]){
    el.addEventListener('touchstart', onStart, {passive:true});
    el.addEventListener('touchmove',  onMove,  {passive:false});
    el.addEventListener('touchend',   onEnd,   {passive:true});
  }
  // also settle-snap after a free momentum scroll that wasn't a deliberate swipe
  let st=null;
  D.scroller.addEventListener('scroll',()=>{ clearTimeout(st); st=setTimeout(snapToNearestSet,140); }, {passive:true});
}
