(() => {
  let started = false, scheduled = false, last = '', lastFrame = 0, observed = new Set();
  const invoke = (name, args) => window.__TAURI__?.core?.invoke(name, args);
  function refresh() {
    if (!window.__TAURI__?.core?.invoke || scheduled) return;
    scheduled = true;
    requestAnimationFrame((now) => {
      if (now-lastFrame < 1000/60) {scheduled=false;refresh();return;}
      lastFrame=now;
      scheduled = false;
      const all = [...document.querySelectorAll('[data-surface], .glass, .thinking, button, textarea')];
      // Anything inside a glass object is already covered by that object's rect.
      const nodes = all.filter(n => !n.parentElement?.closest('.glass'));
      const membership = new Set(nodes);
      for (const n of observed) if (!membership.has(n)) { resize.unobserve(n); observed.delete(n); }
      const rects = [];
      for (const n of nodes) {
        if (!observed.has(n)) { resize.observe(n); observed.add(n); }
        if (n.closest('.preview') || n.id === 'btn-send') continue;
        const s = getComputedStyle(n), b = n.getBoundingClientRect();
        if (!n.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || s.pointerEvents === 'none' || !b.width || !b.height) continue;
        const raw = s.borderTopLeftRadius.split(' ')[0];
        const radius = parseFloat(raw) * (raw.endsWith('%') ? Math.min(b.width,b.height)/100 : 1);
        let left=Math.max(0,b.left),top=Math.max(0,b.top),right=Math.min(innerWidth,b.right),bottom=Math.min(innerHeight,b.bottom);
        for(let parent=n.parentElement;parent;parent=parent.parentElement){
          const style=getComputedStyle(parent),clip=parent.getBoundingClientRect();
          if(/(auto|scroll|hidden|clip)/.test(style.overflowX)){left=Math.max(left,clip.left+parent.clientLeft);right=Math.min(right,clip.left+parent.clientLeft+parent.clientWidth);}
          if(/(auto|scroll|hidden|clip)/.test(style.overflowY)){top=Math.max(top,clip.top+parent.clientTop);bottom=Math.min(bottom,clip.top+parent.clientTop+parent.clientHeight);}
        }
        if(right>left && bottom>top) rects.push({x:left,y:top,w:right-left,h:bottom-top,r:Math.min(radius||0,(right-left)/2,(bottom-top)/2),b:n.matches('.glass, .thinking')});
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
    new MutationObserver(records => { if (records.some(r => !r.target.closest?.('.turn-content'))) refresh(); }).observe(document.documentElement, {subtree:true,attributes:true,childList:true});
    for (const e of ['animationstart','animationend','animationcancel','transitionrun','transitionend','transitioncancel','scroll','resize']) window.addEventListener(e,refresh,true);
    setInterval(() => { last=""; refresh(); },1000);
    refresh();
  }
  document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('bar')) return;
    for (const n of document.querySelectorAll('button, textarea, [tabindex]')) {
      if (!n.closest('.glass') && n.id !== 'btn-send') n.dataset.surface = '';
    }
    start();
  });
  window.QSurfaces = {start,refresh,setBlur(enabled,tintArgb,strength=1) {return Promise.resolve(invoke('surfaces_set_blur',{enabled:!!enabled,tintArgb:tintArgb >>> 0,strength}));}};
})();
