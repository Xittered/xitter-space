// The look of my.<HOSTING_DOMAIN> (portal.ts, hosting.ts): top bar, X's dark
// palette, Inter and Material Symbols from Google Fonts. Pages may carry one
// inline script; it runs under a per-response nonce.

import { randomBytes } from "node:crypto";
import { esc } from "./account-page";
import { PUBLIC_ORIGIN } from "./config";
import { settings } from "./settings";

export type Nav = "home" | "instances" | "run" | "staff" | "";

const CSS = `:root{color-scheme:dark;--bg:#000;--panel:#0b0d0f;--card:#101214;--line:#2f3336;--text:#e7e9ea;--dim:#71767b;--blue:#1d9bf0;--green:#00ba7c;--red:#f4212e;--amber:#ffd400}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 Inter,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
.icon{font-family:"Material Symbols Rounded";font-weight:normal;font-style:normal;font-size:20px;line-height:1;display:inline-block;vertical-align:-4px;font-variation-settings:"FILL" 0,"wght" 400;user-select:none}
.icon.fill{font-variation-settings:"FILL" 1,"wght" 400}
header.top{position:sticky;top:0;z-index:10;background:rgba(0,0,0,.72);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
header.top .in{max-width:1080px;margin:0 auto;padding:10px 16px;display:flex;align-items:center;gap:6px}
.brand{display:flex;align-items:center;gap:10px;color:var(--text);font-weight:800;font-size:17px;margin-right:auto}.brand:hover{text-decoration:none}.brand img{height:26px}
.navlink{color:var(--text);padding:8px 12px;border-radius:999px;font-weight:600;font-size:14px;display:flex;align-items:center;gap:6px}.navlink:hover{background:#181919;text-decoration:none}.navlink.on{background:#16181c}
.wrap{max-width:1080px;margin:0 auto;padding:0 16px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 20px;border-radius:999px;font:inherit;font-weight:700;border:1px solid transparent;cursor:pointer;color:#0f1419;background:#eff3f4;white-space:nowrap}
.btn:hover{text-decoration:none;background:#d7dbdc}.btn.blue{background:var(--blue);color:#fff}.btn.blue:hover{background:#1a8cd8}.btn.ghost{background:none;color:var(--text);border-color:#536471}.btn.ghost:hover{background:#181919}.btn.small{padding:6px 14px;font-size:14px}
h1,h2,h3{letter-spacing:-.02em;line-height:1.15}h2{font-size:28px;margin:0 0 6px}.lead{color:var(--dim);font-size:17px;margin:0 0 24px}.dim{color:var(--dim)}
section{padding:56px 0;border-top:1px solid #16181c}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:20px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(290px,1fr))}
.tag{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;border:1px solid var(--line);border-radius:999px;padding:1px 9px;color:var(--dim);white-space:nowrap}
.tag.blue{color:var(--blue);border-color:rgba(29,155,240,.4)}.tag.green{color:var(--green);border-color:rgba(0,186,124,.4)}.tag.amber{color:var(--amber);border-color:rgba(255,212,0,.35)}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block;background:var(--dim);flex:none}.dot.on{background:var(--green);box-shadow:0 0 0 0 rgba(0,186,124,.6);animation:pulse 2.4s infinite}.dot.off{background:var(--red)}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(0,186,124,.55)}70%{box-shadow:0 0 0 7px rgba(0,186,124,0)}100%{box-shadow:0 0 0 0 rgba(0,186,124,0)}}
input,textarea,select{width:100%;padding:11px 14px;border:1px solid #333639;border-radius:10px;background:#000;color:inherit;font:inherit}input:focus,textarea:focus,select:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 1px var(--blue)}
textarea{min-height:90px;resize:vertical}label{display:block;margin:16px 0 6px;font-weight:600}
.error{color:var(--red)}.ok{color:var(--green)}code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px}code{background:#16181c;padding:2px 6px;border-radius:5px}
pre{background:#0a0b0c;border:1px solid var(--line);border-radius:12px;padding:14px;overflow:auto;margin:10px 0}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.suffix{white-space:nowrap;color:var(--dim)}
footer.bottom{border-top:1px solid #16181c;margin-top:40px;padding:28px 0 48px;color:var(--dim);font-size:13px}footer.bottom .wrap{display:flex;gap:16px;flex-wrap:wrap;align-items:center}
.page-head{padding:44px 0 8px}.page-head h1{font-size:40px;margin:0 0 8px}
@media (max-width:640px){.navlink span.label{display:none}.page-head h1{font-size:32px}h2{font-size:24px}}`;

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..24,400,0..1,0&display=swap">`;

export const icon = (name: string, fill = false) => `<span class="icon${fill ? " fill" : ""}" aria-hidden="true">${name}</span>`;

export type PageOptions = { status?: number; nav?: Nav; script?: string; css?: string; wide?: boolean };

export function portalPage(title: string, body: string, opts: PageOptions = {}): Response {
	const nonce = randomBytes(16).toString("base64");
	const domain = (process.env.HOSTING_DOMAIN ?? "").toLowerCase() || new URL(PUBLIC_ORIGIN).host;
	const link = (href: string, key: Nav, ic: string, text: string) => `<a class="navlink${opts.nav === key ? " on" : ""}" href="${href}">${icon(ic)}<span class="label">${text}</span></a>`;
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="Xitter instances: pick one, or run your own on ${esc(domain)}.">
<link rel="icon" href="${PUBLIC_ORIGIN}/public/favicon.png">${FONTS}<style>${CSS}${opts.css ?? ""}</style></head><body>
<header class="top"><div class="in"><a class="brand" href="/"><img src="${PUBLIC_ORIGIN}/public/logo-dark.png" alt="Xitter"></a>
${link("/instances", "instances", "public", "Instances")}${link("/apply", "run", "dns", "Run your own")}${link("/staff", "staff", "shield_person", "Staff")}
<a class="btn small" href="${PUBLIC_ORIGIN}/" style="margin-left:6px">Open ${esc(domain)}</a></div></header>
${body}
<footer class="bottom"><div class="wrap"><span>Run by <a href="${PUBLIC_ORIGIN}/">${esc(settings().instance_name)}</a></span><a href="${esc(settings().source_url)}">Source (AGPL-3.0)</a><a href="https://github.com/Xittered/xitter/blob/main/FEDERATION.md">Federation rules</a><a href="https://github.com/Xittered/xitter/blob/main/instances.json">Instance list</a></div></footer>
${opts.script ? `<script nonce="${nonce}">${opts.script}</script>` : ""}</body></html>`;
	return new Response(html, {
		status: opts.status ?? 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy": `default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src https: data:; script-src 'nonce-${nonce}'; form-action 'self' ${PUBLIC_ORIGIN}; base-uri 'none'; frame-ancestors 'none'`,
			"referrer-policy": "same-origin",
		},
	});
}
