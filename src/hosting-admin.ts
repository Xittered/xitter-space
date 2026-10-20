// Admin panel actions for hosted instances (hosting.ts): the review queue,
// approving (creates the DNS record), rejecting, revoking and checks.
// Registered into admin.ts's actions only when hosting is configured.

import { type Action, AdminError, audit, idOf } from "./admin";
import { sql } from "./db";
import { HOSTING_DOMAIN, HOSTING_ON, HostingError, cf, fqdn, recordsFor, runCheck } from "./hosting";

// Cloudflare failures read as admin errors in the panel
const wrap = (run: Action["run"]): Action["run"] => async (a, b, req) => {
	try {
		return await run(a, b, req);
	} catch (e) {
		if (e instanceof HostingError) throw new AdminError(e.message, 502);
		throw e;
	}
};

async function row(id: string) {
	const [r] = await sql`select id::text, name, target, record_type, state, dns_record_id from hosted_instances where id = ${id}::bigint`;
	if (!r) throw new AdminError("No such application.", 404);
	return r;
}

const note = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 500) : "");

export const hostingActions: Record<string, Action> = HOSTING_ON
	? {
			hostedInstances: {
				role: "moderator",
				run: async () => ({
					domain: HOSTING_DOMAIN,
					instances: await sql`select h.id::text, h.name, h.target, h.record_type, h.about, h.source_url, h.contact, h.state, h.review_note, h.public_key,
						h.last_check, h.last_check_at, h.created_at, h.reviewed_at, u.id::text as user_id, u.screen_name, r.screen_name as reviewed_by
						from hosted_instances h join users u on u.id = h.user_id left join users r on r.id = h.reviewed_by
						order by (h.state = 'pending') desc, (h.state in ('approved', 'live')) desc, h.updated_at desc limit 200`,
				}),
			},
			hostingApprove: {
				role: "admin",
				run: wrap(async (a, b) => {
					const r = await row(idOf(b.id));
					if (r.state !== "pending") throw new AdminError("Only pending applications can be approved.");
					if ((await recordsFor(r.name)).length) throw new AdminError(`${fqdn(r.name)} already has a DNS record. Remove it in Cloudflare first.`);
					const made = await cf("POST", "/dns_records", { type: r.record_type, name: fqdn(r.name), content: r.target, proxied: false, ttl: 1, comment: `xitter hosted instance ${r.id}` });
					await sql`update hosted_instances set state = 'approved', dns_record_id = ${made.id}, reviewed_by = ${a.id}::bigint, reviewed_at = now(),
						review_note = ${note(b.note) || null}, updated_at = now() where id = ${r.id}::bigint`;
					await audit(a, "hosting_approve", r.id, { name: r.name, target: r.target });
					return {};
				}),
			},
			hostingReject: {
				role: "moderator",
				run: wrap(async (a, b) => {
					const r = await row(idOf(b.id));
					if (r.state !== "pending") throw new AdminError("Only pending applications can be rejected.");
					await sql`update hosted_instances set state = 'rejected', reviewed_by = ${a.id}::bigint, reviewed_at = now(), review_note = ${note(b.note) || null}, updated_at = now() where id = ${r.id}::bigint`;
					await audit(a, "hosting_reject", r.id, { name: r.name });
					return {};
				}),
			},
			hostingRevoke: {
				role: "admin",
				run: wrap(async (a, b) => {
					const r = await row(idOf(b.id));
					if (!["approved", "live"].includes(r.state)) throw new AdminError("Only approved or live instances can be revoked.");
					if (r.dns_record_id) {
						try {
							await cf("DELETE", `/dns_records/${r.dns_record_id}`);
						} catch (e) {
							// already gone in Cloudflare is fine; anything else stops here
							if (!(await recordsFor(r.name)).every((x) => x.id !== r.dns_record_id)) throw e;
						}
					}
					await sql`update hosted_instances set state = 'revoked', dns_record_id = null, reviewed_by = ${a.id}::bigint, reviewed_at = now(), review_note = ${note(b.note) || null}, updated_at = now() where id = ${r.id}::bigint`;
					await audit(a, "hosting_revoke", r.id, { name: r.name });
					return {};
				}),
			},
			hostingCheck: {
				role: "moderator",
				run: wrap(async (_a, b) => {
					const r = await row(idOf(b.id));
					return (await runCheck(r.id)) ?? { ok: false, text: "Only approved or live instances are checked." };
				}),
			},
		}
	: {};
