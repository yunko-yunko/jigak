// Writes site/legal/*.html from the app's own legal text (src/modules/legal/domain/legal-content.ts,
// a byte-identical copy of mvp/src/content/legal.ts), so the website and the in-app documents never drift.
// Run from jigak-backend: node --import tsx site/build-legal.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { legalDocuments, POLICY_VERSION } from '../src/modules/legal/domain/legal-content.ts';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'legal');
mkdirSync(out, { recursive: true });

const ORDER = [
  ['terms', '이용약관'],
  ['privacy', '개인정보 처리방침'],
  ['location', '위치정보 이용 안내'],
  ['licenses', '오픈소스 및 출처'],
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const linkify = (s) => esc(s).replace(/https:\/\/[^\s)]+/g, (u) => `<a href="${u}">${u}</a>`);

const MARK = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><symbol id="mark" viewBox="22 4 76 110"><path d="M60 15.5V26.5" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><rect x="49.5" y="8.5" width="21" height="8.5" rx="4.25" fill="currentColor"/><path d="M81.92 36.08L87.29 30.71" stroke="currentColor" stroke-width="8" stroke-linecap="round"/><path d="M33.81 80.46A34.5 34.5 0 1 1 86.19 80.46L62.43 108.17A3.2 3.2 0 0 1 57.57 108.17ZM81.5 58A21.5 21.5 0 1 0 38.5 58A21.5 21.5 0 1 0 81.5 58Z" fill="currentColor" fill-rule="evenodd"/><path d="M60 58L67.25 45.44" stroke="#111317" stroke-width="6.2" stroke-linecap="round"/><circle cx="60" cy="58" r="5.8" fill="#111317"/></symbol></defs></svg>`;

const footer = (prefix) => `<footer class="footer">
    <div class="footer-inner">
      <div class="f-brand"><svg class="brand-mark" aria-hidden="true"><use href="#mark"/></svg><span>지각지도</span></div>
      <p class="f-org">울산작은고래지킴이협회 · 2026 디지털 콘텐츠 개발대회 생활 부문 출품작</p>
      <nav class="f-links" aria-label="약관과 정책">
        ${ORDER.map(([k, label]) => `<a href="${prefix}${k}.html">${k === 'privacy' ? `<b>${label}</b>` : label}</a>`).join('\n        ')}
      </nav>
      <p class="f-credit">지도 Protomaps © OpenStreetMap 기여자 · 국토지리정보원 · 서울특별시 공공데이터 · 기상청</p>
    </div>
  </footer>`;

for (const [kind] of ORDER) {
  const doc = legalDocuments[kind];
  const tabs = ORDER.map(([k, label]) =>
    `<a href="${k}.html"${k === kind ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  const toc = doc.sections.map((s, i) => `<li><a href="#s${i + 1}">${esc(s.title)}</a></li>`).join('\n            ');
  const body = doc.sections.map((s, i) => `<section class="legal-section" id="s${i + 1}">
            <h2>${esc(s.title)}</h2>
            <p>${linkify(s.body)}</p>
          </section>`).join('\n          ');

  const html = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${esc(doc.title)} · 지각지도</title>
  <meta name="description" content="${esc(doc.introduction)}">
  <link rel="icon" href="../assets/icon.png">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
  <link rel="stylesheet" href="../styles.css?v=1102b">
</head>
<body class="legal-page">
  ${MARK}
  <a class="skip" href="#main">본문으로 건너뛰기</a>
  <header class="nav is-solid">
    <div class="nav-inner">
      <a class="brand" href="../index.html" aria-label="지각지도 처음으로"><svg class="brand-mark" aria-hidden="true"><use href="#mark"/></svg><span>지각지도</span></a>
      <nav class="nav-links" aria-label="주요 메뉴">
        <a href="../index.html#how">찾는 방식</a>
        <a href="../index.html#modes">이동수단</a>
        <a href="../index.html#live">실시간</a>
        <a href="../index.html#guide">이동 안내</a>
      </nav>
      <a class="btn btn-small" href="../index.html#download">앱 받기</a>
    </div>
  </header>

  <main id="main" class="legal">
    <nav class="legal-tabs" aria-label="약관과 정책">${tabs}</nav>
    <header class="legal-head">
      <h1>${esc(doc.title)}</h1>
      <p class="legal-intro">${linkify(doc.introduction)}</p>
      <p class="legal-version">시행일 ${POLICY_VERSION} · 앱 안의 문서와 같은 버전입니다.</p>
    </header>
    <div class="legal-body">
      <aside class="legal-toc" aria-label="목차">
        <p>목차</p>
        <ol>
            ${toc}
        </ol>
      </aside>
      <article class="legal-article">
          ${body}
      </article>
    </div>
  </main>

  ${footer('')}
  <script>document.querySelector('.legal-tabs [aria-current]')?.scrollIntoView({ inline: 'center', block: 'nearest' });</script>
</body>
</html>
`;
  writeFileSync(join(out, `${kind}.html`), html);
  console.log(`legal/${kind}.html`);
}
