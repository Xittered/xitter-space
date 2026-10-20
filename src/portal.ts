// my.<HOSTING_DOMAIN>: the way into the whole network. A landing page,
// /instances to browse them, /instances/<id> for one, and the hosting
// application (hosting.ts, at /apply).
//
// What it shows about other instances comes from two places: what federation
// already brought here (accounts, posts, last sync) and each one's
// /.well-known/xitter, asked every 10 minutes (up or down, peers, rules).

import { lookup } from "node:dns/promises";
import { esc } from "./account-page";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { FEDERATION_ON, INSTANCE_ID, ID_RE, listed, peers, readLimited } from "./federation";
import { HOSTING_DOMAIN, HOSTING_ON, SITE_HOST, SITE_ORIGIN, applyRoutes, fqdn, publicAddress, redirect } from "./hosting";
import { icon, portalPage } from "./portal-layout";
import { settings } from "./settings";

type Probe = { ok: boolean; ms: number; at: number; peers: string[]; federating: boolean; rules: boolean; rulesUrl: string | null; signup: string | null; error?: string };

export type Instance = {
	id: string;
	name: string;
	source: string | null;
	fork: boolean;
	main: boolean;
	hosted: boolean;
	listed: boolean;
	about: string | null;
	status: "online" | "offline" | "checking";
	ms: number | null;
	accounts: number;
	posts: number;
	peers: string[];
	rulesUrl: string | null;
	signup: string | null;
	lastSync: Date | null;
};

// ── what we know ──────────────────────────────────────────────────────────

const probes = new Map<string, Probe>();

async function probe(id: string): Promise<Probe> {
	const started = Date.now();
	const fail = (error: string): Probe => ({ ok: false, ms: Date.now() - started, at: Date.now(), peers: [], federating: false, rules: false, rulesUrl: null, signup: null, error });
	try {
		const host = id.replace(/:\d+$/, "");
		const addresses = await lookup(host, { all: true });
		if (!addresses.length || addresses.some((a) => !publicAddress(a.address))) return fail("not a public address");
		const r = await fetch(`https://${id}/.well-known/xitter`, { redirect: "error", signal: AbortSignal.timeout(8000) });
		if (!r.ok) return fail(`answered ${r.status}`);
		const info: any = JSON.parse(new TextDecoder().decode(await readLimited(r, 256 * 1024)));
		if (info?.software !== "xitter" || info.id !== id) return fail("not answering as itself");
		const list = Array.isArray(info.federation?.peers) ? info.federation.peers : [];
		return {
			ok: true,
			ms: Date.now() - started,
			at: Date.now(),
			peers: list.filter((p: any) => p?.federating && typeof p.id === "string" && ID_RE.test(p.id)).map((p: any) => p.id).slice(0, 200),
			federating: !!info.federation?.enabled,
			rules: !!info.rules,
			rulesUrl: typeof info.rules_url === "string" && info.rules_url.startsWith(`https://${id}/`) ? info.rules_url : null,
			signup: ["open", "invite", "closed"].includes(info.signup) ? info.signup : null,
		};
	} catch (e) {
		return fail(e instanceof Error ? e.message.slice(0, 120) : "unreachable");
	}
}

async function probeAll() {
	const ids = new Set(listed().filter((i) => i.state === "active" && i.id !== INSTANCE_ID).map((i) => i.id));
	for (const h of await sql`select name from hosted_instances where state = 'live'`.catch(() => [])) ids.add(fqdn(h.name));
	await Promise.all([...ids].map(async (id) => probes.set(id, await probe(id))));
}

export function startPortal() {
	if (!HOSTING_ON) return;
	setTimeout(() => probeAll().catch(() => {}), 5_000).unref();
	setInterval(() => probeAll().catch(() => {}), 10 * 60_000).unref();
}

let counted: { at: number; accounts: Map<string, number>; posts: Map<string, number>; synced: Map<string, Date | null>; hosted: Map<string, { about: string; source: string | null }> } | undefined;

// counts from this database, kept 5 minutes; "" is this instance
async function counts() {
	if (counted && Date.now() - counted.at < 5 * 60_000) return counted;
	const [accounts, posts, synced, hosted] = await Promise.all([
		sql`select coalesce(instance, '') as instance, count(*)::int as n from users where status = 'active' and deactivated_at is null group by 1`,
		sql`select coalesce(u.instance, '') as instance, count(*)::int as n from posts p join users u on u.id = p.user_id group by 1`,
		sql`select instance, last_ok_at from federation_peers`.catch(() => []),
		sql`select name, about, source_url from hosted_instances where state = 'live'`,
	]);
	counted = {
		at: Date.now(),
		accounts: new Map(accounts.map((r: any) => [r.instance, r.n])),
		posts: new Map(posts.map((r: any) => [r.instance, r.n])),
		synced: new Map(synced.map((r: any) => [r.instance, r.last_ok_at])),
		hosted: new Map(hosted.map((r: any) => [fqdn(r.name), { about: r.about, source: r.source_url }])),
	};
	return counted;
}

const OFFICIAL = /^https:\/\/github\.com\/Xittered\/xitter\/?$/i;

export async function instances(): Promise<Instance[]> {
	const c = await counts();
	const out: Instance[] = [];
	const add = (id: string, name: string, source: string | null, isListed: boolean) => {
		const main = id === INSTANCE_ID;
		const p = probes.get(id);
		const hosted = c.hosted.get(id);
		out.push({
			id,
			name,
			source: source ?? hosted?.source ?? null,
			fork: !!(source ?? hosted?.source) && !OFFICIAL.test(source ?? hosted?.source ?? ""),
			main,
			hosted: !!HOSTING_DOMAIN && id.endsWith(`.${HOSTING_DOMAIN}`),
			listed: isListed,
			about: hosted?.about ?? null,
			status: main ? "online" : !p ? "checking" : p.ok ? "online" : "offline",
			ms: main ? null : (p?.ms ?? null),
			accounts: c.accounts.get(main ? "" : id) ?? 0,
			posts: c.posts.get(main ? "" : id) ?? 0,
			peers: main ? (FEDERATION_ON ? peers().map((x) => x.id) : []) : (p?.peers ?? []),
			rulesUrl: main ? (settings().rules.trim() ? `${PUBLIC_ORIGIN}/rules` : null) : (p?.rulesUrl ?? null),
			signup: main ? settings().signup_mode : (p?.signup ?? null),
			lastSync: main ? null : (c.synced.get(id) ?? null),
		});
	};
	for (const i of listed()) if (i.state === "active") add(i.id, i.name, i.source_url, true);
	if (!out.some((i) => i.main)) add(INSTANCE_ID, settings().instance_name, settings().source_url, false);
	for (const id of c.hosted.keys()) if (!out.some((i) => i.id === id)) add(id, id.slice(0, -HOSTING_DOMAIN.length - 1), null, false);
	return out.sort((a, b) => Number(b.main) - Number(a.main) || b.accounts - a.accounts || a.name.localeCompare(b.name, "en"));
}

// ── bits ──────────────────────────────────────────────────────────────────

const num = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : n.toLocaleString("en-US"));

function ago(d: Date | null): string {
	if (!d) return "never";
	const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
	return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
}

const SIGNUP: Record<string, [string, string]> = { open: ["Open sign-ups", "green"], invite: ["Invite only", "amber"], closed: ["Sign-ups closed", ""] };
const STATUS: Record<Instance["status"], string> = { online: "Online", offline: "Offline", checking: "Checking" };

// the instance's own favicon over its first letter, which shows if the icon doesn't load
const avatar = (i: Instance, size = 44) =>
	`<div class="av" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px"><span>${esc((i.name.trim()[0] ?? "?").toUpperCase())}</span><img alt="" loading="lazy" src="https://${esc(i.id)}/public/favicon.png"></div>`;

function tags(i: Instance) {
	const t: string[] = [];
	if (i.main) t.push(`<span class="tag blue">${icon("star", true)} Main</span>`);
	if (i.hosted && !i.main) t.push(`<span class="tag blue">${icon("dns")} ${esc(HOSTING_DOMAIN)}</span>`);
	if (i.signup && SIGNUP[i.signup]) t.push(`<span class="tag ${SIGNUP[i.signup]![1]}">${esc(SIGNUP[i.signup]![0])}</span>`);
	if (i.fork) t.push(`<span class="tag">${icon("fork_right")} Fork</span>`);
	if (!i.listed) t.push(`<span class="tag amber">New</span>`);
	return t.join("");
}

function card(i: Instance) {
	return `<article class="card inst" data-name="${esc(`${i.name} ${i.id}`.toLowerCase())}" data-status="${i.status}" data-signup="${esc(i.signup ?? "")}" data-hosted="${i.hosted}" data-accounts="${i.accounts}" data-posts="${i.posts}" data-title="${esc(i.name.toLowerCase())}">
<div class="inst-head">${avatar(i)}<div class="inst-name"><a href="/instances/${esc(i.id)}"><b>${esc(i.name)}</b></a><div class="dim small">${esc(i.id)}</div></div>
<span class="status" title="${i.ms ? `${i.ms} ms` : ""}"><span class="dot ${i.status === "online" ? "on" : i.status === "offline" ? "off" : ""}"></span>${STATUS[i.status]}</span></div>
<div class="tags">${tags(i)}</div>
<div class="stats"><span title="Accounts">${icon("group")} ${num(i.accounts)}</span><span title="Posts">${icon("chat_bubble")} ${num(i.posts)}</span><span title="Instances it federates with">${icon("hub")} ${i.peers.length}</span></div>
<div class="row"><a class="btn small" href="https://${esc(i.id)}/">Open ${icon("arrow_outward")}</a><a class="btn ghost small" href="/instances/${esc(i.id)}">Details</a></div></article>`;
}

const CARD_CSS = `.small{font-size:13px}.inst{display:flex;flex-direction:column;gap:14px;transition:border-color .15s}.inst:hover{border-color:#536471}
.inst-head{display:flex;gap:12px;align-items:center}.inst-name{flex:1;min-width:0}.inst-name a{color:var(--text)}.inst-name b{font-size:16px}.inst-name .dim{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.av{position:relative;flex:none;border-radius:12px;background:#16181c;border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--dim);overflow:hidden}
.av img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000}.status{display:flex;align-items:center;gap:7px;font-size:13px;color:var(--dim);white-space:nowrap}
.tags{display:flex;gap:6px;flex-wrap:wrap;min-height:22px}.tags .icon{font-size:14px;vertical-align:-2px}.stats{display:flex;gap:18px;color:var(--dim);font-size:14px}.stats .icon{font-size:18px}`;

// broken favicons and logos go, so the letter or nothing shows instead
const IMG_SCRIPT = `document.querySelectorAll(".av img,img[data-optional]").forEach(function(i){function gone(){i.remove()}if(i.complete&&!i.naturalWidth)gone();else i.addEventListener("error",gone)});`;

const HOME_CSS = `.hero{position:relative;overflow:hidden;padding:72px 0 40px}
.hero .wrap:first-child{max-width:1080px}
.hero h1{font-size:52px;font-weight:800;margin:0 0 16px;letter-spacing:-.03em}.hero h1 em{font-style:normal;color:var(--dim)}
.hero .lead{font-size:19px;max-width:520px}
.numbers{display:grid;grid-template-columns:repeat(4,1fr);margin-top:36px;border:1px solid var(--line);border-radius:18px;background:var(--card)}.numbers div{padding:16px 20px}.numbers div+div{border-left:1px solid var(--line)}.numbers b{display:block;font-size:26px;font-weight:700;letter-spacing:-.02em}.numbers span{color:var(--dim);font-size:14px}
.how{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.how .card .icon{font-size:20px;color:var(--dim);margin-right:8px}.how h3{margin:0 0 6px;font-size:16px;display:flex;align-items:center}.how p{margin:0;color:var(--dim)}
.band{display:grid;grid-template-columns:1fr auto;gap:24px;align-items:center}
.band ol{margin:12px 0 0;padding-left:20px;color:var(--dim)}.band ol b{color:var(--text)}.head-row{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-bottom:20px;flex-wrap:wrap}
@media (max-width:860px){.hero h1{font-size:44px}.numbers{grid-template-columns:repeat(2,1fr)}.numbers div:nth-child(3){border-left:0}.numbers div:nth-child(n+3){border-top:1px solid var(--line)}.how{grid-template-columns:1fr}.band{grid-template-columns:1fr}}`;

async function home(): Promise<Response> {
	const list = await instances();
	const online = list.filter((i) => i.status === "online").length;
	const accounts = list.reduce((s, i) => s + i.accounts, 0);
	const posts = list.reduce((s, i) => s + i.posts, 0);
	const links = new Set(list.flatMap((i) => i.peers.map((p) => [i.id, p].sort().join(" ")))).size;
	return portalPage(
		"Xitter · find your instance",
		`<div class="hero"><div class="wrap"><div>
<h1>Your timeline, on <em>servers people run</em>.</h1>
<p class="lead">Xitter is the X app with an open backend. Join an instance, follow anyone on any of them, or start your own on ${esc(HOSTING_DOMAIN)}.</p>
<div class="row"><a class="btn blue" href="/instances">Find an instance</a><a class="btn ghost" href="/apply">Run your own</a></div>
</div></div>
<div class="wrap"><div class="numbers"><div><b>${list.length}</b><span>instances</span></div><div><b>${online}</b><span>online now</span></div><div><b>${num(accounts)}</b><span>accounts</span></div><div><b>${num(links)}</b><span>federation links</span></div></div></div></div>
<section><div class="wrap"><h2>How it works</h2><p class="lead">One app, many servers, one conversation.</p><div class="how">
<div class="card"><h3>${icon("phone_iphone")}The app you know</h3><p>The real X web app, so there's nothing new to learn.</p></div>
<div class="card"><h3>${icon("hub")}Instances talk</h3><p>Follow, like, repost and reply across instances.</p></div>
<div class="card"><h3>${icon("gavel")}Their own rules</h3><p>Each instance moderates its own people.</p></div></div></div></section>
<section><div class="wrap"><div class="head-row"><div><h2>Popular instances</h2><p class="lead" style="margin:0">${num(posts)} posts across the network.</p></div><a class="btn ghost small" href="/instances">All ${list.length} instances ${icon("arrow_forward")}</a></div>
<div class="grid">${list.slice(0, 3).map(card).join("")}</div></div></section>
<section><div class="wrap"><div class="card band"><div><h2>Run your own</h2><p class="dim" style="margin:0">Get <b style="color:var(--text)">yourname.${esc(HOSTING_DOMAIN)}</b> for your server, free.</p>
<ol><li><b>Apply</b> with a name and your server's address.</li><li><b>Set up</b> Xitter and Caddy; it gets its own certificate.</li><li><b>Go live</b> and join the federation.</li></ol></div>
<a class="btn blue" href="/apply">Apply for a name</a></div></div></section>`,
		{ nav: "home", css: HOME_CSS + CARD_CSS, script: IMG_SCRIPT },
	);
}

// ── /instances ────────────────────────────────────────────────────────────

const LIST_CSS = `.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:20px 0}.toolbar input{flex:1;min-width:220px}.toolbar select{width:auto}
.chips{display:flex;gap:6px;flex-wrap:wrap}.chip{padding:7px 14px;border-radius:999px;border:1px solid var(--line);background:none;color:var(--text);font:inherit;font-size:14px;font-weight:600;cursor:pointer}.chip:hover{background:#181919}.chip.on{background:var(--text);color:#0f1419;border-color:var(--text)}
.none{display:none;text-align:center;padding:48px 0;color:var(--dim)}`;

const LIST_SCRIPT = `${IMG_SCRIPT}
(function(){var q=document.getElementById("q"),sort=document.getElementById("sort"),grid=document.getElementById("grid"),none=document.getElementById("none"),filter="all";
var cards=[].slice.call(grid.children);
function apply(){var t=q.value.trim().toLowerCase(),shown=0;
cards.sort(function(a,b){var k=sort.value;if(k==="name")return a.dataset.title.localeCompare(b.dataset.title);return Number(b.dataset[k])-Number(a.dataset[k])});
cards.forEach(function(c){var ok=(!t||c.dataset.name.indexOf(t)>=0)&&(filter==="all"||(filter==="online"&&c.dataset.status==="online")||(filter==="open"&&c.dataset.signup==="open")||(filter==="hosted"&&c.dataset.hosted==="true"));c.style.display=ok?"":"none";if(ok)shown++;grid.appendChild(c)});
none.style.display=shown?"none":"block";}
q.addEventListener("input",apply);sort.addEventListener("change",apply);
document.querySelectorAll(".chip").forEach(function(b){b.addEventListener("click",function(){document.querySelectorAll(".chip").forEach(function(x){x.classList.toggle("on",x===b)});filter=b.dataset.filter;apply()})});
})();`;

async function instancesPage(error = ""): Promise<Response> {
	const list = await instances();
	const online = list.filter((i) => i.status === "online").length;
	return portalPage(
		"Instances · Xitter",
		`<div class="wrap"><div class="page-head"><h1>Instances</h1><p class="lead">${list.length} instances, ${online} online right now. Pick one to join; you can follow people on all the others from there.</p></div>
<div class="toolbar"><input id="q" type="search" placeholder="Search by name or address" aria-label="Search instances">
<select id="sort" aria-label="Sort"><option value="accounts">Most accounts</option><option value="posts">Most posts</option><option value="name">Name</option></select></div>
<div class="chips" style="margin-bottom:20px"><button class="chip on" data-filter="all">All</button><button class="chip" data-filter="online">Online</button><button class="chip" data-filter="hosted">On ${esc(HOSTING_DOMAIN)}</button></div>
<div class="grid" id="grid">${list.map(card).join("")}</div><div class="none" id="none">${icon("search_off")} Nothing matches.</div>
<div class="card" style="margin-top:32px"><form method="get" action="/go" class="row"><span class="dim">${icon("link")} Know the address?</span><input name="to" placeholder="xit.example.org" maxlength="253" style="flex:1;min-width:200px"><button class="btn small">Go</button></form>${error ? `<p class="error" style="margin:10px 0 0">${esc(error)}</p>` : ""}</div></div>`,
		{ nav: "instances", css: CARD_CSS + LIST_CSS, script: LIST_SCRIPT },
	);
}

// ── /instances/<id> ───────────────────────────────────────────────────────

const ONE_CSS = `.banner{position:relative;border-radius:22px;overflow:hidden;border:1px solid var(--line);background:var(--card);padding:28px 24px;margin-top:20px}
.banner .top{display:flex;gap:18px;align-items:center;flex-wrap:wrap}.banner h1{font-size:40px;margin:0}.banner .logo{max-height:56px;max-width:220px;margin-left:auto}
.facts{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:16px 0}.facts .card b{display:block;font-size:26px;font-weight:800}.facts .card span{color:var(--dim);font-size:13px}
.info{display:grid;grid-template-columns:180px 1fr;gap:10px 16px;margin:0}.info dt{color:var(--dim)}.info dd{margin:0}
.peerlist{display:flex;gap:8px;flex-wrap:wrap}.peer{display:inline-flex;align-items:center;gap:7px;padding:6px 12px;border:1px solid var(--line);border-radius:999px;color:var(--text);font-size:14px}.peer:hover{background:#181919;text-decoration:none}
@media (max-width:700px){.facts{grid-template-columns:repeat(2,1fr)}.info{grid-template-columns:1fr}.banner .logo{margin-left:0}}`;

async function instancePage(id: string): Promise<Response> {
	const list = await instances();
	const i = list.find((x) => x.id === id);
	if (!i) return portalPage("Not found · Xitter", `<div class="wrap"><div class="page-head"><h1>Not on the list</h1><p class="lead">${esc(id)} isn't an instance we know.</p><a class="btn" href="/instances">All instances</a></div></div>`, { status: 404, nav: "instances" });
	const known = new Set(list.map((x) => x.id));
	const peerChips = i.peers.length
		? `<div class="peerlist">${i.peers
				.map((p) => {
					const o = list.find((x) => x.id === p);
					return known.has(p) ? `<a class="peer" href="/instances/${esc(p)}"><span class="dot ${o?.status === "online" ? "on" : o?.status === "offline" ? "off" : ""}"></span>${esc(o?.name ?? p)}</a>` : `<span class="peer">${esc(p)}</span>`;
				})
				.join("")}</div>`
		: `<p class="dim">${i.status === "offline" ? "Unknown while it's offline." : "None yet."}</p>`;
	const rows: [string, string][] = [
		["Address", `<a href="https://${esc(i.id)}/">${esc(i.id)}</a>`],
		["Status", `<span class="row" style="gap:8px"><span class="dot ${i.status === "online" ? "on" : i.status === "offline" ? "off" : ""}"></span>${STATUS[i.status]}${i.ms ? ` <span class="dim">· answered in ${i.ms} ms</span>` : ""}</span>`],
		["Sign-ups", i.signup && SIGNUP[i.signup] ? esc(SIGNUP[i.signup]![0]) : `<span class="dim">Not shared</span>`],
		["Rules", i.rulesUrl ? `<a href="${esc(i.rulesUrl)}">Read the rules ${icon("arrow_outward")}</a>` : `<span class="dim">Not found</span>`],
		["Code", i.source ? `<a href="${esc(i.source)}">${i.fork ? "Fork" : "Xitter"} source ${icon("arrow_outward")}</a>` : `<span class="dim">Not shared</span>`],
	];
	if (i.hosted) rows.push(["Hosted", `On ${esc(HOSTING_DOMAIN)}${i.about ? `<div class="dim">${esc(i.about)}</div>` : ""}`]);
	if (!i.main) rows.push(["Last sync", `${esc(ago(i.lastSync))} <span class="dim">with ${esc(INSTANCE_ID)}</span>`]);
	return portalPage(
		`${i.name} · Xitter`,
		`<div class="wrap"><p style="margin:24px 0 0"><a href="/instances">${icon("arrow_back")} All instances</a></p>
<div class="banner"><div class="top">${avatar(i, 64)}<div><h1>${esc(i.name)}</h1><div class="dim">${esc(i.id)}</div></div><img class="logo" data-optional alt="" src="https://${esc(i.id)}/public/logo-dark.png"></div>
<div class="tags" style="margin-top:18px">${tags(i)}</div>
<div class="row" style="margin-top:20px"><a class="btn blue" href="https://${esc(i.id)}/">Open ${esc(i.name)} ${icon("arrow_outward")}</a>${i.rulesUrl ? `<a class="btn ghost" href="${esc(i.rulesUrl)}">${icon("gavel")} Rules</a>` : ""}</div></div>
<div class="facts"><div class="card"><b>${num(i.accounts)}</b><span>accounts${i.main ? "" : " seen here"}</span></div><div class="card"><b>${num(i.posts)}</b><span>posts${i.main ? "" : " seen here"}</span></div><div class="card"><b>${i.peers.length}</b><span>federates with</span></div><div class="card"><b>${i.ms ? `${i.ms}<small style="font-size:14px"> ms</small>` : "–"}</b><span>response</span></div></div>
<div class="grid" style="grid-template-columns:1fr 1fr"><div class="card"><h3 style="margin-top:0">About</h3><dl class="info">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl></div>
<div class="card"><h3 style="margin-top:0">Federates with</h3>${peerChips}</div></div>
${i.main ? "" : `<p class="dim small" style="margin-top:16px">${icon("info")} Accounts and posts are what reached ${esc(INSTANCE_ID)} through federation.</p>`}</div>`,
		{ nav: "instances", css: CARD_CSS + ONE_CSS + `@media (max-width:760px){.grid[style]{grid-template-columns:1fr!important}}`, script: IMG_SCRIPT },
	);
}

// ── routing ───────────────────────────────────────────────────────────────

// only to instances someone could also pick from the list
async function go(url: URL): Promise<Response> {
	const to = (url.searchParams.get("to") ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
	if (!(await instances()).some((i) => i.id === to)) return instancesPage(to ? `${to} isn't on the list of instances.` : "Type an instance's address.");
	return redirect(`https://${to}/`);
}

export async function portalSite(req: Request, url: URL): Promise<Response> {
	const p = url.pathname;
	if (url.hostname !== SITE_HOST) return new Response(null, { status: 301, headers: { location: `${SITE_ORIGIN}${p}${url.search}` } });
	if (req.method === "GET") {
		if (p === "/") return home();
		if (p === "/instances") return instancesPage();
		if (p.startsWith("/instances/")) return instancePage(p.slice(11).toLowerCase());
		if (p === "/go") return go(url);
	}
	return applyRoutes(req, url);
}
