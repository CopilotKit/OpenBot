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
    /secretKeyRef:\s*\n\s*name:\s*(\S+)\s*\n\s*key:\s*([A-Za-z0-9._-]+)(?:\s*\n\s*optional:\s*(true|false))?/g,
  ),
];

/*
 * A check that finds nothing is not a check that passed.
 *
 * Every one of these questions is asked by matching text, and text moves: rename a field, reindent a
 * template, and the pattern quietly stops matching. The result is a green tick that means "I looked
 * at nothing", which is worse than no check at all because somebody trusts it. Every target this
 * chart has renders a Deployment that reads secrets, so zero is always wrong.
 */
if (demands.length === 0) {
  console.error(
    "::error::This check found no secretKeyRef at all, which cannot be right. Its patterns have stopped matching the rendered output.",
  );
  process.exit(1);
}
/*
 * Unless the Secret is somebody else's. A deployment pointing at an existing Secret, or at a store
 * through an ExternalSecret, renders none of its own, and there is nothing here to compare against.
 * That is a legitimate shape, not a broken pattern.
 */
const secretComesFromOutside =
  text.includes("kind: ExternalSecret") || text.includes("existingSecret");
if (written.size === 0 && !secretComesFromOutside) {
  console.error(
    "::error::This check found no rendered Secret to compare against. Its patterns have stopped matching the rendered output.",
  );
  process.exit(1);
}
let skippedOptional = 0;
for (const [, rawName, rawKey, optional] of demands) {
  /*
   * An optional key absent from the Secret is the deployment saying it does not need it, which is a
   * legitimate shape rather than a fault. It is worth counting out loud: a key that is optional when
   * it should not be is exactly how a required value went missing and was invisible here.
   */
  if (optional === "true") {
    skippedOptional += 1;
    continue;
  }
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

/**
 * A policy that fences the API off from the services it cannot work without.
 *
 * The same question as the Secret one above, asked of the other thing a render can be internally
 * wrong about: this chart requires CopilotKit Intelligence and an identity provider, reaches both
 * over HTTPS at hostnames, and also writes the rule that says where the API may go. Those two had
 * never been compared. The server's egress named DNS, the database and the computers, so on any
 * cluster that enforces policy nobody could sign in and no conversation ran — and the pod stayed
 * Ready throughout, because `/health` answers from a literal.
 *
 * Asked of the rendered object rather than the template, because the rule that covered for this was
 * conditional on `computers.mode` and only one mode ever had it.
 */
const serverPolicy = documents.find(
  (document) =>
    /^kind:\s*NetworkPolicy\s*$/m.test(document) &&
    /app\.kubernetes\.io\/component:\s*server/.test(document),
);
if (serverPolicy) {
  const egress = serverPolicy.split(/^\s{2}egress:\s*$/m)[1] ?? "";
  if (!/port:\s*443\b/.test(egress)) {
    problems.push(
      "The server's NetworkPolicy has no egress on 443, so the API cannot reach Intelligence or an identity provider. Nothing would report it: /health answers from a literal and every probe reads it.",
    );
  }
}

// A pod no policy selects keeps the cluster default, so on a release that has policies it is the
// only unfenced one. Asked of rendered objects, because the question is which pods came out.
const policyComponents = new Set(
  documents
    .filter((document) => /^kind:\s*NetworkPolicy\s*$/m.test(document))
    .flatMap((document) => {
      const selector = document.split(/^\s{2}podSelector:\s*$/m)[1] ?? "";
      const found = selector.match(
        /app\.kubernetes\.io\/component:\s*([\w-]+)/,
      );
      return found?.[1] ? [found[1]] : [];
    }),
);
if (policyComponents.size > 0) {
  const workloads = documents.filter((document) =>
    /^kind:\s*(Deployment|StatefulSet|CronJob|Job|DaemonSet)\s*$/m.test(
      document,
    ),
  );
  for (const workload of workloads) {
    const component = workload.match(
      /app\.kubernetes\.io\/component:\s*([\w-]+)/,
    )?.[1];
    const name = workload.match(/^\s{2}name:\s*(\S+)/m)?.[1] ?? "a workload";
    if (!component) continue;
    // The migrations Job runs once at install and is torn down; it is not a standing surface.
    if (component === "migrations") continue;
    if (!policyComponents.has(component)) {
      problems.push(
        `This release has NetworkPolicies but none selects ${name} (component: ${component}), so it is the one pod left unfenced while everything around it is restricted. Give it a policy or say in the chart why it needs none.`,
      );
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}

console.log(
  `${documents.length} objects, ${demands.length} secret keys demanded, and every required one is written.` +
    (serverPolicy ? " The server's egress reaches 443." : "") +
    (skippedOptional > 0
      ? ` ${skippedOptional} optional key${skippedOptional === 1 ? " was" : "s were"} not checked.`
      : ""),
);
