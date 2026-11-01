(() => {
  let started = false, scheduled = false, last = '', lastFrame = 0, observed = new Set(), barBlur = 1, chatBlur = 1;
  // Which nodes can be surfaces changes only with the DOM's structure or classes, not with
  // scrolling or animation, so the query is kept until a mutation says otherwise.
  let candidates = null;
  const invoke = (name, args) => window.__TAURI__?.core?.invoke(name, args);
  function refresh() {
    if (!window.__TAURI__?.core?.invoke || scheduled) return;
    scheduled = true;
    requestAnimationFrame((now) => {
      if (now-lastFrame < 1000/60) {scheduled=false;refresh();return;}
      lastFrame=now;
      scheduled = false;
      // Anything inside a glass object is already covered by that object's rect. The selector
      // engine drops those itself, so a long history's buttons are never visited here.
      const nodes = candidates ||= [...document.querySelectorAll(':is([data-surface], .glass, .thinking, button, textarea):not(.glass *)')];
      const membership = new Set(nodes);
      // Each ancestor's clip box, read once per pass: bubbles in one scroller share them all.
      const clips = new Map();
      const clipOf = (parent) => {
        let c = clips.get(parent);
        if (!c) {
          const style = getComputedStyle(parent);
          const x = /(auto|scroll|hidden|clip)/.test(style.overflowX), y = /(auto|scroll|hidden|clip)/.test(style.overflowY);
          if (x || y) {
            const box = parent.getBoundingClientRect();
            c = { x, y, l: box.left + parent.clientLeft, t: box.top + parent.clientTop, r: box.left + parent.clientLeft + parent.clientWidth, b: box.top + parent.clientTop + parent.clientHeight };
          } else c = { x: false, y: false };
          clips.set(parent, c);
        }
        return c;
      };
      for (const n of observed) if (!membership.has(n)) { resize.unobserve(n); observed.delete(n); }
      const rects = [];
      for (const n of nodes) {
        if (!observed.has(n)) { resize.observe(n); observed.add(n); }
        if (n.closest('.preview') || n.id === 'btn-send') continue;
        const b = n.getBoundingClientRect();
        // Off screen, it would be clipped away below anyway: skip its style reads.
        if (b.right <= 0 || b.bottom <= 0 || b.left >= innerWidth || b.top >= innerHeight) continue;
        const s = getComputedStyle(n);
        if (!n.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || s.pointerEvents === 'none' || !b.width || !b.height) continue;
        const raw = s.borderTopLeftRadius.split(' ')[0];
        const radius = parseFloat(raw) * (raw.endsWith('%') ? Math.min(b.width,b.height)/100 : 1);
        let left=Math.max(0,b.left),top=Math.max(0,b.top),right=Math.min(innerWidth,b.right),bottom=Math.min(innerHeight,b.bottom);
        for(let parent=n.parentElement;parent && right>left && bottom>top;parent=parent.parentElement){
          const c=clipOf(parent);
          if(c.x){left=Math.max(left,c.l);right=Math.min(right,c.r);}
          if(c.y){top=Math.max(top,c.t);bottom=Math.min(bottom,c.b);}
        }
        if(right>left && bottom>top) rects.push({x:left,y:top,w:right-left,h:bottom-top,r:Math.min(radius||0,(right-left)/2,(bottom-top)/2),b:n.matches('.glass, .thinking'),s:n.matches('.bubble, .thinking') ? chatBlur : barBlur});
      }
      const next = JSON.stringify(rects);
      if (next !== last) { last=next; Promise.resolve(invoke('surfaces_set', {rects:rects.slice(0,2048)})).catch(() => {}); }
      if (document.getAnimations().some(a => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity)) refresh();
    });
  }
  const resize = new ResizeObserver(refresh);
  function start() {
    if (started || !window.__TAURI__?.core?.invoke) return;
    started = true;
    // Streamed text mutates constantly; its bubble's size changes reach us through the ResizeObserver.
    // Nothing inside a reply's text can be a surface (it is always inside its glass bubble).
    new MutationObserver(records => {
      const outside = records.filter(r => !r.target.closest?.('.turn-content'));
      if (!outside.length) return;
      if (outside.some(r => r.type === 'childList' || r.attributeName === 'class' || r.attributeName === 'data-surface')) candidates = null;
      refresh();
    }).observe(document.documentElement, {subtree:true,attributes:true,childList:true});
    for (const e of ['animationstart','animationend','animationcancel','transitionrun','transitionend','transitioncancel','scroll','resize']) window.addEventListener(e,refresh,true);
    setInterval(() => { last=""; candidates=null; refresh(); },1000);
    refresh();
  }
  document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('bar')) return;
    for (const n of document.querySelectorAll('button, textarea, [tabindex]')) {
      if (!n.closest('.glass') && n.id !== 'btn-send') n.dataset.surface = '';
    }
    start();
  });
  window.QSurfaces = {start,refresh,setBlur(enabled,tintArgb,strength=1,replyStrength=strength) {barBlur=strength;chatBlur=replyStrength;refresh();return Promise.resolve(invoke('surfaces_set_blur',{enabled:!!enabled,tintArgb:tintArgb >>> 0,strength}));}};
})();
