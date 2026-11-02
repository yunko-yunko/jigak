(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const vh = () => window.innerHeight;

  /* Reveal on entering the viewport, once. */
  const revealed = document.querySelectorAll('.reveal, .download');
  if (reduced || !('IntersectionObserver' in window)) {
    revealed.forEach((el) => el.classList.add('is-in'));
  } else {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
    }, { rootMargin: '0px 0px -12% 0px' });
    revealed.forEach((el) => io.observe(el));
  }

  /* Each mode's sample line draws from start to end. */
  document.querySelectorAll('.mode-line path').forEach((p) => {
    p.style.setProperty('--len', Math.ceil(p.getTotalLength()) + 1);
  });

  /* ---- Scroll-linked scenes, one rAF per frame. ---- */
  const nav = document.getElementById('nav');
  const heroPhone = document.getElementById('heroPhone');
  const how = document.getElementById('how');
  const steps = [...how.querySelectorAll('.how-step')];
  const dots = [...how.querySelectorAll('.how-dots i')];
  const rows = [...how.querySelectorAll('.route')];
  const arriveNum = document.getElementById('arriveNum');
  const arriveDelta = document.getElementById('arriveDelta');
  const ARRIVALS = [
    { min: 9 * 60 + 15, delta: '15분 늦음', tone: 'late' },
    { min: 9 * 60 + 3, delta: '3분 늦음', tone: 'late' },
    { min: 8 * 60 + 57, delta: '3분 일찍 도착', tone: 'ok' },
  ];
  let step = -1;
  let shownMin = ARRIVALS[0].min;
  let tween = 0;

  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;

  function countTo(target) {
    cancelAnimationFrame(tween);
    const from = shownMin;
    if (reduced || from === target) { shownMin = target; arriveNum.textContent = fmt(target); return; }
    const t0 = performance.now();
    const run = (now) => {
      const k = ease(clamp((now - t0) / 700));
      shownMin = from + (target - from) * k;
      arriveNum.textContent = fmt(Math.round(shownMin));
      if (k < 1) tween = requestAnimationFrame(run);
    };
    tween = requestAnimationFrame(run);
  }

  function setStep(next) {
    if (next === step) return;
    step = next;
    steps.forEach((el, i) => {
      el.classList.toggle('is-active', i === step);
      el.classList.toggle('is-past', i < step);
      el.setAttribute('aria-hidden', i === step ? 'false' : 'true');
    });
    dots.forEach((d, i) => d.classList.toggle('on', i === step));
    rows.forEach((r, i) => {
      r.classList.toggle('is-shown', i === step);
      r.classList.toggle('is-dim', i < step);
    });
    const a = ARRIVALS[step];
    countTo(a.min);
    arriveDelta.textContent = a.delta;
    arriveNum.className = arriveDelta.className = a.tone;
  }

  /* Mini metro: lines draw in with scroll, then trains run while visible. */
  const metroWrap = document.querySelector('.metro');
  const metro = document.getElementById('metro');
  const lines = [...metro.querySelectorAll('.m-lines path')];
  const trainLayer = metro.querySelector('.m-trains');
  const trains = [];
  lines.forEach((p, i) => {
    const len = p.getTotalLength();
    p.style.stroke = p.dataset.c;
    p.style.strokeDasharray = len;
    p.style.strokeDashoffset = len;
    p._len = len;
    for (let k = 0; k < 2; k++) {
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r.setAttribute('width', 24); r.setAttribute('height', 11); r.setAttribute('rx', 3);
      r.setAttribute('x', -12); r.setAttribute('y', -5.5);
      r.style.opacity = 0;
      trainLayer.appendChild(r);
      trains.push({ el: r, path: p, len, pos: (k * 0.5 + i * 0.17) % 1, speed: 0.035 + (i % 3) * 0.008, dir: 1 });
    }
  });
  let metroBuilt = false;
  let metroVisible = false;
  let lastT = 0;

  function placeTrain(t) {
    const d = t.pos * t.len;
    const a = t.path.getPointAtLength(d);
    const b = t.path.getPointAtLength(Math.min(t.len, d + 1));
    const ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    t.el.setAttribute('transform', `translate(${a.x.toFixed(1)} ${a.y.toFixed(1)}) rotate(${ang.toFixed(1)})`);
  }

  function runTrains(now) {
    if (!metroVisible || !metroBuilt) { lastT = 0; return; }
    const dt = lastT ? Math.min(0.05, (now - lastT) / 1000) : 0;
    lastT = now;
    for (const t of trains) {
      t.pos += t.dir * t.speed * dt * (600 / t.len);
      const closed = /Z\s*$/.test(t.path.getAttribute('d'));
      if (closed) t.pos = (t.pos + 1) % 1;
      else if (t.pos > 1) { t.pos = 1; t.dir = -1; } else if (t.pos < 0) { t.pos = 0; t.dir = 1; }
      placeTrain(t);
    }
    requestAnimationFrame(runTrains);
  }

  function buildMetro(k) {
    lines.forEach((p, i) => {
      const local = clamp(k * 1.9 - i * 0.18);
      p.style.strokeDashoffset = p._len * (1 - ease(local));
    });
    if (k >= 0.9 && !metroBuilt) {
      lines.forEach((l) => { l.style.strokeDashoffset = 0; });
      metroBuilt = true;
      metroWrap.classList.add('is-built');
      trains.forEach((t) => { placeTrain(t); t.el.style.transition = 'opacity .6s'; t.el.style.opacity = 1; });
      if (!reduced) requestAnimationFrame(runTrains);
    }
  }

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => {
      const was = metroVisible;
      metroVisible = e.isIntersecting;
      if (metroVisible && !was && metroBuilt && !reduced) requestAnimationFrame(runTrains);
    }).observe(metroWrap);
  }

  let ticking = false;
  function frame() {
    ticking = false;
    const y = window.scrollY;
    const h = vh();
    nav.classList.toggle('is-solid', y > 12);

    // Hero phone settles from a tilt into place as the page scrolls.
    if (!reduced) {
      const r = heroPhone.getBoundingClientRect();
      const k = clamp(1 - (r.top - h * 0.2) / (h * 0.7));
      const tilt = 16 * (1 - k);
      const s = 0.9 + 0.1 * k;
      heroPhone.style.transform = `rotateX(${tilt.toFixed(2)}deg) scale(${s.toFixed(3)})`;
    }

    // The deadline scene: three equal thirds of the pinned stretch.
    const hr = how.getBoundingClientRect();
    const p = clamp(-hr.top / (hr.height - h));
    setStep(p < 0.34 ? 0 : p < 0.67 ? 1 : 2);

    // Metro lines draw as the section rises through the lower half of the viewport.
    if (!metroBuilt) {
      const mr = metroWrap.getBoundingClientRect();
      buildMetro(reduced ? 1 : clamp((h - mr.top) / (h * 0.75)));
    }
  }
  const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(frame); } };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  frame();
})();
