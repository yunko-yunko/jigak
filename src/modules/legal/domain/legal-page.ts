import { legalDocuments, POLICY_VERSION, type LegalKind } from './legal-content.js';

export const LEGAL_KINDS = Object.keys(legalDocuments) as LegalKind[];

export function isLegalKind(value: string): value is LegalKind {
  return (LEGAL_KINDS as string[]).includes(value);
}

/** Inline styles only, so the page needs nothing beyond itself. */
export const LEGAL_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** The same text the app shows and records consent against, as a public page (카카오 동의항목 URL). */
export function legalPage(kind: LegalKind) {
  const document = legalDocuments[kind];
  const sections = document.sections
    .map(
      (section) =>
        `<section><h2>${escape(section.title)}</h2><p>${escape(section.body)}</p></section>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(document.title)} · 지각지도</title>
<style>
body{margin:0;background:#fff;color:#16181d;font:16px/1.7 -apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Noto Sans KR','Malgun Gothic',sans-serif;word-break:keep-all}
main{max-width:720px;margin:0 auto;padding:40px 16px 64px}
h1{margin:0 0 8px;font-size:26px;line-height:1.3}
.version{margin:0 0 24px;color:#6b7280;font-size:14px}
.intro{margin:0 0 32px}
h2{margin:32px 0 8px;font-size:18px;line-height:1.4}
p{margin:0}
</style>
</head>
<body>
<main>
<h1>${escape(document.title)}</h1>
<p class="version">지각지도 · 시행일 ${POLICY_VERSION}</p>
<p class="intro">${escape(document.introduction)}</p>
${sections}
</main>
</body>
</html>
`;
}
