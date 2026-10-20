// Admin panel actions for hosted instances (hosting.ts): the review queue,
// approving (creates the DNS record), rejecting, revoking, checks, and
// adopting a record someone made by hand before this existed.
// Registered into admin.ts's actions only when hosting is configured.

import { type Action, AdminError, audit, idOf } from "./admin";
import { sql } from "./db";
import { HOSTING_DOMAIN, HOSTING_ON, HostingError, OLD_HOST, SITE_HOST, cf, fqdn, isLabel, recordsFor, runCheck, zoneRecords } from "./hosting";
import { newId } from "./ids";

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

const RECORD_TYPES = ["A", "AAAA", "CNAME"];

// records under the domain that point somewhere but no hosted instance owns:
// made by hand before hosting existed. The domain itself and this site aren't
// candidates. Cloudflare being down leaves the list empty, not the page broken
async function unmanaged(): Promise<{ list: { name: string; type: string; content: string; proxied: boolean }[]; error?: string }> {
	try {
		const managed = new Set((await sql`select dns_record_id from hosted_instances where dns_record_id is not null`).map((r: any) => r.dns_record_id));
		const list = (await zoneRecords())
			.filter((r) => RECORD_TYPES.includes(r.type) && !managed.has(r.id) && r.name.endsWith(`.${HOSTING_DOMAIN}`) && r.name !== SITE_HOST && r.name !== OLD_HOST)
			.map((r) => ({ name: r.name.slice(0, -HOSTING_DOMAIN.length - 1), type: r.type, content: r.content, proxied: !!r.proxied }))
			.filter((r) => isLabel(r.name));
		return { list };
	} catch (e) {
		return { list: [], error: e instanceof Error ? e.message : "Cloudflare didn't answer." };
	}
}

// "jr1" or "jr1.<domain>" to "jr1"
const labelOf = (v: unknown) => {
	const s = typeof v === "string" ? v.trim().toLowerCase() : "";
	return s.endsWith(`.${HOSTING_DOMAIN}`) ? s.slice(0, -HOSTING_DOMAIN.length - 1) : s;
};

const note = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 500) : "");

export const hostingActions: Record<string, Action> = HOSTING_ON
	? {
			hostedInstances: {
				role: "moderator",
				run: async () => ({
					domain: HOSTING_DOMAIN,
					site: SITE_HOST,
					instances: await sql`select h.id::text, h.name, h.target, h.record_type, h.about, h.source_url, h.contact, h.state, h.review_note, h.public_key,
						h.last_check, h.last_check_at, h.created_at, h.reviewed_at, u.id::text as user_id, u.screen_name, r.screen_name as reviewed_by
						from hosted_instances h join users u on u.id = h.user_id left join users r on r.id = h.reviewed_by
						order by (h.state = 'pending') desc, (h.state in ('approved', 'live')) desc, h.updated_at desc limit 200`,
					unmanaged: await unmanaged(),
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
			// a record made by hand before hosting existed becomes an approved
			// instance of the given account, so checks and revoking cover it
			hostingAdopt: {
				role: "admin",
				run: wrap(async (a, b) => {
					const name = labelOf(b.name);
					if (!isLabel(name) || fqdn(name) === SITE_HOST || fqdn(name) === OLD_HOST) throw new AdminError(`Give the name before .${HOSTING_DOMAIN}.`);
					const handle = typeof b.owner === "string" ? b.owner.trim().replace(/^@/, "") : "";
					const [owner] = await sql`select id::text, screen_name from users where lower(screen_name) = lower(${handle}) and instance is null and status = 'active'`;
					if (!owner) throw new AdminError("No active account here with that handle.");
					const records = (await recordsFor(name)).filter((r) => RECORD_TYPES.includes(r.type));
					if (records.length !== 1)
						throw new AdminError(records.length ? `${fqdn(name)} has ${records.length} records; leave one in Cloudflare first.` : `${fqdn(name)} has no A, AAAA or CNAME record to adopt.`);
					const r = records[0];
					const id = newId();
					try {
						await sql`insert into hosted_instances (id, user_id, name, target, record_type, about, state, dns_record_id, reviewed_by, reviewed_at, review_note)
							values (${id}::bigint, ${owner.id}::bigint, ${name}, ${r.content}, ${r.type}, ${note(b.note) || "Adopted from an existing record."}, 'approved', ${r.id}, ${a.id}::bigint, now(), 'adopted')`;
					} catch {
						throw new AdminError(`${fqdn(name)} is already managed, or @${owner.screen_name} already has an instance.`);
					}
					await audit(a, "hosting_adopt", id, { name, owner: owner.screen_name, record: r.id });
					return (await runCheck(id)) ?? {};
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
