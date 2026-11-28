import { MarkImage } from "./Mark";

/** The clouds a company runs OpenBot for Business on, by their vendored marks (`shared/marks`). */
const CLOUDS = [
  { id: "aws", name: "AWS" },
  { id: "azure", name: "Azure" },
  { id: "google-cloud", name: "Google Cloud" },
  { id: "kubernetes", name: "Kubernetes" },
] as const;

/**
 * The clouds OpenBot for Business runs on, by their marks: on the first screen's Self-Hosted row
 * and page, and the move screen's OpenBot for Business row.
 */
export function CloudMarks() {
  return (
    <span className="cloud-marks">
      {CLOUDS.map((each) => (
        <span className="cloud-mark" key={each.id}>
          <MarkImage id={each.id} name={each.name} />
        </span>
      ))}
    </span>
  );
}
