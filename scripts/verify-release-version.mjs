import { readFileSync } from "node:fs";

const tag = process.env.GITHUB_REF_NAME || process.argv[2] || "";
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const expected = tag.replace(/^v/, "");

if (!expected) {
  console.error("No release tag provided.");
  process.exit(1);
}

if (version !== expected) {
  console.error(`package.json version ${version} does not match release tag ${tag}.`);
  process.exit(1);
}

console.log(`Release version ok: ${version}`);
