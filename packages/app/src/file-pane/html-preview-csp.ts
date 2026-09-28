// A preview runs a web app: React from a CDN, Tailwind, Google Fonts, a chart
// library, a fetch to an API. Every resource the page loads or calls must be HTTPS
// (or inline, data:, blob:). Plaintext `http:` and `ws:` are refused. That is where
// localhost and LAN services live, the Paseo daemon among them, and a page opened
// from a cloned repo must not reach them. Mixed-content blocking does not cover
// this: browsers treat localhost as a secure context.
//
// The CSP does not contain what the page can send out. A page can navigate itself
// anywhere (`navigate-to` was dropped from CSP3, and `<meta http-equiv="refresh">`
// needs no script), and it can fetch any HTTPS host. What bounds it is the opaque
// origin: the frame has no storage, no parent access, and no way to read any file
// but itself, so it can only disclose what it already contains. Native refuses
// navigation after the initial document in html-preview.tsx.
const POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' data: blob: https:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: https:",
  "media-src data: blob: https:",
  "connect-src data: blob: https: wss:",
  "frame-src https:",
  "form-action https:",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

const META = `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`;

// The policy must reach the parser before any markup the document declares, and it
// only counts if it lands in `<head>` — once the parser has moved on to `<body>`, a
// meta http-equiv CSP is ignored outright.
//
// Locating the document's own doctype to insert after it means reimplementing the
// tokenizer's initial insertion mode: its exact whitespace set (JS `\s` matches
// characters HTML does not, and one stray NBSP is enough to push the policy into
// the body where it stops applying), every comment ending including `--!>`, `<!-->`
// and `<!--->`, bogus-comment tokens like `<?xml …?>` and `<![CDATA[…]]>`, and the
// rule that a doctype closes at the first `>` in every state. Each of those rules
// cost a bug before it was right.
//
// So the prologue isn't found, it's supplied: our doctype, then the policy, then
// the file verbatim. The file's own doctype becomes a stray DOCTYPE token, which
// the parser ignores wherever it appears. Standards mode is guaranteed, the policy
// is always the first element and therefore always in the head, and no part of the
// document has to be parsed to place it.
const PROLOGUE = `<!doctype html>${META}`;

// Web only: a plain link (no target, like a chat link) should open in a new tab
// instead of replacing the preview frame. The listener runs on window in the
// bubble phase, after the page's own handlers, and only acts when nothing else
// already claimed the click. Native keeps its navigation guard unchanged, this
// script never ships to the WebView document.
const OPEN_LINKS_SCRIPT = `<script>
window.addEventListener("click", function (event) {
  if (event.defaultPrevented) return;
  if (event.button !== 0) return;
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;

  var path = typeof event.composedPath === "function" ? event.composedPath() : [];
  var link = null;
  for (var i = 0; i < path.length; i++) {
    var node = path[i];
    if (node && node.tagName && (node.tagName === "A" || node.tagName === "AREA") && node.hasAttribute("href")) {
      link = node;
      break;
    }
  }
  if (!link) return;

  var target = link.getAttribute("target");
  if (target && target !== "_self") return;
  if (link.hasAttribute("download")) return;

  var rawHref = link.getAttribute("href") || "";
  if (rawHref.indexOf("#") === 0) return;

  var url;
  try {
    url = new URL(link.href, document.baseURI);
  } catch (error) {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  event.preventDefault();
  window.open(url.href, "_blank", "noopener,noreferrer");
});
</script>`;

const PROLOGUE_WEB = `<!doctype html>${META}${OPEN_LINKS_SCRIPT}`;

// Left where it is, a BOM would sit mid-document and render as a zero-width space.
const BOM = "\uFEFF";

function stripBom(html: string): string {
  return html.startsWith(BOM) ? html.slice(BOM.length) : html;
}

export function withPreviewCsp(html: string): string {
  return PROLOGUE + stripBom(html);
}

// Same supplied-prologue document as withPreviewCsp, plus the click interceptor
// above. The CSP meta stays the first element in <head> and standards mode stays
// guaranteed; only web preview frames get this variant.
export function withPreviewCspWeb(html: string): string {
  return PROLOGUE_WEB + stripBom(html);
}
