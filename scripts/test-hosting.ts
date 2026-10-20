// Unit checks for the hosting application rules (src/hosting.ts): names,
// targets and which addresses count as public. bun test ./scripts/test-hosting.ts
import { describe, expect, test } from "bun:test";

process.env.HOSTING_DOMAIN ??= "xit.example";
const { nameProblem, parseTarget, publicAddress } = await import("../src/hosting");

describe("names", () => {
	test("plain names pass", () => {
		for (const n of ["abc", "my-instance", "x1x", "a2345678901234567890123456789z"]) expect(nameProblem(n)).toBeUndefined();
	});
	test("bad shapes are refused", () => {
		for (const n of ["ab", "-abc", "abc-", "ab--c", "xn--abc", "ABC", "a.b", "a_b", "a".repeat(31), ""]) expect(nameProblem(n)).toBeDefined();
	});
	test("reserved names are refused", () => {
		for (const n of ["www", "apply", "hub", "admin", "mail", "api", "staging"]) expect(nameProblem(n)).toBe("That name is reserved.");
		expect(nameProblem("my")).toBeDefined();
	});
});

describe("targets", () => {
	test("public addresses and hostnames", () => {
		expect(parseTarget("93.184.216.34")).toEqual({ target: "93.184.216.34", type: "A" });
		expect(parseTarget("2606:4700:4700::1111")).toEqual({ target: "2606:4700:4700::1111", type: "AAAA" });
		expect(parseTarget("Host.Example.org.")).toEqual({ target: "host.example.org", type: "CNAME" });
	});
	test("private, reserved and odd targets are refused", () => {
		for (const t of ["10.0.0.1", "127.0.0.1", "192.168.1.1", "172.20.0.1", "100.64.0.1", "169.254.1.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "2001:db8::1", "localhost", "no spaces.org", "http://x.org", "x"])
			expect("error" in parseTarget(t)).toBe(true);
	});
	test("the hosting domain itself is refused", () => {
		expect("error" in parseTarget("xit.example")).toBe(true);
		expect("error" in parseTarget("other.xit.example")).toBe(true);
	});
	test("publicAddress", () => {
		expect(publicAddress("1.1.1.1")).toBe(true);
		expect(publicAddress("10.1.2.3")).toBe(false);
		expect(publicAddress("not-an-ip")).toBe(false);
	});
});
