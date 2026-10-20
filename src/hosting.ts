// Community instances under one domain: someone with an account here applies on
// my.<HOSTING_DOMAIN> (HOSTING_SITE) for name.<HOSTING_DOMAIN>, staff review it in the admin
// panel, and approving it creates one DNS-only record pointing at their server.
// Revoking deletes the record. Off unless HOSTING_DOMAIN, HOSTING_CF_TOKEN and
// HOSTING_CF_ZONE are set (a Cloudflare token that can edit that zone's DNS).
//
// The apply site runs in this process, picked by hostname. It can't see this
// instance's cookies, so signing in is a hand-off: /account/hosting/handoff on
// the main site gives a one-time ticket, bound to a state cookie on the apply
// site, which trades it for a session of its own.

import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { esc } from "./account-page";
import type { Viewer } from "./auth";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { INSTANCE_ID, listed, readLimited } from "./federation";
import { hateInName } from "./hate";
import { newId } from "./ids";
import { requestIp } from "./login-history";
import { blockedNameIn } from "./names";
import { hit } from "./ratelimit";
import { settings } from "./settings";

export const HOSTING_DOMAIN = (process.env.HOSTING_DOMAIN ?? "").toLowerCase();
const CF_TOKEN = process.env.HOSTING_CF_TOKEN ?? "";
const CF_ZONE = process.env.HOSTING_CF_ZONE ?? "";
export const HOSTING_ON = !!(HOSTING_DOMAIN && CF_TOKEN && CF_ZONE);
export const SITE_HOST = `${(process.env.HOSTING_SITE ?? "my").toLowerCase()}.${HOSTING_DOMAIN}`;
// where the site was first; it sends people on
const OLD_HOST = `apply.${HOSTING_DOMAIN}`;
export const isHostingSite = (host: string) => host === SITE_HOST || host === OLD_HOST;
const SITE_ORIGIN = `https://${SITE_HOST}`;

const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const random = () => randomBytes(32).toString("base64url");
const COOKIE = "Path=/; HttpOnly; Secure; SameSite=Lax";

// ── names and targets ─────────────────────────────────────────────────────

// 3 to 30 letters, digits and hyphens, no hyphen at either end and no "--"
// (xn-- is punycode, and a lookalike waiting to happen)
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
export const RESERVED = new Set(
	("www my hub api apply mail smtp imap pop pop3 mx ns ns1 ns2 dns admin root status docs blog help support staff team " +
		"xitter xit official verify verification mobile app apps cdn static media assets img files ftp git auth login logout " +
		"signin signup account accounts security abuse postmaster hostmaster webmaster test dev staging beta alpha demo " +
		"x twitter grok instance instances federation").split(" "),
);

export function nameProblem(name: string): string | undefined {
	if (!LABEL_RE.test(name) || name.includes("--")) return "Names are 3 to 30 lowercase letters, digits and single hyphens, not starting or ending with one.";
	if (RESERVED.has(name)) return "That name is reserved.";
	if (blockedNameIn(name) || hateInName(name)) return "That name isn't allowed here.";
}

const closed = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const)
	closed.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["::1", 128], ["64:ff9b:1::", 48], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const)
	closed.addSubnet(net, bits, "ipv6");
export const publicAddress = (ip: string) => {
	const v = isIP(ip);
	// an IPv4 address written as IPv6 (::ffff:a.b.c.d) is never taken; BlockList
	// would match every IPv4 address against a ::ffff:0:0/96 entry
	if (v === 6 && /^::ffff:/i.test(ip)) return false;
	return v === 4 ? !closed.check(ip, "ipv4") : v === 6 ? !closed.check(ip, "ipv6") : false;
};

const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// a public IPv4 or IPv6 address, or a hostname outside the hosting domain
export function parseTarget(raw: string): { target: string; type: "A" | "AAAA" | "CNAME" } | { error: string } {
	const t = raw.trim().toLowerCase().replace(/\.$/, "");
	const v = isIP(t);
	if (v) return publicAddress(t) ? { target: t, type: v === 4 ? "A" : "AAAA" } : { error: "That address isn't reachable from the internet." };
	if (!HOST_RE.test(t)) return { error: "Give your server's public IP address or hostname." };
	if (HOSTING_DOMAIN && (t === HOSTING_DOMAIN || t.endsWith(`.${HOSTING_DOMAIN}`))) return { error: `Point it at your own server, not at ${HOSTING_DOMAIN}.` };
	return { target: t, type: "CNAME" };
}

export const fqdn = (name: string) => `${name}.${HOSTING_DOMAIN}`;

// ── Cloudflare ────────────────────────────────────────────────────────────

export class HostingError extends Error {}

export async function cf(method: string, path: string, body?: unknown): Promise<any> {
	const r = await fetch(`https://api.cloudflare.com/client/v4/zones/${CF_ZONE}${path}`, {
		method,
		headers: { authorization: `Bearer ${CF_TOKEN}`, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(15_000),
	});
	const j: any = await r.json().catch(() => ({}));
	if (!j.success) throw new HostingError(`Cloudflare: ${j.errors?.map((e: any) => e.message).join(", ") || `HTTP ${r.status}`}`);
	return j.result;
}

export const recordsFor = async (name: string): Promise<any[]> => cf("GET", `/dns_records?name=${encodeURIComponent(fqdn(name))}`);

async function nameTaken(name: string): Promise<boolean> {
	const [row] = await sql`select 1 from hosted_instances where name = ${name} and state in ('pending', 'approved', 'live')`;
	if (row) return true;
	return HOSTING_ON && (await recordsFor(name)).length > 0;
}

// ── health check ──────────────────────────────────────────────────────────

// is name.<domain> a Xitter instance that says it is name.<domain>? Its
// addresses are checked first, so a record can't make us fetch a private one
export async function checkInstance(name: string): Promise<{ ok: boolean; text: string; key?: string }> {
	const host = fqdn(name);
	try {
		const addresses = await lookup(host, { all: true });
		if (!addresses.length || addresses.some((a) => !publicAddress(a.address))) return { ok: false, text: "it resolves to an address that isn't public" };
		const r = await fetch(`https://${host}/.well-known/xitter`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
		if (!r.ok) return { ok: false, text: `/.well-known/xitter answered ${r.status}` };
		const info: any = JSON.parse(new TextDecoder().decode(await readLimited(r, 64 * 1024)));
		if (info?.software !== "xitter") return { ok: false, text: "it doesn't say it runs Xitter" };
		if (info.id !== host) return { ok: false, text: `it calls itself ${String(info.id).slice(0, 100)}, not ${host} (set PUBLIC_ORIGIN)` };
		if (!info.rules) return { ok: false, text: "it has no rules yet (Admin > Settings)" };
		return { ok: true, text: "up, running Xitter, rules written", key: typeof info.public_key === "string" && /^[A-Za-z0-9_-]{43}$/.test(info.public_key) ? info.public_key : undefined };
	} catch (e) {
		return { ok: false, text: e instanceof Error ? e.message.slice(0, 200) : "unreachable" };
	}
}

export async function runCheck(id: string) {
	const [row] = await sql`select name, state from hosted_instances where id = ${id}::bigint`;
	if (!row || !["approved", "live"].includes(row.state)) return;
	const c = await checkInstance(row.name);
	await sql`update hosted_instances set last_check_at = now(), last_check = ${c.text}, public_key = coalesce(${c.key ?? null}, public_key),
		state = case when state = 'approved' and ${c.ok} then 'live' else state end, updated_at = now() where id = ${id}::bigint`;
	return c;
}

// every few hours: approved instances that came up go live, live ones that
// went down show it in the admin panel
export function startHostingChecks() {
	if (!HOSTING_ON) return;
	const all = async () => {
		for (const r of await sql`select id::text from hosted_instances where state in ('approved', 'live')`) await runCheck(r.id).catch(() => {});
	};
	setTimeout(all, 60_000).unref();
	setInterval(all, 6 * 3600_000).unref();
}

// ── signing in on the apply site ──────────────────────────────────────────

// on the main site: a ticket for the apply site, for whoever is signed in here
export async function hostingHandoff(url: URL, viewer: Viewer | undefined): Promise<Response> {
	const state = url.searchParams.get("state") ?? "";
	if (!HOSTING_ON || !/^[A-Za-z0-9_-]{43}$/.test(state)) return new Response("not found", { status: 404 });
	if (!viewer || viewer.instance) {
		return page("Sign in first", `<h1>Sign in first</h1><p>Sign in to <a href="${PUBLIC_ORIGIN}/">${esc(new URL(PUBLIC_ORIGIN).host)}</a> with your account, then come back to <a href="${SITE_ORIGIN}/">${esc(SITE_HOST)}</a> and press Sign in again.</p>`);
	}
	const ticket = random();
	await sql`delete from hosting_tickets where created_at < now() - interval '2 minutes'`;
	await sql`insert into hosting_tickets (ticket_hash, user_id, state) values (${digest(ticket)}, ${viewer.id}::bigint, ${state})`;
	return redirect(`${SITE_ORIGIN}/callback?ticket=${ticket}&state=${state}`);
}

type Applicant = { id: string; screen_name: string; csrf: string; status: string };

async function applicant(req: Request): Promise<Applicant | undefined> {
	const token = cookie(req, "apply_session");
	if (!token) return;
	const [s] = await sql`select u.id::text, u.screen_name, s.csrf, u.status from hosting_sessions s join users u on u.id = s.user_id
		where s.token_hash = ${digest(token)} and s.created_at > now() - interval '30 days' and u.deactivated_at is null`;
	return s as Applicant | undefined;
}

const cookie = (req: Request, name: string) =>
	(req.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);

const redirect = (to: string, cookies: string[] = []) => {
	const headers = new Headers({ location: to, "cache-control": "no-store" });
	for (const c of cookies) headers.append("set-cookie", c);
	return new Response(null, { status: 303, headers });
};

// ── the apply site ────────────────────────────────────────────────────────

const CSS = `:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#000;color:#e7e9ea;font:15px/1.5 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:620px;margin:0 auto;padding:40px 16px 64px}h1{font-size:28px;margin:0 0 12px}h2{font-size:19px;margin:28px 0 8px}a{color:#1d9bf0}
.dim{color:#71767b}.card{border:1px solid #2f3336;border-radius:16px;padding:16px;margin:16px 0}.error{color:#f4212e}.ok{color:#00ba7c}
label{display:block;margin:14px 0 4px;font-weight:700}input,textarea{width:100%;padding:10px 12px;border:1px solid #333639;border-radius:6px;background:#000;color:inherit;font:inherit}
textarea{min-height:80px}button,.button{display:inline-block;margin-top:16px;padding:9px 18px;border:0;border-radius:999px;background:#eff3f4;color:#0f1419;font:inherit;font-weight:700;cursor:pointer;text-decoration:none}
button.secondary{background:none;border:1px solid #536471;color:#e7e9ea}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.suffix{white-space:nowrap;color:#71767b}
code{background:#16181c;padding:1px 5px;border-radius:4px}.instance{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:8px 0;padding:12px 16px}
.instance .button{margin:0;flex:none}.tag{font-size:12px;border:1px solid #2f3336;border-radius:999px;padding:0 8px;color:#71767b;font-weight:400}.error{margin-top:8px}ul{padding-left:20px}footer{margin-top:40px;font-size:13px}`;

function page(title: string, body: string, status = 200): Response {
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · ${esc(HOSTING_DOMAIN || "Xitter")}</title><style>${CSS}</style></head>
<body><main>${body}<footer class="dim">Run by <a href="${PUBLIC_ORIGIN}/">${esc(settings().instance_name)}</a> · <a href="${esc(settings().source_url)}">source</a></footer></main></body></html>`,
		{ status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' " + PUBLIC_ORIGIN, "referrer-policy": "same-origin", "x-frame-options": "DENY" } },
	);
}

const STATE_TEXT: Record<string, string> = {
	pending: "Waiting for review.",
	approved: "Approved. The address points at your server; it shows as live once it answers as a Xitter instance with rules.",
	live: "Live.",
};

// every instance someone can join: the shared list, plus hosted ones that are
// up but not on it yet. This one first, then by name
async function instances(): Promise<{ id: string; name: string; source: string | null; listed: boolean }[]> {
	const out = listed()
		.filter((i) => i.state === "active")
		.map((i) => ({ id: i.id, name: i.name, source: i.source_url, listed: true }));
	for (const h of await sql`select name, source_url from hosted_instances where state = 'live'`)
		if (!out.some((i) => i.id === fqdn(h.name))) out.push({ id: fqdn(h.name), name: h.name, source: h.source_url, listed: false });
	return out.sort((a, b) => (a.id === INSTANCE_ID ? -1 : b.id === INSTANCE_ID ? 1 : a.name.localeCompare(b.name, "en")));
}

async function welcome(error = ""): Promise<Response> {
	const list = await instances();
	const card = (i: (typeof list)[number]) => `<div class="card instance"><div><b>${esc(i.name)}</b>${i.id === INSTANCE_ID ? ` <span class="tag">main</span>` : ""}${i.listed ? "" : ` <span class="tag">new</span>`}
<div class="dim">${esc(i.id)}${i.source && !/github\.com\/Xittered\/xitter\/?$/i.test(i.source) ? ` · <a href="${esc(i.source)}">fork</a>` : ""}</div></div><a class="button" href="https://${esc(i.id)}/">Open</a></div>`;
	return page(
		"Xitter",
		`<h1>Xitter</h1>
<p>The X web app on servers people run themselves. Pick one, or run your own.</p>
<h2>Instances</h2>
${list.map(card).join("\n")}
<form method="get" action="/go" class="row" style="margin-top:12px"><input name="to" placeholder="Go to another instance: xit.example.org" maxlength="253" style="flex:1"><button style="margin:0">Go</button></form>
${error ? `<p class="error">${esc(error)}</p>` : ""}
<h2>Run your own</h2>
<p>Get <b>yourname.${esc(HOSTING_DOMAIN)}</b> for your server, or use your own domain with the <a href="${esc(settings().source_url)}">source</a>.</p>
<p><a class="button" href="/apply">Apply for a name</a></p>
<h2>Staff</h2>
<p><a href="${PUBLIC_ORIGIN}/?staff=1">Sign in</a> · <a href="${PUBLIC_ORIGIN}/admin">Admin panel</a></p>`,
	);
}

// only to instances someone could also pick from the list, so this can't
// send people anywhere else
async function go(url: URL): Promise<Response> {
	const to = (url.searchParams.get("to") ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
	if (!(await instances()).some((i) => i.id === to)) return welcome(to ? `${to} isn't on the list of instances.` : "Type an instance's address.");
	return redirect(`https://${to}/`);
}

function intro() {
	return `<h1>Host your instance on ${esc(HOSTING_DOMAIN)}</h1>
<p>Run your own Xitter instance and get <b>yourname.${esc(HOSTING_DOMAIN)}</b> pointing at your server. Staff of ${esc(settings().instance_name)} review every name and instance first.</p>
<h2>Before you apply</h2>
<ul>
<li>Your server runs <a href="${esc(settings().source_url)}">Xitter</a> (or a fork that keeps its source open).</li>
<li>Set <code>PUBLIC_ORIGIN=https://yourname.${esc(HOSTING_DOMAIN)}</code> and get a certificate for that name on your server (the record is DNS-only).</li>
<li>Write your rules (Admin &gt; Settings). They must cover everything <a href="https://github.com/Xittered/xitter/blob/main/FEDERATION.md">FEDERATION.md</a> bans.</li>
<li>One instance per account. A name can be taken back if the instance breaks the rules or stays down.</li>
</ul>`;
}

export async function applySite(req: Request, url: URL): Promise<Response> {
	const p = url.pathname;
	if (url.hostname !== SITE_HOST) return new Response(null, { status: 301, headers: { location: `${SITE_ORIGIN}${p}${url.search}` } });
	const ip = requestIp(req) ?? "unknown";
	if (p === "/login") {
		if (!hit("auth", ip).ok) return page("Slow down", "<h1>Too many tries</h1><p>Wait a few minutes.</p>", 429);
		const state = random();
		return redirect(`${PUBLIC_ORIGIN}/account/hosting/handoff?state=${state}`, [`apply_state=${state}; ${COOKIE}; Max-Age=600`]);
	}
	if (p === "/callback") {
		if (!hit("auth", ip).ok) return page("Slow down", "<h1>Too many tries</h1><p>Wait a few minutes.</p>", 429);
		const ticket = url.searchParams.get("ticket") ?? "", state = url.searchParams.get("state") ?? "";
		const fail = () => page("Sign-in failed", `<h1>That didn't work</h1><p>The sign-in link was used, expired or opened in another browser. <a href="/login">Try again</a>.</p>`, 400);
		if (!state || cookie(req, "apply_state") !== state || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return fail();
		const [t] = await sql`delete from hosting_tickets where ticket_hash = ${digest(ticket)} and state = ${state} and created_at > now() - interval '2 minutes' returning user_id::text`;
		if (!t) return fail();
		const token = random();
		await sql`delete from hosting_sessions where created_at < now() - interval '30 days'`;
		await sql`insert into hosting_sessions (token_hash, user_id, csrf) values (${digest(token)}, ${t.user_id}::bigint, ${random()})`;
		return redirect("/apply", [`apply_session=${token}; ${COOKIE}; Max-Age=${30 * 86400}`, `apply_state=; ${COOKIE}; Max-Age=0`]);
	}
	if (p === "/" && req.method === "GET") return welcome();
	if (p === "/go") return go(url);
	if (p !== "/apply" && p !== "/withdraw" && p !== "/check" && p !== "/logout") return page("Not found", `<h1>Not found</h1><p><a href="/">Back</a></p>`, 404);

	const me = await applicant(req);
	if (req.method === "POST") {
		const f = await req.formData().catch(() => undefined);
		const value = (k: string) => String(f?.get(k) ?? "");
		if (!me || value("csrf") !== me.csrf || req.headers.get("origin") !== SITE_ORIGIN) return page("Out of date", `<h1>That form is out of date</h1><p><a href="/apply">Reload</a> and try again.</p>`, 403);
		if (p === "/logout") {
			await sql`delete from hosting_sessions where token_hash = ${digest(cookie(req, "apply_session")!)}`;
			return redirect("/", [`apply_session=; ${COOKIE}; Max-Age=0`]);
		}
		if (p === "/apply") return apply(me, f!);
		const [mine] = await sql`select id::text, state, dns_record_id, last_check_at from hosted_instances where user_id = ${me.id}::bigint and state in ('pending', 'approved', 'live')`;
		if (p === "/withdraw" && mine) {
			if (mine.dns_record_id) await cf("DELETE", `/dns_records/${mine.dns_record_id}`).catch(() => {});
			await sql`update hosted_instances set state = 'withdrawn', dns_record_id = null, updated_at = now() where id = ${mine.id}::bigint`;
		}
		if (p === "/check" && mine && ["approved", "live"].includes(mine.state) && !(mine.last_check_at && Date.now() - new Date(mine.last_check_at).getTime() < 60_000)) await runCheck(mine.id);
		return redirect("/apply");
	}

	if (p !== "/apply") return page("Not found", `<h1>Not found</h1><p><a href="/">Back</a></p>`, 404);
	const back = `<p><a href="/">← All instances</a></p>`;
	if (!me) return page("Apply", `${back}${intro()}<p><a class="button" href="/login">Sign in with your ${esc(new URL(PUBLIC_ORIGIN).host)} account</a></p>`);
	const signedIn = `${back}<form method="post" action="/logout" class="row dim"><input type="hidden" name="csrf" value="${esc(me.csrf)}">Signed in as @${esc(me.screen_name)} <button class="secondary" style="margin:0">Sign out</button></form>`;
	const [mine] = await sql`select id::text, name, target, state, last_check, last_check_at from hosted_instances where user_id = ${me.id}::bigint and state in ('pending', 'approved', 'live')`;
	const [last] = mine ? [] : await sql`select name, state, review_note from hosted_instances where user_id = ${me.id}::bigint order by updated_at desc limit 1`;
	if (mine) {
		const csrf = `<input type="hidden" name="csrf" value="${esc(me.csrf)}">`;
		return page("Your instance", `${signedIn}<h1>${esc(fqdn(mine.name))}</h1>
<div class="card"><p>${esc(STATE_TEXT[mine.state] ?? mine.state)}</p><p class="dim">Points at <code>${esc(mine.target)}</code>.${mine.last_check ? ` Last check: ${esc(mine.last_check)}.` : ""}</p>
${mine.state === "pending" ? "" : `<form method="post" action="/check" style="display:inline">${csrf}<button class="secondary">Check now</button></form> `}
<form method="post" action="/withdraw" style="display:inline">${csrf}<button class="secondary">${mine.state === "pending" ? "Withdraw the application" : "Give the name back"}</button></form></div>
${mine.state === "live" ? `<p>To federate with other instances, open a pull request that adds yours to <a href="https://github.com/Xittered/xitter/blob/main/instances.json">instances.json</a>.</p>` : ""}`);
	}
	return page("Apply", `${signedIn}${intro()}${last && ["rejected", "revoked"].includes(last.state) ? `<div class="card"><p class="error">${esc(fqdn(last.name))} was ${esc(last.state)}.${last.review_note ? ` ${esc(last.review_note)}` : ""}</p></div>` : ""}${form(me)}`);
}

function form(me: Applicant, error = "", v: Record<string, string> = {}) {
	return `<h2>Apply</h2>${error ? `<p class="error">${esc(error)}</p>` : ""}
<form method="post" action="/apply"><input type="hidden" name="csrf" value="${esc(me.csrf)}">
<label for="name">Name</label><div class="row"><input id="name" name="name" required maxlength="30" pattern="[a-z0-9-]{3,30}" value="${esc(v.name ?? "")}" style="flex:1"><span class="suffix">.${esc(HOSTING_DOMAIN)}</span></div>
<label for="target">Your server</label><input id="target" name="target" required maxlength="253" placeholder="203.0.113.7, 2001:db8::7 or host.example.org" value="${esc(v.target ?? "")}">
<label for="about">What is it for?</label><textarea id="about" name="about" maxlength="1000" required>${esc(v.about ?? "")}</textarea>
<label for="source">Source code (if it's a fork)</label><input id="source" name="source" maxlength="300" placeholder="https://github.com/..." value="${esc(v.source ?? "")}">
<label for="contact">How staff can reach you besides here (optional)</label><input id="contact" name="contact" maxlength="200" placeholder="Discord, email…" value="${esc(v.contact ?? "")}">
<button>Send the application</button></form>`;
}

async function apply(me: Applicant, f: FormData): Promise<Response> {
	const v = Object.fromEntries(["name", "target", "about", "source", "contact"].map((k) => [k, String(f.get(k) ?? "").trim()]));
	v.name = v.name!.toLowerCase();
	const again = (error: string) => page("Apply", `${intro()}${form(me, error, v)}`, 400);
	if (me.status !== "active") return again("Your account can't apply right now.");
	const nameIssue = nameProblem(v.name);
	if (nameIssue) return again(nameIssue);
	const target = parseTarget(v.target!);
	if ("error" in target) return again(target.error);
	if (!v.about || v.about.length > 1000) return again("Say in a few words what the instance is for.");
	if (v.source && !/^https:\/\/\S{1,290}$/.test(v.source)) return again("The source link must be an https address.");
	if (v.contact!.length > 200) return again("The contact is too long.");
	if (await nameTaken(v.name).catch(() => true)) return again(`${fqdn(v.name)} is taken.`);
	try {
		await sql`insert into hosted_instances (id, user_id, name, target, record_type, about, source_url, contact)
			values (${newId()}::bigint, ${me.id}::bigint, ${v.name}, ${target.target}, ${target.type}, ${v.about}, ${v.source || null}, ${v.contact})`;
	} catch {
		// the unique indexes: someone took the name, or this account already has one
		return again(`${fqdn(v.name)} is taken, or you already have an application.`);
	}
	return redirect("/apply");
}
