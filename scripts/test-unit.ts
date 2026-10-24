// The standalone end-to-end scripts need a running server and arguments, so
// select only scripts that import Bun's test runner for this command.
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dir = new URL("./", import.meta.url);
const files = (await readdir(dir)).filter((name) => /^test-.*\.ts$/.test(name)).sort();
const units: string[] = [];
for (const name of files) {
	const file = new URL(name, dir);
	if (/from\s*["']bun:test["']/.test(await Bun.file(file).text())) units.push(fileURLToPath(file));
}
if (!units.length) throw new Error("No unit tests found.");
// hosting.ts reads HOSTING_DOMAIN once at import, and an earlier file loads it
// before test-hosting.ts can set it: the whole run gets the test domain
const env = { ...process.env, HOSTING_DOMAIN: process.env.HOSTING_DOMAIN ?? "xit.example" };
const run = Bun.spawn([process.execPath, "test", ...units], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env });
process.exit(await run.exited);
