/**
 * What gives away a copy of CopilotKit Intelligence's own API description, or a client generated
 * from it.
 *
 * Nothing from a source that is not public may be written into this repository, generated or not.
 * OpenBot reaches Intelligence as it ships and describes only its own operations, in api/openapi;
 * Intelligence's description, its extensions and its operation ids are never copied here, and no
 * client is generated from it here.
 *
 * tests/no-intelligence-api-copy.test.ts fails on any file that matches one of these. This is the
 * one list: a new marker is added here and nowhere else. This file is the only one the check passes
 * over, because it has to name what it looks for.
 */

export type Marker = { pattern: RegExp; why: string };

/** Where such a copy would sit. A path matching any of these is refused whatever it holds. */
export const PATHS: Marker[] = [
  {
    pattern: /(^|\/)api\/vendor\/intelligence(\/|$)/i,
    why: "a vendored copy of Intelligence's API description",
  },
  {
    // Both words, in either order and anywhere in the path.
    pattern: /^(?=.*vendor)(?=.*intelligence)/i,
    why: "a vendored copy of something of Intelligence's",
  },
  {
    pattern: /^app\/src\/lib\/api\/intelligence(\/|$)/i,
    why: "a client generated from Intelligence's API description",
  },
];

/**
 * Intelligence's operation ids. Each is caught as a whole name, and as the names a generator makes
 * from it, which start with it capitalised (`useListLearningRuns`, `getListLearningRunsUrl`,
 * `ListLearningRunsParams`). OpenBot's own operations never use these names; OpenBot's own code may
 * still start a name with one (`startLearningRunMutationOptions`), which is not a copy.
 */
export const OPERATION_IDS = [
  "listLearningCandidates",
  "getLearningCandidate",
  "getLearningInsightEvidence",
  "approveLearningCandidate",
  "rejectLearningCandidate",
  "listLearningRuns",
  "startLearningRun",
  "getProjectSkillBundle",
];

/** Text that only Intelligence's own description, or what is generated from it, contains. */
export const TEXT: Marker[] = [
  {
    pattern: /x-cpki-/i,
    why: "an extension key of Intelligence's API description",
  },
  {
    pattern: /Intelligence Product API/i,
    why: "the title of Intelligence's API description",
  },
  ...OPERATION_IDS.map((operationId) => {
    const capitalised = `${operationId.charAt(0).toUpperCase()}${operationId.slice(1)}`;
    return {
      // The id alone, or a name built on it capitalised, never inside a longer word.
      pattern: new RegExp(
        `(?<![\\w$])(?:${operationId}(?![\\w$])|(?:use|get)?${capitalised})`,
      ),
      why: `${operationId}, an operation of Intelligence's API description`,
    };
  }),
];
