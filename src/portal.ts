// my.<HOSTING_DOMAIN>: the way into the whole network. A landing page with a
// live map of the instances, /instances to browse them, /instances/<id> for
// one, /staff, and the hosting application (hosting.ts, at /apply).
//
// What it shows about other instances comes from two places: what federation
// already brought here (accounts, posts, last sync) and each one's
// /.well-known/xitter, asked every 10 minutes (up or down, peers, rules).

import { lookup } from "node:dns/promises";
import { esc } from "./account-page";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { FEDERATION_ON, INSTANCE_ID, ID_RE, listed, peers, readLimited } from "./federation";
import { HOSTING_DOMAIN, HOSTING_ON, SITE_HOST, SITE_ORIGIN, applyRoutes, fqdn, isStaffSession, publicAddress, redirect } from "./hosting";
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

const SIGNUP: Record<string, string> = { open: "Open sign-ups", invite: "Invite only", closed: "Sign-ups closed" };
const STATUS: Record<Instance["status"], string> = { online: "Online", offline: "Offline", checking: "Checking" };
const dot = (i: Instance) => `<span class="dot ${i.status === "online" ? "on" : i.status === "offline" ? "off" : ""}"></span>`;

// the instance's own favicon over its first letter, which shows if the icon doesn't load
const avatar = (i: Instance, size = 40) =>
	`<div class="tile" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px"><span>${esc((i.name.trim()[0] ?? "?").toUpperCase())}</span><img alt="" loading="lazy" src="https://${esc(i.id)}/public/favicon.png"></div>`;

function tags(i: Instance) {
	const t: string[] = [];
	if (i.main) t.push(`<span class="tag hi">Main</span>`);
	if (i.hosted && !i.main) t.push(`<span class="tag">${esc(HOSTING_DOMAIN)}</span>`);
	if (i.signup && SIGNUP[i.signup]) t.push(`<span class="tag">${esc(SIGNUP[i.signup]!)}</span>`);
	if (i.fork) t.push(`<span class="tag">Fork</span>`);
	if (!i.listed) t.push(`<span class="tag">New</span>`);
	return t.join("");
}

// one instance as a list row: icon tile, name and tags, address and numbers, Open and Details
function card(i: Instance) {
	return `<div class="item inst" data-name="${esc(`${i.name} ${i.id}`.toLowerCase())}" data-status="${i.status}" data-signup="${esc(i.signup ?? "")}" data-hosted="${i.hosted}" data-accounts="${i.accounts}" data-posts="${i.posts}" data-title="${esc(i.name.toLowerCase())}">
${avatar(i)}<div style="min-width:0"><h3><a href="/instances/${esc(i.id)}">${esc(i.name)}</a>${tags(i)}</h3>
<p class="meta"><span title="${i.ms ? `${i.ms} ms` : ""}">${dot(i)} ${STATUS[i.status]}</span><span>${esc(i.id)}</span><span title="Accounts">${num(i.accounts)} acc</span><span title="Posts">${num(i.posts)} posts</span><span title="Instances it federates with">${i.peers.length} peers</span></p></div>
<div class="aside row" style="gap:6px"><a class="btn small" href="https://${esc(i.id)}/">Open ${icon("arrow_outward")}</a><a class="btn small line" href="/instances/${esc(i.id)}">Details</a></div></div>`;
}

const CARD_CSS = `.inst h3 a:hover{text-decoration:underline}.meta{display:flex;flex-wrap:wrap;gap:2px 12px;font-family:var(--mono);font-size:12px!important;color:var(--mute)!important;margin-top:4px!important}
.meta span{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}.tile span{color:var(--dim)}`;

// broken favicons and logos go, so the letter or nothing shows instead
const IMG_SCRIPT = `document.querySelectorAll(".tile img,img[data-optional]").forEach(function(i){function gone(){i.remove()}if(i.complete&&!i.naturalWidth)gone();else i.addEventListener("error",gone)});`;

// ── the network map ───────────────────────────────────────────────────────

// instances on a ring around the main one, a line for every pair that
// federates; drawn server-side so it needs no script
function networkMap(list: Instance[]): string {
	const W = 600, H = 360, cx = W / 2, cy = H / 2;
	const main = list.find((i) => i.main);
	const others = list.filter((i) => !i.main).slice(0, 18);
	const pos = new Map<string, [number, number]>();
	if (main) pos.set(main.id, [cx, cy]);
	others.forEach((i, n) => {
		const a = (n / Math.max(1, others.length)) * Math.PI * 2 - Math.PI / 2;
		pos.set(i.id, [cx + Math.cos(a) * 230, cy + Math.sin(a) * 130]);
	});
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const i of list)
		for (const p of i.peers) {
			const key = [i.id, p].sort().join(" ");
			if (seen.has(key) || !pos.has(i.id) || !pos.has(p)) continue;
			seen.add(key);
			const [x1, y1] = pos.get(i.id)!, [x2, y2] = pos.get(p)!;
			lines.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`);
		}
	const nodes = [...pos.entries()].map(([id, [x, y]]) => {
		const i = list.find((n) => n.id === id)!;
		const r = i.main ? 6 : 3.5;
		const label = i.name.length > 16 ? `${i.name.slice(0, 15)}…` : i.name;
		const below = y >= cy;
		return `<a href="/instances/${esc(id)}"><g class="node ${i.status}${i.main ? " main" : ""}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}"/><text x="${x.toFixed(1)}" y="${(below ? y + 18 : y - 10).toFixed(1)}">${esc(label)}</text></g></a>`;
	});
	return `<svg class="map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Instances and who federates with whom"><g class="links">${lines.join("")}</g>${nodes.join("")}</svg>`;
}

const HOME_CSS = `.map{display:block;width:100%;height:auto;padding:8px}.map line{stroke:#fff;stroke-opacity:.07;stroke-width:1}
.map .node circle{fill:var(--bg);stroke:var(--mute);stroke-width:1.2}.map .node.online circle{stroke:var(--dim)}.map .node.offline circle{stroke-dasharray:2 2}
.map .node.main circle{fill:var(--accent);stroke:var(--accent)}.map text{fill:var(--mute);font:10.5px var(--mono);text-anchor:middle}.map a:hover text{fill:var(--fg)}.map a:hover circle{stroke:var(--fg)}
.how .tile{color:var(--accent)}.band ol{margin:8px 0 0;padding-left:18px;color:var(--dim)}.band ol b{color:var(--fg);font-weight:600}`;

async function home(staff = false): Promise<Response> {
	const list = await instances();
	const online = list.filter((i) => i.status === "online").length;
	const accounts = list.reduce((s, i) => s + i.accounts, 0);
	const posts = list.reduce((s, i) => s + i.posts, 0);
	const links = new Set(list.flatMap((i) => i.peers.map((p) => [i.id, p].sort().join(" ")))).size;
	return portalPage(
		"Xitter · find your instance",
		`<div class="wrap stack"><div>
<h1 class="headline">Your timeline, on <span class="hi">servers people run</span>.</h1>
<p class="lead">Xitter is the X app with an open backend. Join an instance, follow anyone on any of them, or start your own on ${esc(HOSTING_DOMAIN)}.</p>
<div class="links"><a class="go" href="/instances">${icon("travel_explore")} Find an instance</a><a href="/apply">${icon("add_circle")} Run your own</a></div></div>
<div class="box">${networkMap(list)}<div class="counters" style="border-top:1px solid var(--line)"><div class="counter"><b>${list.length}</b><span class="label">instances</span></div><div class="counter"><b>${online}</b><span class="label">online now</span></div><div class="counter"><b>${num(accounts)}</b><span class="label">accounts</span></div><div class="counter"><b>${num(links)}</b><span class="label">federation links</span></div></div></div>
<div><div class="section-head"><h2>How it works</h2></div><p class="dim" style="margin:0 0 12px">One app, many servers, one conversation.</p><div class="box rows how">
<div class="item"><div class="tile">${icon("phone_iphone")}</div><div><h3>The app you know</h3><p>The real X web app, so there's nothing new to learn.</p></div></div>
<div class="item"><div class="tile">${icon("hub")}</div><div><h3>Instances talk</h3><p>Follow, like, repost and reply across instances.</p></div></div>
<div class="item"><div class="tile">${icon("gavel")}</div><div><h3>Their own rules</h3><p>Each instance moderates its own people.</p></div></div></div></div>
<div><div class="section-head"><h2>Popular instances</h2><a href="/instances">All ${list.length} instances ${icon("arrow_forward")}</a></div><p class="dim" style="margin:0 0 12px">${num(posts)} posts across the network.</p>
<div class="box rows">${list.slice(0, 3).map(card).join("")}</div></div>
<div class="box band"><div style="padding:16px 14px 14px"><div class="section-head" style="margin:0"><h2>Run your own</h2></div><p class="dim" style="margin:4px 0 0">Get <b style="color:var(--fg);font-weight:600">yourname.${esc(HOSTING_DOMAIN)}</b> for your server, free.</p>
<ol><li><b>Apply</b> with a name and your server's address.</li><li><b>Set up</b> Xitter and Caddy; it gets its own certificate.</li><li><b>Go live</b> and join the federation.</li></ol></div>
<div class="foot"><span>name.${esc(HOSTING_DOMAIN)}</span><a class="btn small" href="/apply">${icon("rocket_launch")} Apply for a name</a></div></div></div>`,
		{ nav: "home", css: HOME_CSS + CARD_CSS, script: IMG_SCRIPT, staff },
	);
}

// ── /instances ────────────────────────────────────────────────────────────

const LIST_CSS = `.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:24px 0 10px}.toolbar input{flex:1;min-width:200px}.toolbar select{width:auto}
.seg{display:flex;gap:2px;padding:2px;border:1px solid var(--line);border-radius:var(--r);background:var(--well);margin-bottom:14px;overflow-x:auto}
.chip{flex:1;height:32px;padding:0 12px;border:0;border-radius:4px;background:none;color:var(--dim);font-family:var(--mono);font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;cursor:pointer;white-space:nowrap}.chip:hover{color:var(--fg)}
.chip.on{background:var(--surface-2);color:var(--fg);box-shadow:0 0 0 1px var(--line)}.none{display:none;text-align:center;padding:40px 0;color:var(--mute);font-family:var(--mono);font-size:12px}`;

const LIST_SCRIPT = `${IMG_SCRIPT}
(function(){var q=document.getElementById("q"),sort=document.getElementById("sort"),grid=document.getElementById("grid"),none=document.getElementById("none"),filter="all";
var cards=[].slice.call(grid.children);
function apply(){var t=q.value.trim().toLowerCase(),shown=0;
cards.sort(function(a,b){var k=sort.value;if(k==="name")return a.dataset.title.localeCompare(b.dataset.title);return Number(b.dataset[k])-Number(a.dataset[k])});
cards.forEach(function(c){var ok=(!t||c.dataset.name.indexOf(t)>=0)&&(filter==="all"||(filter==="online"&&c.dataset.status==="online")||(filter==="open"&&c.dataset.signup==="open")||(filter==="hosted"&&c.dataset.hosted==="true"));c.style.display=ok?"":"none";if(ok)shown++;grid.appendChild(c)});
grid.style.display=shown?"":"none";none.style.display=shown?"none":"block";}
q.addEventListener("input",apply);sort.addEventListener("change",apply);
document.querySelectorAll(".chip").forEach(function(b){b.addEventListener("click",function(){document.querySelectorAll(".chip").forEach(function(x){x.classList.toggle("on",x===b)});filter=b.dataset.filter;apply()})});
})();`;

async function instancesPage(error = "", staff = false): Promise<Response> {
	const list = await instances();
	const online = list.filter((i) => i.status === "online").length;
	return portalPage(
		"Instances · Xitter",
		`<div class="wrap"><div class="page-head"><h1>Instances</h1><p class="lead">${list.length} instances, ${online} online right now. Pick one to join; you can follow people on all the others from there.</p></div>
<div class="toolbar"><input id="q" type="search" placeholder="Search by name or address" aria-label="Search instances">
<select id="sort" aria-label="Sort"><option value="accounts">Most accounts</option><option value="posts">Most posts</option><option value="name">Name</option></select></div>
<div class="seg"><button class="chip on" data-filter="all">All</button><button class="chip" data-filter="online">Online</button><button class="chip" data-filter="open">Open sign-ups</button><button class="chip" data-filter="hosted">On ${esc(HOSTING_DOMAIN)}</button></div>
<div class="box rows" id="grid">${list.map(card).join("")}</div><div class="none" id="none">${icon("search_off")} Nothing matches.</div>
<div class="box" style="margin-top:24px"><form method="get" action="/go" class="row" style="padding:12px 14px"><span class="label">${icon("link")} Know the address?</span><input name="to" placeholder="xit.example.org" maxlength="253" style="flex:1;min-width:180px"><button class="btn small">Go</button></form>${error ? `<p class="error" style="margin:0 14px 12px">${esc(error)}</p>` : ""}</div></div>`,
		{ nav: "instances", css: CARD_CSS + LIST_CSS, script: LIST_SCRIPT, staff },
	);
}

// ── /instances/<id> ───────────────────────────────────────────────────────

const ONE_CSS = `.one-head{display:flex;gap:14px;align-items:center;margin-top:18px}.one-head .logo{max-height:36px;max-width:160px;margin-left:auto;opacity:.9}
.peerlist{display:flex;gap:6px;flex-wrap:wrap;padding:12px 14px}.peer{display:inline-flex;align-items:center;gap:7px;padding:3px 10px;border:1px solid var(--line);border-radius:4px;font-family:var(--mono);font-size:12px;color:var(--dim)}a.peer:hover{color:var(--fg);border-color:var(--line-strong)}
@media (max-width:560px){.one-head .logo{display:none}}`;

async function instancePage(id: string, staff = false): Promise<Response> {
	const list = await instances();
	const i = list.find((x) => x.id === id);
	if (!i) return portalPage("Not found · Xitter", `<div class="wrap"><div class="page-head"><h1>Not on the list</h1><p class="lead">${esc(id)} isn't an instance we know.</p><div class="links"><a class="go" href="/instances">All instances</a></div></div></div>`, { status: 404, nav: "instances", staff });
	const known = new Set(list.map((x) => x.id));
	const peerChips = i.peers.length
		? `<div class="peerlist">${i.peers
				.map((p) => {
					const o = list.find((x) => x.id === p);
					return known.has(p) && o ? `<a class="peer" href="/instances/${esc(p)}">${dot(o)}${esc(o.name)}</a>` : `<span class="peer">${esc(p)}</span>`;
				})
				.join("")}</div>`
		: `<p class="dim" style="padding:12px 14px;margin:0">${i.status === "offline" ? "Unknown while it's offline." : "None yet."}</p>`;
	const rows: [string, string][] = [
		["Address", `<a href="https://${esc(i.id)}/">${esc(i.id)}</a>`],
		["Status", `<span class="row" style="gap:8px;display:inline-flex">${dot(i)}${STATUS[i.status]}</span>${i.ms ? ` <span class="mute">· answered in ${i.ms} ms</span>` : ""}`],
		["Sign-ups", i.signup && SIGNUP[i.signup] ? esc(SIGNUP[i.signup]!) : `<span class="mute">Not shared</span>`],
		["Rules", i.rulesUrl ? `<a href="${esc(i.rulesUrl)}">Read the rules ${icon("arrow_outward")}</a>` : `<span class="mute">Not found</span>`],
		["Code", i.source ? `<a href="${esc(i.source)}">${i.fork ? "Fork" : "Xitter"} source ${icon("arrow_outward")}</a>` : `<span class="mute">Not shared</span>`],
	];
	if (i.hosted) rows.push(["Hosted", `On ${esc(HOSTING_DOMAIN)}${i.about ? `<div>${esc(i.about)}</div>` : ""}`]);
	if (!i.main) rows.push(["Last sync", `${esc(ago(i.lastSync))} <span class="mute">with ${esc(INSTANCE_ID)}</span>`]);
	return portalPage(
		`${i.name} · Xitter`,
		`<div class="wrap"><a class="back" href="/instances">${icon("arrow_back")} All instances</a>
<div class="one-head">${avatar(i, 52)}<div style="min-width:0"><h1 class="headline" style="font-size:clamp(28px,7vw,38px)"><span class="hi">${esc(i.name)}</span></h1><div class="label" style="margin-top:4px">${esc(i.id)}</div></div><img class="logo" data-optional alt="" src="https://${esc(i.id)}/public/logo-dark.png"></div>
<div class="row" style="gap:6px;margin-top:14px">${tags(i)}</div>
<div class="links"><a class="go" href="https://${esc(i.id)}/">Open ${esc(i.name)} ${icon("arrow_outward")}</a>${i.rulesUrl ? `<a href="${esc(i.rulesUrl)}">${icon("gavel")} Rules</a>` : ""}</div>
<div class="box counters" style="margin-top:28px"><div class="counter"><b>${num(i.accounts)}</b><span class="label">accounts${i.main ? "" : " seen here"}</span></div><div class="counter"><b>${num(i.posts)}</b><span class="label">posts${i.main ? "" : " seen here"}</span></div><div class="counter"><b>${i.peers.length}</b><span class="label">federates with</span></div><div class="counter"><b>${i.ms ? `${i.ms}<span class="mute" style="font-size:13px"> ms</span>` : "–"}</b><span class="label">response</span></div></div>
<div class="section-head" style="margin-top:36px"><h2>About</h2></div><div class="box">${rows.map(([k, v]) => `<div class="kv"><span class="label">${k}</span><span class="v">${v}</span></div>`).join("")}</div>
<div class="section-head" style="margin-top:36px"><h2>Federates with</h2></div><div class="box">${peerChips}</div>
${i.main ? "" : `<p class="mute small" style="margin-top:14px">${icon("info")} Accounts and posts are what reached ${esc(INSTANCE_ID)} through federation.</p>`}</div>`,
		{ nav: "instances", css: CARD_CSS + ONE_CSS, script: IMG_SCRIPT, staff },
	);
}

// ── /staff ────────────────────────────────────────────────────────────────

function staffPage(): Response {
	const tile = (href: string, ic: string, title: string, text: string) => `<a class="item" href="${href}"><div class="tile">${icon(ic)}</div><div><h3>${title}</h3><p>${text}</p></div><span class="icon mute">chevron_right</span></a>`;
	return portalPage(
		"Staff · Xitter",
		`<div class="wrap"><div class="page-head"><h1>Staff</h1><p class="lead">For the team running ${esc(settings().instance_name)}.</p></div>
<div class="box rows" style="margin-top:24px">${tile(`${PUBLIC_ORIGIN}/?staff=1`, "login", "Sign in", "Works during maintenance too.")}${tile(`${PUBLIC_ORIGIN}/admin`, "admin_panel_settings", "Admin panel", "Users, reports, settings.")}
${tile(`${PUBLIC_ORIGIN}/admin#hosting`, "dns", "Hosted instances", `Review names on ${esc(HOSTING_DOMAIN)}.`)}${tile(`${PUBLIC_ORIGIN}/admin#federation`, "hub", "Federation", "Peers, keys, blocks.")}
${tile(`${PUBLIC_ORIGIN}/admin#reports`, "flag", "Reports", "What people flagged.")}${tile("https://github.com/Xittered/xitter", "code", "Source", "Issues and pull requests.")}</div></div>`,
		{ nav: "staff", staff: true },
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
	if (req.method === "GET" && (p === "/" || p === "/instances" || p.startsWith("/instances/") || p === "/staff" || p === "/go")) {
		// staff links are only for staff signed in here; to anyone else /staff doesn't exist
		const staff = await isStaffSession(req);
		if (p === "/") return home(staff);
		if (p === "/instances") return instancesPage("", staff);
		if (p.startsWith("/instances/")) return instancePage(p.slice(11).toLowerCase(), staff);
		if (p === "/staff") return staff ? staffPage() : applyRoutes(req, url);
		return go(url);
	}
	return applyRoutes(req, url);
}
