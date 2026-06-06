// Builds the day-timeline grid (levels 1–5) from /api/data.
import { S, D } from './state.js';
import { MONTH, hms, md, parseDate, keyOf, esc } from './format.js';
import { computeMonthBlocks, blockColFor, tracksBefore } from './layout.js';

function renderDay(cell, list, books){
  const sessions=list.map(s=>{
    const b=books[s.id]||{};
    return {id:s.id, t:b.t||'(unknown)', a:b.a||'', img:b.img||'', from:s.from, to:s.to, fin:s.fin, secs:s.secs, started:s.started};
  });
  const total=sessions.reduce((s,x)=>s+x.secs,0);
  cell.classList.add(total>9000?'l4':total>5400?'l3':total>2700?'l2':'l1');
  if(sessions.length>1) cell.classList.add('multi');

  // Compact/Detail show at most MAX book cards (the same two that appear in the cover crossfade);
  // the rest collapse into a "+N" chip you hover.
  const MAX=2;
  const shown=sessions.slice(0,MAX);
  const extra=sessions.slice(MAX);

  const booksEl=document.createElement('div'); booksEl.className='books';
  for(const s of shown){
    const bk=document.createElement('div'); bk.className='book'+(s.fin?' fin':'');
    if(s.img){
      const cov=document.createElement('img');
      cov.className='cover'; cov.src=s.img; cov.alt=s.t; cov.loading='lazy'; cov.decoding='async';
      cov.onerror=()=>{ bk.classList.add('nocover'); cov.remove(); };   // deleted-book cover: fall back to placeholder
      bk.appendChild(cov);
    } else { bk.classList.add('nocover'); }
    const ph=document.createElement('div'); ph.className='ph'; ph.innerHTML='<span>'+esc(s.t)+'</span>';
    bk.appendChild(ph);
    const info=document.createElement('div'); info.className='info';
    info.innerHTML =
      '<div class="ihead">'+
        '<div class="imeta"><div class="t">'+esc(s.t)+'</div><div class="a">'+esc(s.a)+'</div></div>'+
        '<div class="iright"><div class="started">Started '+md(parseDate(s.started))+'</div></div>'+
      '</div>'+
      '<div class="ibot">'+
        '<div class="brow">'+
          '<div class="dur"><b>'+hms(s.secs)+'</b></div>'+
          '<div class="pct"><b>'+s.from+'%</b> <span class="ar">→</span> <b class="to">'+s.to+'%</b></div>'+
        '</div>'+
        '<div class="bar"><div class="fnew" style="width:'+s.to+'%"></div><div class="fold" style="width:'+s.from+'%"></div></div>'+
      '</div>';
    bk.appendChild(info);
    if(s.fin){ const ck=document.createElement('div'); ck.className='check'; ck.textContent='✓'; bk.appendChild(ck); }
    booksEl.appendChild(bk);
  }
  if(extra.length){
    const more=document.createElement('div'); more.className='book more';
    more.innerHTML='<div class="moreb">+'+extra.length+'</div>';
    more.title=extra.map(s=>s.t).join('   ·   ');
    booksEl.appendChild(more);
  }
  cell.appendChild(booksEl);

  // compact view (level 4): blended cover + stacked title(s) — built for every day so the
  // 3->4 / 4->5 transitions behave identically regardless of book count.
  {
    const cm=document.createElement('div'); cm.className='compactmulti';
    const blend=document.createElement('div'); blend.className='blend';
    sessions.slice(0,2).forEach((s,i)=>{
      if(!s.img) return;
      const im=document.createElement('img'); im.className='bimg'+(i===1?' bimg2':'');
      im.src=s.img; im.alt=s.t; im.loading='lazy'; im.decoding='async';
      im.onerror=()=>im.remove();
      blend.appendChild(im);
    });
    cm.appendChild(blend);
    const titles=document.createElement('div'); titles.className='titles';
    for(const s of shown){
      const row=document.createElement('div'); row.className='trow';
      row.innerHTML='<div class="tt">'+esc(s.t)+'</div>'+
                    '<div class="pp"><b style="color:var(--text)">'+s.from+'%</b> <span class="ar">→</span> <b style="color:var(--text)">'+s.to+'%</b></div>';
      titles.appendChild(row);
    }
    if(extra.length){
      const row=document.createElement('div'); row.className='trow more';
      row.innerHTML='<div class="tt">+'+extra.length+' more…</div>';
      row.title=extra.map(s=>s.t).join('   ·   ');
      titles.appendChild(row);
    }
    cm.appendChild(titles);
    // Compact: a single green-circle check (top-right of the cell, like Covers) if any book finished
    if(sessions.some(s=>s.fin)){
      const ck=document.createElement('div'); ck.className='check'; ck.textContent='✓'; cm.appendChild(ck);
    }
    cell.appendChild(cm);
  }

  // Covers-level hours overlay (total time listened that day, one decimal)
  const hrs=document.createElement('div'); hrs.className='hours';
  hrs.textContent=(total/3600).toFixed(1);
  cell.appendChild(hrs);

  cell.title=sessions.map(s=>s.t+' '+s.from+'→'+s.to+'%'+(s.fin?' ✓':'')).join('   ·   ');
  // every book of the day (incl. those hidden past the 2 shown) so the tap/click modal can list them
  cell.dataset.books=JSON.stringify(sessions.map(s=>({i:s.id,t:s.t,a:s.a,img:s.img})));
}

export function build(data){
  S.data=data;
  const books=data.books||{}, days=data.days||{};
  S.start=parseDate(data.start);
  S.today=parseDate(data.today);
  // Render through the END of the current month (not just today's week): the remaining days of
  // this month show as ghost "not yet" cells. Extend WEEKS to the Monday-week of the month's last day.
  const monthEnd=new Date(S.today.getFullYear(), S.today.getMonth()+1, 0);
  const lastMon=new Date(monthEnd); lastMon.setDate(monthEnd.getDate()-((monthEnd.getDay()+6)%7));
  S.WEEKS=Math.max(1, Math.round((lastMon-S.start)/(7*864e5))+1);

  D.grid.innerHTML=''; D.monthsbar.innerHTML=''; S.monthEls.length=0; S.weekBlockCol.length=0; S.monthKeys.length=0;
  computeMonthBlocks();
  D.hint.textContent=S.start.getFullYear()+' – '+S.today.getFullYear();

  let cur=new Date(S.start), prevMonth=-1;
  for(let w=0; w<S.WEEKS; w++){
    const weekMonth=cur.getMonth(), weekYear=cur.getFullYear();
    S.weekBlockCol[w]=blockColFor(cur);
    if(weekMonth!==prevMonth){
      prevMonth=weekMonth;
      const tb=tracksBefore(S.monthBase[weekYear+'-'+weekMonth]);
      const lab=document.createElement('span');
      lab.textContent=MONTH[weekMonth]+(weekMonth===0?" '"+String(weekYear).slice(2):'');
      lab.dataset.cont=w; lab.dataset.cb=tb.c; lab.dataset.tb=tb.t; lab.dataset.mi=S.monthIndex[weekYear+'-'+weekMonth];
      D.monthsbar.appendChild(lab); S.monthEls.push(lab);
      S.monthKeys[S.monthIndex[weekYear+'-'+weekMonth]] = weekYear+'-'+weekMonth;
    }
    for(let r=0; r<7; r++){
      const date=new Date(cur);
      const isFuture=date>S.today;
      const cell=document.createElement('div');
      cell.className='cell';
      cell.style.gridRow=(r+1);
      cell.style.setProperty('--cc', w+1);                  // continuous-stream column
      cell.style.setProperty('--cb', blockColFor(date)+1);  // month-block column
      cell.style.setProperty('--mi', S.monthIndex[date.getFullYear()+'-'+date.getMonth()]||0); // month ordinal (fracture)
      cell.innerHTML='<span class="num">'+date.getDate()+'</span>';

      if(isFuture){ cell.classList.add('future'); }
      else {
        if(keyOf(date)===keyOf(S.today)) cell.classList.add('today');
        const list=days[keyOf(date)];
        if(list && list.length) renderDay(cell, list, books);
      }
      D.grid.appendChild(cell);
      cur.setDate(cur.getDate()+1);
    }
  }
}
