// Central mutable state shared across modules. ES-module bindings can't be reassigned from
// another module, so instead of scattered `let`s we mutate fields on these two objects.

// Coarse pointer => phone control scheme (swipe zoom, settle-snap, full-height layouts).
export const isPhone = (typeof matchMedia!=='undefined') && matchMedia('(pointer:coarse)').matches;

export const S = {
  // ----- zoom -----
  cw: 15, ch: 15,
  monthlyView: false,        // true = Level 0 (year grid) showing instead of the timeline

  // ----- data-driven layout (filled by build()) -----
  WEEKS: 0,                  // week-columns from start through today's week
  start: null,               // Monday on/before the earliest session (Date)
  today: null,               // today (Date)
  data: null,                // last /api/data payload
  monthEls: [],              // month label <span>s in the monthsbar

  // ----- month-block column layout (Compact + Detail) -----
  blockTracks: [],           // per track: 'cell' | 'gapthin'
  monthBase: {},             // 'Y-M' -> index of that month's first cell track
  monthIndex: {},            // 'Y-M' -> 0-based month ordinal (continuous-mode fracture)
  months: [],                // in order: {base: first cell track, weeks: # of week-columns}
  cellTracks: [],            // indices into blockTracks that are real day-columns
  weekBlockCol: [],          // week index -> its block column

  // ----- zoom mode bookkeeping -----
  blocksMode: false,         // false = continuous stream (0.5–3), true = month blocks (4–5)
  thinFactor: 0.5,           // thin month-gap: ¼ cell in detail, ½ in compact
  monthShift: 0,             // continuous-mode fracture shift (px per month ordinal)
  padX: 0,                   // half-viewport lead/trail pad so edge months can center
  appliedLevel: -1,          // last discrete stage applied (so per-frame zoom stays cheap)
  appliedWide: null,

  // ----- share -----
  monthKeys: [],             // month ordinal → 'Y-M(0-based)' key (inverse of monthIndex)
};

// DOM references, cached once the document is ready (app.js calls cacheDom()).
export const D = {};
export function cacheDom(){
  D.grid      = document.getElementById('grid');
  D.monthsbar = document.getElementById('months');
  D.hint      = document.getElementById('hint');
  D.scroller  = document.getElementById('scroller');
  D.stage     = document.getElementById('stage');
  D.zlname    = document.getElementById('zlname');
  D.zlpx      = document.getElementById('zlpx');
  D.board     = document.getElementById('board');
  D.monthly   = document.getElementById('monthly');
  D.usageinfo = document.getElementById('usageinfo');
  D.zin       = document.getElementById('zin');
  D.zout      = document.getElementById('zout');
  D.loader    = document.getElementById('loader');
  D.lmsg      = document.getElementById('lmsg');
  D.lsub      = document.getElementById('lsub');
  D.absmodal  = document.getElementById('absmodal');
  D.abslist   = document.getElementById('abslist');
  D.absback   = document.getElementById('absback');
  D.abscancel = document.getElementById('abscancel');
  D.sharebtn  = document.getElementById('sharebtn');
  D.sharemon  = document.getElementById('sharemon');
}
