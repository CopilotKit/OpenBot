/**
 * Is this rendered chart coherent with itself?
 *
 * Rendering proves the templates run. It does not prove the result works, and the way it fails is
 * quiet: a container names a secret key, the chart writes a Secret without it, and nothing says so
 * until a pod starts somewhere nobody is watching. Every shipped `ci/` target was in that state, on
 * the value that signs sessions, which is why the server could not start on any of them.
 *
 * Deliberately not a schema validator. Kubernetes already rejects malformed objects and a schema
 * check needs a cluster or a pinned bundle of CRDs; what it cannot see is whether the pieces this
 * chart writes agree with each other.
 */
const [file] = process.argv.slice(2);
if (!file) {
  console.error("usage: check-rendered-chart.ts <rendered.yaml>");
  process.exit(2);
}

const text = await Bun.file(file).text();
const documents = text
  .split(/^---$/m)
  .map((chunk) => chunk.trim())
  .filter((chunk) => chunk.length > 0 && !/^(#[^\n]*\n?)*$/.test(chunk));

if (documents.length === 0) {
  console.error(`${file} rendered nothing.`);
  process.exit(1);
}

const problems: string[] = [];

/**
 * Which Secret holds which keys, read from the text rather than parsed.
 *
 * A YAML parser is a dependency this check does not need: both halves of the question are single
 * lines at known indentation, and a rendered chart is machine-written, so the shapes do not vary.
 */
const written = new Map<string, Set<string>>();
for (const document of documents) {
  if (!/^kind:\s*Secret\s*$/m.test(document)) continue;
  const name = document.match(/^\s{2}name:\s*(\S+)/m)?.[1];
  if (!name) continue;
  const keys = new Set<string>();
  // `stringData` or `data`: a subchart writes base64 under the second, and a key is a key either way.
  const body = document.split(/^(?:stringData|data):\s*$/m)[1] ?? "";
  for (const line of body.split("\n")) {
    const key = line.match(/^\s{2}([a-z0-9-]+):/)?.[1];
    if (key) keys.add(key);
  }
  written.set(name.replace(/^["']|["']$/g, ""), keys);
}

/**
 * Every key a container asks for, and whether anything writes it.
 *
 * Only checked against Secrets this chart renders. A Secret that comes from outside, or from a
 * store, is not readable here, and refusing on a guess would fail installs that are fine.
 */
const demands = [
  ...text.matchAll(
    /secretKeyRef:\s*\n\s*name:\s*(\S+)\s*\n\s*key:\s*(\S+)(?:\s*\n\s*optional:\s*(true|false))?/g,
  ),
];
for (const [, rawName, rawKey, optional] of demands) {
  if (optional === "true") continue;
  const name = rawName.replace(/^["']|["']$/g, "");
  const key = rawKey.replace(/^["']|["']$/g, "");
  const keys = written.get(name);
  if (!keys) continue;
  if (!keys.has(key)) {
    problems.push(
      `A container needs "${key}" from Secret "${name}", which this chart renders without it.`,
    );
  }
}

/**
 * Anything the chart writes and nothing reads.
 *
 * The mirror of the above, and the reason a key gets quietly dropped from an environment: the
 * Secret keeps carrying it and nobody notices the variable went.
 */
for (const [name, keys] of written) {
  for (const key of keys) {
    if (!text.includes(`key: ${key}`)) {
      problems.push(
        `Secret "${name}" carries "${key}", which nothing in this render reads.`,
      );
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}

console.log(
  `${documents.length} objects, and every secret key they need is written.`,
);
