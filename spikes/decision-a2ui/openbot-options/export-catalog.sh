#!/bin/sh
set -eu

cd "${1:?Usage: sh export-catalog.sh path/to/canvas-spike}/app"
bun --no-env-file --tsconfig-override tsconfig.json -e '
  import { exportA2UICatalog, standardUI } from "@copilotkit/react-core/v2/generative-ui";
  import { OPENBOT_UI } from "./src/lib/copilot/a2ui";

  const project = catalog => ({
    id: catalog.catalogId,
    version: catalog.protocolVersion,
    functions: Object.keys(catalog.functions).length,
    components: Object.fromEntries(
      Object.entries(catalog.components).map(([name, entry]) => [name, entry.description]),
    ),
  });

  console.log(JSON.stringify({
    openbot: project(exportA2UICatalog(OPENBOT_UI)),
    standard: project(exportA2UICatalog(standardUI)),
  }, null, 2));
'
