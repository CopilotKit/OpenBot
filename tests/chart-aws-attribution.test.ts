/**
 * AWS Partner Revenue Measurement, rendered by real Helm from the real chart: every AWS resource this
 * chart has a controller create carries CopilotKit's tag, so the usage it drives is credited to
 * CopilotKit. The same key and value as the bundled Intelligence's own Ingress, and the same rules.
 *
 * What must not regress, because each one is attribution silently lost, a customer's own tags
 * silently dropped, or another partner's credit taken away:
 *  - the tag is always there, with no setting, on the Ingress for every ingress class (controllers
 *    other than the AWS Load Balancer Controller ignore the annotation) and on the server's Service
 *    whenever it is a LoadBalancer;
 *  - the operator's own tags are kept, in order, with ours appended;
 *  - another partner's `aws-apn-id-<account>` tag is kept, and so is a legacy `aws-apn-id` carrying
 *    another partner's value;
 *  - a legacy `aws-apn-id` carrying our value is replaced by the suffixed key, so the load balancer
 *    is not attributed twice;
 *  - the render fails only when the operator gives our key a different value.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const helm = Bun.which("helm") !== null;
const chart = join(import.meta.dir, "../charts/openbot");

const ourKey = "aws-apn-id-058264219587";
const ourValue = "pc:avjdxr516uh0mgsqob730tzgy";
const ourTag = `${ourKey}=${ourValue}`;

type Doc = {
  kind: string;
  metadata: {
    name: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: { type?: string };
};

/** The vanilla install, with whatever a case turns on. */
function render(...args: string[]): Doc[] {
  const result = Bun.spawnSync(
    [
      "helm",
      "template",
      "openbot",
      chart,
      "--namespace",
      "openbot",
      "--values",
      join(chart, "ci/vanilla-values.yaml"),
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return parseAllDocuments(new TextDecoder().decode(result.stdout))
    .map((document) => document.toJSON() as Doc | null)
    .filter((document): document is Doc => document !== null);
}

function refusal(...args: string[]): string {
  try {
    render(...args);
  } catch (error) {
    return String(error);
  }
  return "";
}

/** This chart's own resources, not the bundled Intelligence's. */
const openbot = (doc: Doc) =>
  doc.metadata.labels?.["app.kubernetes.io/name"] === "openbot";

/** A load balancer this chart has a controller create, and where its tags go. */
type Surface = {
  name: string;
  kind: string;
  annotation: string;
  /** The values map the operator's own annotations live in. */
  values: string;
  /** Turns the surface on in the vanilla install. */
  on: string[];
  find: (docs: Doc[]) => Doc | undefined;
};

const surfaces: Surface[] = [
  {
    name: "the Ingress",
    kind: "Ingress",
    annotation: "alb.ingress.kubernetes.io/tags",
    values: "ingress.annotations",
    on: [
      "--set",
      "ingress.enabled=true",
      "--set-string",
      "ingress.className=alb",
    ],
    find: (docs) => docs.find((d) => d.kind === "Ingress" && openbot(d)),
  },
  {
    name: "the server's LoadBalancer Service",
    kind: "Service",
    annotation:
      "service.beta.kubernetes.io/aws-load-balancer-additional-resource-tags",
    values: "server.service.annotations",
    on: [
      "--set-string",
      "server.service.type=LoadBalancer",
      // The vanilla install is single-user, which is refused behind an open load balancer.
      "--set-json",
      'server.service.loadBalancerSourceRanges=["10.0.0.0/8"]',
    ],
    find: (docs) =>
      docs.find(
        (d) =>
          d.kind === "Service" &&
          openbot(d) &&
          d.metadata.labels?.["app.kubernetes.io/component"] === "server",
      ),
  },
];

/** The operator's own annotations on a surface. */
function annotations(surface: Surface, given: Record<string, string>) {
  return ["--set-json", `${surface.values}=${JSON.stringify(given)}`];
}

function tags(surface: Surface, ...args: string[]): string | undefined {
  const found = surface.find(render(...surface.on, ...args));
  expect(found?.kind).toBe(surface.kind);
  return found?.metadata.annotations?.[surface.annotation];
}

/** The tags a surface renders with the operator's own tag annotation set to `given`. */
function tagsWith(surface: Surface, given: string): string | undefined {
  return tags(
    surface,
    ...annotations(surface, { [surface.annotation]: given }),
  );
}

describe.skipIf(!helm)("AWS usage attribution", () => {
  for (const surface of surfaces) {
    describe(surface.name, () => {
      test("carries our tag with no setting", () => {
        expect(tags(surface)).toBe(ourTag);
      });

      test("keeps the operator's other annotations beside it", () => {
        const other =
          surface.kind === "Ingress"
            ? "alb.ingress.kubernetes.io/scheme"
            : "service.beta.kubernetes.io/aws-load-balancer-type";
        const found = surface.find(
          render(
            ...surface.on,
            ...annotations(surface, { [other]: "external" }),
          ),
        );
        expect(found?.metadata.annotations?.[other]).toBe("external");
        expect(found?.metadata.annotations?.[surface.annotation]).toBe(ourTag);
      });

      test("keeps the operator's and other partners' tags in order, and migrates our legacy key", () => {
        expect(
          tagsWith(
            surface,
            `Team=platform,aws-apn-id=${ourValue},aws-apn-id-999999999999=pc:anotherpartnerproductcode,CostCenter=123`,
          ),
        ).toBe(
          `Team=platform,aws-apn-id-999999999999=pc:anotherpartnerproductcode,CostCenter=123,${ourTag}`,
        );
      });

      test("keeps another partner's legacy aws-apn-id tag", () => {
        expect(
          tagsWith(surface, "aws-apn-id=pc:legacypartnerproductcode0"),
        ).toBe(`aws-apn-id=pc:legacypartnerproductcode0,${ourTag}`);
      });

      test("lists our tag once when the operator already lists it", () => {
        for (const given of [
          `Team=platform,${ourTag}`,
          `Team=platform,${ourTag},${ourTag}`,
        ]) {
          expect(tagsWith(surface, given)).toBe(`Team=platform,${ourTag}`);
        }
      });

      test("refuses a different value for our key, and nothing else", () => {
        for (const given of [
          `Team=platform, ${ourKey} = pc:someone-else`,
          ourKey,
          `${ourTag},${ourKey}=pc:someone-else`,
        ]) {
          expect(
            refusal(
              ...surface.on,
              ...annotations(surface, { [surface.annotation]: given }),
            ),
          ).toContain(
            `${surface.values} ${surface.annotation} sets ${ourKey} to a value other than ${ourValue}`,
          );
        }
      });
    });
  }

  for (const className of [
    "alb",
    "nginx",
    "",
    "webapprouting.kubernetes.azure.com",
  ]) {
    test(`the Ingress carries our tag with className ${JSON.stringify(className)}`, () => {
      const ingress = render(
        "--set",
        "ingress.enabled=true",
        "--set-string",
        `ingress.className=${className}`,
      ).find((d) => d.kind === "Ingress" && openbot(d));
      expect(
        ingress?.metadata.annotations?.["alb.ingress.kubernetes.io/tags"],
      ).toBe(ourTag);
    });
  }

  test("the Ingress tags a shared Ingress group", () => {
    const ingress = render(
      ...(surfaces[0] as Surface).on,
      "--set-json",
      'ingress.annotations={"alb.ingress.kubernetes.io/group.name":"shared"}',
    ).find((d) => d.kind === "Ingress" && openbot(d));
    expect(
      ingress?.metadata.annotations?.["alb.ingress.kubernetes.io/group.name"],
    ).toBe("shared");
    expect(
      ingress?.metadata.annotations?.["alb.ingress.kubernetes.io/tags"],
    ).toBe(ourTag);
  });

  test("a Service that is not a load balancer creates nothing in AWS, and is not tagged", () => {
    for (const type of ["ClusterIP", "NodePort"]) {
      const service = (surfaces[1] as Surface).find(
        render("--set-string", `server.service.type=${type}`),
      );
      expect(service?.spec?.type).toBe(type);
      expect(service?.metadata.annotations).toBeUndefined();
    }
  });

  test("the bundled Intelligence's own Ingress keeps its single tag", () => {
    const ingress = render(
      ...(surfaces[0] as Surface).on,
      "--set",
      "intelligence.ingress.enabled=true",
    ).find(
      (d) =>
        d.kind === "Ingress" &&
        d.metadata.labels?.["app.kubernetes.io/part-of"] === "intelligence",
    );
    expect(
      ingress?.metadata.annotations?.["alb.ingress.kubernetes.io/tags"],
    ).toBe(ourTag);
  });
});
