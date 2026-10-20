// Walks the apply site against a running server started with HOSTING_* set:
// sign-in hand-off, apply, the duplicate and bad-input refusals, withdraw.
// bun scripts/try-hosting.ts [user] [password]   (never approves: that makes DNS)
const origin = process.env.ORIGIN ?? "http://localhost:3000";
const domain = process.env.HOSTING_DOMAIN ?? "xitter.space";
const applyHost = `${process.env.HOSTING_SITE ?? "my"}.${domain}`;
const [user = "tester1", password = "testpass123"] = process.argv.slice(2);
let failed = 0;
const check = (what: string, ok: boolean) => {
	console.log(`${ok ? "ok" : "FAIL"}: ${what}`);
	if (!ok) failed++;
};
const jar = (r: Response) => r.headers.getSetCookie().map((c) => c.split(";")[0]!).filter((c) => !c.endsWith("="));
const apply = (path: string, init: RequestInit & { cookies?: string[] } = {}) =>
	fetch(`${origin}${path}`, { ...init, redirect: "manual", headers: { host: applyHost, cookie: (init.cookies ?? []).join("; "), ...(init.method === "POST" ? { origin: `https://${applyHost}` } : {}), ...(init.headers as any) } });

const login = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: user, password }), redirect: "manual" });
const main = jar(login);
check("signed in on the main site", main.some((c) => c.startsWith("auth_token=")));

const start = await apply("/login");
const stateCookie = jar(start);
const to = new URL(start.headers.get("location")!);
check("apply /login sends to the hand-off", to.pathname === "/account/hosting/handoff" && stateCookie[0]!.startsWith("apply_state="));

const guest = await fetch(`${origin}${to.pathname}${to.search}`, { redirect: "manual" });
check("a guest gets told to sign in first", guest.status === 200 && (await guest.text()).includes("Sign in first"));

const hand = await fetch(`${origin}${to.pathname}${to.search}`, { redirect: "manual", headers: { cookie: main.join("; ") } });
const back = new URL(hand.headers.get("location")!);
check("the hand-off gives a ticket for the apply site", back.host === applyHost && back.searchParams.has("ticket"));

const stolen = await apply(`/callback${back.search}`);
check("a ticket without the state cookie is refused", stolen.status === 400);
const hand2 = await fetch(`${origin}${to.pathname}${to.search}`, { redirect: "manual", headers: { cookie: main.join("; ") } });
const back2 = new URL(hand2.headers.get("location")!);
const cb = await apply(`/callback${back2.search}`, { cookies: stateCookie });
const session = jar(cb).filter((c) => c.startsWith("apply_session="));
check("the callback signs in on the apply site", cb.status === 303 && session.length === 1);
check("a used ticket is refused", (await apply(`/callback${back2.search}`, { cookies: stateCookie })).status === 400);

let home = await (await apply("/", { cookies: session })).text();
check("the form shows when signed in", home.includes(`Signed in as @${user}`) && home.includes('action="/apply"'));
const csrf = /name="csrf" value="([^"]+)"/.exec(home)![1]!;
const post = (path: string, body: Record<string, string>, extra: Record<string, string> = {}) =>
	apply(path, { method: "POST", cookies: session, body: new URLSearchParams({ csrf, ...body }), headers: extra });

const form = { name: `try-${Date.now().toString(36)}`, target: "93.184.216.34", about: "testing the apply flow", source: "", contact: "" };
check("a reserved name is refused", (await (await post("/apply", { ...form, name: "admin" })).text()).includes("reserved"));
check("a private target is refused", (await (await post("/apply", { ...form, target: "10.0.0.1" })).text()).includes("reachable"));
check("a missing csrf is refused", (await apply("/apply", { method: "POST", cookies: session, body: new URLSearchParams(form) })).status === 403);
check("another site's form is refused", (await post("/apply", form, { origin: "https://evil.example" })).status === 403);
check("a good application goes in", (await post("/apply", form)).status === 303);
home = await (await apply("/", { cookies: session })).text();
check("the page shows it waiting for review", home.includes(`${form.name}.${domain}`) && home.includes("Waiting for review"));
check("a second application is refused", !(await post("/apply", { ...form, name: `${form.name}x` })).headers.get("location"));
check("withdrawing works", (await post("/withdraw", {})).status === 303);
home = await (await apply("/", { cookies: session })).text();
check("the form is back after withdrawing", home.includes('action="/apply"'));
check("signing out works", (await post("/logout", {})).status === 303 && !(await (await apply("/", { cookies: session })).text()).includes("Signed in as"));

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
