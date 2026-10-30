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
      const nodes = [...document.querySelectorAll('[data-surface], .glass')];
      for (const n of observed) if (!nodes.includes(n)) { resize.unobserve(n); observed.delete(n); }
      const rects = [];
      for (const n of nodes) {
        if (!observed.has(n)) { resize.observe(n); observed.add(n); }
        const s = getComputedStyle(n), b = n.getBoundingClientRect();
        if (!n.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || s.pointerEvents === 'none' || !b.width || !b.height) continue;
        const raw = s.borderTopLeftRadius.split(' ')[0];
        const radius = parseFloat(raw) * (raw.endsWith('%') ? Math.min(b.width,b.height)/100 : 1);
        rects.push({x:b.x,y:b.y,w:b.width,h:b.height,r:Math.min(radius || 0,b.width/2,b.height/2)});
      }
      const next = JSON.stringify(rects);
      if (next !== last) Promise.resolve(invoke('surfaces_set', {rects})).then(() => {last=next;}).catch(() => {});
      if (document.getAnimations().some(a => a.playState === 'running')) refresh();
    });
  }
  const resize = new ResizeObserver(refresh);
  function start() {
    if (started || !window.__TAURI__?.core?.invoke) return;
    started = true;
    new MutationObserver(refresh).observe(document.documentElement, {subtree:true,attributes:true,childList:true});
    for (const e of ['animationstart','animationend','animationcancel','transitionrun','transitionend','transitioncancel','scroll','resize']) window.addEventListener(e,refresh,true);
    refresh();
  }
  window.QSurfaces = {start,refresh,setBlur(enabled,tintArgb) {return Promise.resolve(invoke('surfaces_set_blur',{enabled:!!enabled,tintArgb:tintArgb >>> 0}));}};
})();
