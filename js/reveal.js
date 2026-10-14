// 画面に入る本を静かに浮かび上がらせる。表示済みの本は再描画しても点滅させない。
// 同時に画面へ入った本は、上から・左から順に少しずつ遅らせて出す（Apple の製品ページのような流れ）
const seen=new Set(),observed=new Set();
const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
const keyOf=e=>e.dataset.revealKey || `book:${e.dataset.id || ''}`;
function show(e,delay=0) {
  if (delay) {e.style.transitionDelay=`${delay}ms`;setTimeout(()=>{e.style.transitionDelay='';},delay+700);}
  e.classList.add('is-revealed');seen.add(keyOf(e));observer?.unobserve(e);observed.delete(e);
}
const observer='IntersectionObserver' in window ? new IntersectionObserver(entries=>{
  const coming=entries.filter(x=>x.isIntersecting && x.target.isConnected)
    .sort((a,b)=>a.boundingClientRect.top-b.boundingClientRect.top || a.boundingClientRect.left-b.boundingClientRect.left);
  coming.forEach((x,i)=>show(x.target,Math.min(i,5)*70));
},{threshold:0.08,rootMargin:'0px 0px -72px 0px'}) : null;
export function revealBooks(root) {
  for (const e of observed) if (!e.isConnected) {observer?.unobserve(e);observed.delete(e);}
  for (const e of root.querySelectorAll('.book, .series-card, .cal-reveal')) {
    e.classList.add('reveal-item');
    if (reduced.matches || !observer || seen.has(keyOf(e))) show(e);
    else if (!observed.has(e)) {observed.add(e);observer.observe(e);}
  }
}
document.addEventListener('focusin',e=>{const card=e.target.closest?.('.reveal-item');if(card)show(card);});
reduced.addEventListener('change',()=>{if(reduced.matches) [...observed].forEach(e=>show(e));});
