// Draws a 1080×1920 Instagram-story card for the given month and shares it via the Web Share API
// (falls back to a PNG download when the browser doesn't support file sharing).
import { S } from './state.js';
import { MONTH } from './format.js';

const W = 1080, H = 1920;
const C = {
  bg:    '#0d1117',
  panel: '#161b22',
  panel2:'#1c2230',
  border:'#2b3340',
  text:  '#e6edf3',
  muted: '#8b949e',
  green: '#3fb950',
  cell:  ['#161b22','#13352a','#1c6b3f','#27a149','#3fd35b'],
};

function monthStats(year, month) {
  const days = S.data?.days || {}, books = S.data?.books || {};
  const dim = new Date(year, month + 1, 0).getDate();
  let totalSecs = 0, activeDays = 0;
  const bookSecs = {}, finished = new Set();
  const cells = [];
  for (let d = 1; d <= dim; d++) {
    const k = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const sessions = days[k] || [];
    const secs = sessions.reduce((a, s) => a + s.secs, 0);
    if (secs > 0) activeDays++;
    totalSecs += secs;
    for (const s of sessions) {
      bookSecs[s.id] = (bookSecs[s.id] || 0) + s.secs;
      if (s.fin) finished.add(s.id);
    }
    cells.push({ d, level: secs>9000?4 : secs>5400?3 : secs>2700?2 : secs>0?1 : 0 });
  }
  const topBooks = Object.entries(bookSecs)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([id]) => ({ id, ...(books[id] || {}) }));
  return { year, month, dim, totalSecs, activeDays, finishedCount: finished.size, cells, topBooks };
}

function loadImg(src) {
  if (!src) return Promise.resolve(null);
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    setTimeout(() => resolve(null), 5000);
    img.src = src;
  });
}

function fRR(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y,   x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x,   y+h, r);
  ctx.arcTo(x,   y+h, x,   y,   r);
  ctx.arcTo(x,   y,   x+w, y,   r);
  ctx.closePath();
  ctx.fill();
}

// Find the (rows, cols) that maximises cover square size for n covers
// given available canvas space.
function bestGrid(n, availW, availH, colGap, titleH, rowGap) {
  let best = { rows: 1, cols: n, sz: 0 };
  for (let rows = 1; rows <= Math.min(3, n); rows++) {
    const cols = Math.ceil(n / rows);
    const szW = (availW - (cols - 1) * colGap) / cols;
    const szH = (availH - rows * titleH - (rows - 1) * rowGap) / rows;
    const sz = Math.min(szW, szH, 400);   // 400px cap prevents one cover filling the card
    if (sz > best.sz) best = { rows, cols, sz };
  }
  return best;
}

export async function drawAndShare(ymKey) {
  const [year, month] = ymKey.split('-').map(Number);
  const st = monthStats(year, month);

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // ── background ──
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = 'rgba(255,255,255,0.018)';
  for (let x = 40; x < W; x += 32)
    for (let y = 40; y < H; y += 32)
      ctx.fillRect(x, y, 1.5, 1.5);

  // ── header ──
  const PAD = 80;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = C.green;
  ctx.font = '500 40px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
  ctx.fillText('LISTENING HEATMAP', W/2, 148);

  ctx.fillStyle = C.text;
  ctx.font = 'bold 172px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
  ctx.fillText(MONTH[month].toUpperCase(), W/2, 322);

  ctx.fillStyle = C.muted;
  ctx.font = '600 74px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
  ctx.fillText(String(year), W/2, 412);

  const grad = ctx.createLinearGradient(PAD, 0, W-PAD, 0);
  grad.addColorStop(0, '#1c6b3f'); grad.addColorStop(0.5, '#3fd35b'); grad.addColorStop(1, '#1c6b3f');
  ctx.fillStyle = grad;
  fRR(ctx, PAD, 448, W-PAD*2, 5, 3);

  // ── heatmap grid ──
  const LABEL_COL = 88, LABEL_GAP = 14;
  const GRID_X = PAD + LABEL_COL + LABEL_GAP;
  const GRID_W = W - PAD - GRID_X;
  const GRID_Y = 488;
  const CELL_GAP = 14, CELL_H = 72;
  const GRID_H = 7 * CELL_H + 6 * CELL_GAP;

  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
  const numWeeks = Math.ceil((firstDow + st.dim) / 7);
  const cellW = Math.floor((GRID_W - (numWeeks - 1) * CELL_GAP) / numWeeks);

  const DAY_LABELS = ['Mon','','Wed','','Fri','','Sun'];
  ctx.textAlign = 'right';
  ctx.fillStyle = C.muted;
  ctx.font = '500 32px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
  for (let r = 0; r < 7; r++) {
    if (!DAY_LABELS[r]) continue;
    const cy = GRID_Y + r * (CELL_H + CELL_GAP) + CELL_H/2 + 11;
    ctx.fillText(DAY_LABELS[r], PAD + LABEL_COL, cy);
  }

  for (const { d, level } of st.cells) {
    const i = d - 1;
    const row = (firstDow + i) % 7;
    const col = Math.floor((firstDow + i) / 7);
    ctx.fillStyle = C.cell[level];
    fRR(ctx, GRID_X + col*(cellW+CELL_GAP), GRID_Y + row*(CELL_H+CELL_GAP), cellW, CELL_H, 10);
  }

  // ── stats ──
  const statsY = GRID_Y + GRID_H + 80;
  const colW3 = (W - PAD*2) / 3;
  const stats = [
    { big: (st.totalSecs/3600).toFixed(1)+'h', lbl: 'hours listened'  },
    { big: String(st.activeDays),               lbl: 'active days'     },
    { big: String(st.finishedCount),            lbl: st.finishedCount===1?'book finished':'books finished' },
  ];
  ctx.textAlign = 'center';
  for (let i = 0; i < 3; i++) {
    const cx = PAD + colW3*i + colW3/2;
    ctx.fillStyle = C.text;
    ctx.font = 'bold 98px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
    ctx.fillText(stats[i].big, cx, statsY + 98);
    ctx.fillStyle = C.muted;
    ctx.font = '38px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
    ctx.fillText(stats[i].lbl, cx, statsY + 160);
  }

  const sepY = statsY + 210;
  ctx.fillStyle = C.border;
  ctx.fillRect(PAD, sepY, W-PAD*2, 2);

  // ── book covers — dynamic grid ──
  const COVERS_Y = sepY + 50;
  const COL_GAP = 20, ROW_GAP = 18, TITLE_H = 46;
  const availW = W - PAD * 2;
  const availH = H - 80 - COVERS_Y;

  const bookImgs = await Promise.all(st.topBooks.map(b => loadImg(b.img)));
  const loaded = st.topBooks
    .map((b, i) => ({ book: b, img: bookImgs[i] }))
    .filter(x => x.img);

  if (loaded.length > 0) {
    const { rows, cols, sz } = bestGrid(loaded.length, availW, availH, COL_GAP, TITLE_H, ROW_GAP);
    const coverSz = Math.floor(sz);
    const gridW = cols * coverSz + (cols - 1) * COL_GAP;
    const gridH = rows * (coverSz + TITLE_H) + (rows - 1) * ROW_GAP;
    const startX = (W - gridW) / 2;
    const startY = COVERS_Y + (availH - gridH) / 2;
    const titleFontSz = Math.max(22, Math.min(32, Math.round(coverSz * 0.11)));

    for (let i = 0; i < loaded.length; i++) {
      const r = Math.floor(i / cols), c = i % cols;
      // centre the last (partial) row
      const rowStart = r * cols;
      const rowCount = Math.min(cols, loaded.length - rowStart);
      const rowShift = (cols - rowCount) * (coverSz + COL_GAP) / 2;
      const cx = startX + c * (coverSz + COL_GAP) + rowShift;
      const cy = startY + r * (coverSz + TITLE_H + ROW_GAP);

      ctx.save();
      fRR(ctx, cx, cy, coverSz, coverSz, Math.max(6, coverSz * 0.05));
      ctx.clip();
      ctx.drawImage(loaded[i].img, cx, cy, coverSz, coverSz);
      ctx.restore();

      ctx.textAlign = 'center';
      ctx.fillStyle = C.muted;
      ctx.font = `${titleFontSz}px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`;
      let txt = loaded[i].book.t || '';
      while (txt.length > 0 && ctx.measureText(txt).width > coverSz - 8) txt = txt.slice(0, -1);
      if (txt.length < (loaded[i].book.t || '').length) txt += '…';
      ctx.fillText(txt, cx + coverSz / 2, cy + coverSz + TITLE_H - 8);
    }
  }

  // ── share or download ──
  return new Promise((resolve, reject) => {
    canvas.toBlob(async blob => {
      if (!blob) { reject(new Error('canvas toBlob failed')); return; }
      const fname = `listening-${MONTH[month].toLowerCase()}-${year}.png`;
      const file = new File([blob], fname, { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: `${MONTH[month]} ${year} · Listening Heatmap` });
          resolve();
        } catch(e) {
          if (e.name !== 'AbortError') reject(e); else resolve();
        }
      } else {
        const url = URL.createObjectURL(blob);
        const modal = document.getElementById('shareimgmodal');
        const img   = document.getElementById('shareimgel');
        img.src = url;
        modal.classList.add('show');
        const close = () => {
          modal.classList.remove('show');
          img.src = '';
          URL.revokeObjectURL(url);
        };
        document.getElementById('shareimgback').onclick   = close;
        document.getElementById('shareimgcancel').onclick = close;
        resolve();
      }
    }, 'image/png');
  });
}
