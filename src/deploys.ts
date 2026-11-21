import { createHash, timingSafeEqual } from "node:crypto";
import { type Action, AdminError, audit } from "./admin";
import { sql } from "./db";
import { newId } from "./ids";

const TOKEN = process.env.DEPLOY_AGENT_TOKEN ?? "";
export const DEPLOYS_ON = TOKEN.length >= 32;

const SHA = /^[0-9a-f]{7,40}$/;
const STALE_MINUTES = 30;
const LOG_LIMIT = 60_000;

const digest = (s: string) => createHash("sha256").update(s).digest();

function agentAllowed(req: Request) {
	const given = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
	return DEPLOYS_ON && given.length > 0 && timingSafeEqual(digest(given), digest(TOKEN));
}

async function config() {
	const [r] = await sql`select auto, every_minutes, wait_minutes, window_from, window_to from deploy_state where id = 1`;
	return {
		auto: !!r?.auto,
		every: r?.every_minutes ?? 5,
		wait: r?.wait_minutes ?? 3,
		windowFrom: r?.window_from ?? null,
		windowTo: r?.window_to ?? null,
	};
}

const autoOn = async () => (await config()).auto;

const intIn = (v: unknown, min: number, max: number, what: string) => {
	const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
	if (!Number.isInteger(n) || n < min || n > max) throw new AdminError(`${what} must be a whole number from ${min} to ${max}.`);
	return n;
};
const hourOrNull = (v: unknown, what: string) => (v === null || v === undefined || v === "" ? null : intIn(v, 0, 23, what));

async function failStale() {
	await sql`update deploys set state = 'failed', finished_at = now(), log = log || ${"\nthe agent stopped answering, marked failed"}
		where state = 'running' and started_at < now() - ${STALE_MINUTES} * interval '1 minute'`;
}

const clip = (v: unknown, n: number) => (typeof v === "string" ? v.slice(-n) : "");

export async function deployAgentRoute(req: Request): Promise<Response> {
	if (!agentAllowed(req)) return new Response("not found", { status: 404 });
	if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
	const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
	if (b.op === "claim") {
		await failStale();
		const [running] = await sql`select id::text, kind from deploys where state = 'running' limit 1`;
		if (running) return Response.json({ ...(await config()), busy: true });
		const [job] = await sql`update deploys set state = 'running', started_at = now()
			where id = (select id from deploys where state = 'queued' order by id limit 1)
			returning id::text, kind, target`;
		return Response.json({ ...(await config()), job: job ?? null });
	}
	if (b.op === "start") {
		await failStale();
		const [busy] = await sql`select 1 from deploys where state in ('queued', 'running') limit 1`;
		if (busy) return Response.json({ ok: false });
		const id = newId();
		await sql`insert into deploys (id, kind, state, target, started_at) values (${id}::bigint, 'auto', 'running', ${clip(b.target, 40) || null}, now())`;
		return Response.json({ ok: true, id });
	}
	if (b.op === "report") {
		const id = typeof b.id === "string" && /^\d{1,19}$/.test(b.id) ? b.id : "";
		const state = b.state === "done" || b.state === "failed" ? b.state : "running";
		const sha = typeof b.sha === "string" && SHA.test(b.sha) ? b.sha : null;
		await sql`update deploys set state = ${state}, log = ${clip(b.log, LOG_LIMIT)}, sha = coalesce(${sha}, sha),
			subject = coalesce(${clip(b.subject, 200) || null}, subject), finished_at = ${state === "running" ? null : new Date()}
			where id = ${id || "0"}::bigint`;
		return Response.json({ ok: true });
	}
	return Response.json({ error: "unknown op" }, { status: 400 });
}

const jobRow = (r: any) => ({
	id: r.id,
	kind: r.kind,
	state: r.state,
	target: r.target,
	sha: r.sha,
	subject: r.subject,
	log: r.log,
	by: r.by,
	createdAt: r.created_at,
	startedAt: r.started_at,
	finishedAt: r.finished_at,
});

async function queue(kind: "update" | "rollback", target: string | null, by: string) {
	await failStale();
	return sql.begin(async (tx) => {
		await tx`lock table deploys in share row exclusive mode`;
		const [busy] = await tx`select 1 from deploys where state in ('queued', 'running') limit 1`;
		if (busy) throw new AdminError("A deploy is already queued or running. Wait for it to finish.");
		const id = newId();
		await tx`insert into deploys (id, kind, state, target, requested_by) values (${id}::bigint, ${kind}, 'queued', ${target}, ${by}::bigint)`;
		return id;
	});
}

export const deployActions: Record<string, Action> = DEPLOYS_ON
	? {
			deploys: {
				role: "admin",
				run: async () => {
					await failStale();
					const jobs = await sql`select d.id::text, d.kind, d.state, d.target, d.sha, d.subject, d.log, d.created_at, d.started_at, d.finished_at, u.screen_name as by
						from deploys d left join users u on u.id = d.requested_by order by d.id desc limit 30`;
					const versions = await sql`select distinct on (sha) sha, subject, finished_at from deploys
						where state = 'done' and sha is not null order by sha, finished_at desc`;
					return {
						...(await config()),
						jobs: jobs.map(jobRow),
						versions: (versions as any[]).sort((x, y) => +new Date(y.finished_at) - +new Date(x.finished_at)).slice(0, 15),
					};
				},
			},
			setAutoDeploy: {
				role: "admin",
				run: async (a, b) => {
					const on = b.on === true;
					await sql`insert into deploy_state (id, auto) values (1, ${on}) on conflict (id) do update set auto = excluded.auto`;
					await audit(a, "deploy_auto", null, { on });
					return { auto: on };
				},
			},
			setDeploySettings: {
				role: "admin",
				run: async (a, b) => {
					const every = intIn(b.every, 1, 1440, "Check every");
					const wait = intIn(b.wait, 0, 120, "Wait after a push");
					const from = hourOrNull(b.windowFrom, "Window start");
					const to = hourOrNull(b.windowTo, "Window end");
					if ((from === null) !== (to === null)) throw new AdminError("Give both window hours, or neither for any time.");
					await sql`insert into deploy_state (id, every_minutes, wait_minutes, window_from, window_to) values (1, ${every}, ${wait}, ${from}, ${to})
						on conflict (id) do update set every_minutes = excluded.every_minutes, wait_minutes = excluded.wait_minutes,
							window_from = excluded.window_from, window_to = excluded.window_to`;
					await audit(a, "deploy_settings", null, { every, wait, from, to });
					return config();
				},
			},
			queueDeploy: {
				role: "admin",
				run: async (a) => {
					const id = await queue("update", null, a.id);
					await audit(a, "deploy_update", null, { job: id });
					return { id };
				},
			},
			queueRollback: {
				role: "admin",
				run: async (a, b) => {
					const sha = typeof b.sha === "string" ? b.sha.trim().toLowerCase() : "";
					if (!SHA.test(sha)) throw new AdminError("Pick a version to go back to.");
					const [known] = await sql`select 1 from deploys where state = 'done' and sha = ${sha} limit 1`;
					if (!known) throw new AdminError("That version was never deployed here.");
					const id = await queue("rollback", sha, a.id);
					await sql`insert into deploy_state (id, auto) values (1, false) on conflict (id) do update set auto = false`;
					await audit(a, "deploy_rollback", null, { job: id, sha });
					return { id };
				},
			},
		}
	: {};
