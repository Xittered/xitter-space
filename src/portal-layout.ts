// The look of my.<HOSTING_DOMAIN> (portal.ts, hosting.ts). Pages may carry one
// inline script; it runs under a per-response nonce.
//
// Dark-minimal family, varied on purpose:
//   1. display face Inter Tight (tight grotesque), text Inter, mono JetBrains Mono
//   2. blue-black neutrals, X blue as the only accent
//   3. sharp 6px radius
//   4. 1px border-only surfaces, no shadows
//   5. static top line instead of a sticky header
//   6. uppercase mono micro-labels

import { randomBytes } from "node:crypto";
import { esc } from "./account-page";
import { PUBLIC_ORIGIN } from "./config";
import { settings } from "./settings";

export type Nav = "home" | "instances" | "run" | "staff" | "";

const CSS = `:root{color-scheme:dark;--bg:#07080a;--surface:#0e1013;--surface-2:#15181c;--well:#0a0b0d;--fg:#e8eaed;--dim:#9aa0a6;--mute:#5f656c;--accent:#1d9bf0;
--line:rgb(255 255 255 / .08);--line-strong:rgb(255 255 255 / .22);--r:6px;
--display:"Inter Tight","Inter",-apple-system,"Segoe UI",sans-serif;--text:"Inter",-apple-system,"Segoe UI",Roboto,sans-serif;--mono:"JetBrains Mono",ui-monospace,Consolas,monospace}
*,*::before,*::after{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 var(--text);-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}:focus-visible{outline:2px solid var(--accent);outline-offset:3px}[hidden]{display:none!important}
.icon{font-family:"Material Symbols Outlined";font-weight:normal;font-style:normal;font-size:18px;line-height:1;display:inline-block;vertical-align:middle;white-space:nowrap;direction:ltr;font-feature-settings:"liga";-webkit-font-smoothing:antialiased;flex:none}
.wrap{max-width:640px;margin:0 auto;padding:0 16px}
header.top{border-bottom:1px solid var(--line)}header.top .in{max-width:640px;margin:0 auto;padding:14px 16px;display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.brand{display:flex;align-items:center;margin-right:auto}.brand img{height:22px;display:block}
.navlink{font-family:var(--mono);font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);padding:6px 8px;border-radius:var(--r)}.navlink:hover{color:var(--fg)}.navlink.on{color:var(--fg);box-shadow:inset 0 -1px 0 var(--fg)}
.label{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--mute)}
.headline{font-family:var(--display);font-weight:700;font-size:clamp(34px,9vw,48px);line-height:1.06;letter-spacing:-.035em;color:var(--mute);margin:0;text-wrap:balance}.headline .hi{color:var(--fg)}
.lead{color:var(--dim);font-size:16px;margin:14px 0 0;text-wrap:pretty}.dim{color:var(--dim)}.mute{color:var(--mute)}.small{font-size:13px}
.stack{display:flex;flex-direction:column;gap:48px;padding:40px 0 8px}
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0 0 12px}.section-head h2{margin:0;font-family:var(--display);font-size:20px;font-weight:600;letter-spacing:-.02em}
.section-head a{font-family:var(--mono);font-size:12px;color:var(--dim)}.section-head a:hover{color:var(--fg)}
.box{border:1px solid var(--line);border-radius:var(--r);background:var(--surface)}
.links{display:flex;flex-wrap:wrap;gap:8px 22px;margin-top:18px}.links a{display:inline-flex;align-items:center;gap:6px;color:var(--dim)}.links a:hover{color:var(--fg)}.links a.go{color:var(--accent)}
.links .icon{font-size:16px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;padding:0 14px;border-radius:var(--r);border:1px solid var(--fg);background:var(--fg);color:#07080a;font:inherit;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap}
.btn:hover{background:#c9ccd0;border-color:#c9ccd0}.btn.line{background:none;color:var(--fg);border-color:var(--line-strong)}.btn.line:hover{border-color:var(--fg)}.btn.small{height:30px;padding:0 10px;font-size:13px}.btn .icon{font-size:16px}
.rows{display:flex;flex-direction:column}.item{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:14px;align-items:center;padding:12px 14px}.item+.item{border-top:1px solid var(--line)}
a.item:hover,.item.link:hover{background:var(--surface-2)}.item h3{margin:0;font-size:15px;font-weight:600;line-height:1.35;display:flex;gap:8px;align-items:center;flex-wrap:wrap}.item p{margin:2px 0 0;color:var(--dim);font-size:14px}
.tile{width:40px;height:40px;border-radius:var(--r);border:1px solid var(--line);background:var(--well);display:grid;place-items:center;color:var(--fg);position:relative;overflow:hidden;font-family:var(--display);font-weight:700}
.tile .icon{font-size:20px}.tile img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:var(--well)}
.tag{display:inline-flex;align-items:center;font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute);border:1px solid var(--line);border-radius:4px;padding:0 6px;line-height:18px;font-weight:400}
.tag.hi{color:var(--accent);border-color:rgb(29 155 240 / .35)}
.dot{width:7px;height:7px;border-radius:50%;flex:none;display:inline-block;background:var(--mute)}.dot.on{background:var(--accent)}.dot.off{background:none;box-shadow:inset 0 0 0 1.5px var(--mute)}
.counters{display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}.counter{padding:12px 14px;min-width:0}.counter+.counter{border-left:1px solid var(--line)}
.counter b{display:block;font-family:var(--display);font-size:22px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.kv{display:grid;grid-template-columns:110px minmax(0,1fr);gap:14px;padding:11px 14px;align-items:baseline}.kv+.kv{border-top:1px solid var(--line)}.kv .label{padding-top:2px}.kv .v{color:var(--dim);overflow-wrap:anywhere}.kv .v a{color:var(--accent)}
.foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px;padding:10px 14px;border-top:1px solid var(--line);background:var(--well);font-family:var(--mono);font-size:12px;color:var(--dim)}
input,textarea,select{width:100%;padding:9px 12px;border:1px solid var(--line-strong);border-radius:var(--r);background:var(--well);color:inherit;font:inherit;font-size:15px}input:focus,textarea:focus,select:focus{outline:none;border-color:var(--accent)}
textarea{min-height:90px;resize:vertical}label{display:block;margin:16px 0 6px;font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--mute)}
.error{color:var(--fg);border-left:2px solid var(--fg);padding-left:10px}.ok{color:var(--accent)}
code,pre{font-family:var(--mono);font-size:12.5px}code{background:var(--well);border:1px solid var(--line);padding:1px 5px;border-radius:4px}pre{background:var(--well);border:1px solid var(--line);border-radius:var(--r);padding:12px 14px;white-space:pre-wrap;word-break:break-all;margin:8px 0}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.suffix{white-space:nowrap;color:var(--mute);font-family:var(--mono);font-size:13px}
.page-head{padding:40px 0 4px}.page-head h1{font-family:var(--display);font-weight:700;font-size:clamp(30px,8vw,40px);letter-spacing:-.035em;line-height:1.08;margin:0}
.back{display:inline-flex;align-items:center;gap:4px;font-family:var(--mono);font-size:12px;color:var(--dim);margin-top:28px}.back:hover{color:var(--fg)}.back .icon{font-size:16px}
footer.bottom{margin-top:64px;border-top:1px solid var(--line)}footer.bottom .wrap{display:flex;gap:6px 18px;flex-wrap:wrap;padding-top:16px;padding-bottom:48px;font-family:var(--mono);font-size:12px;color:var(--mute)}footer.bottom a:hover{color:var(--fg)}
@media (max-width:560px){.counters{grid-template-columns:repeat(2,minmax(0,1fr))}.counter:nth-child(3){border-left:0}.counter:nth-child(n+3){border-top:1px solid var(--line)}.kv{grid-template-columns:1fr;gap:2px}.item{grid-template-columns:40px minmax(0,1fr)}.item>.aside{grid-column:2}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}`;

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Inter+Tight:wght@600;700&family=JetBrains+Mono:wght@400;500&family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..24,300..400,0,0&display=swap">`;

export const icon = (name: string, _fill = false) => `<span class="icon" aria-hidden="true">${name}</span>`;

export type PageOptions = { status?: number; nav?: Nav; script?: string; css?: string; staff?: boolean };

export function portalPage(title: string, body: string, opts: PageOptions = {}): Response {
	const nonce = randomBytes(16).toString("base64");
	const domain = (process.env.HOSTING_DOMAIN ?? "").toLowerCase() || new URL(PUBLIC_ORIGIN).host;
	const link = (href: string, key: Nav, text: string) => `<a class="navlink${opts.nav === key ? " on" : ""}" href="${href}">${text}</a>`;
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="Xitter instances: pick one, or run your own on ${esc(domain)}.">
<link rel="icon" href="${PUBLIC_ORIGIN}/public/favicon.png">${FONTS}<style>${CSS}${opts.css ?? ""}</style></head><body>
<header class="top"><div class="in"><a class="brand" href="/"><img src="${PUBLIC_ORIGIN}/public/logo-dark.png" alt="Xitter"></a>
${link("/instances", "instances", "Instances")}${link("/apply", "run", "Run your own")}${opts.staff ? link("/staff", "staff", "Staff") : ""}
<a class="btn small line" href="${PUBLIC_ORIGIN}/" style="margin-left:6px">Open ${esc(domain)}</a></div></header>
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
