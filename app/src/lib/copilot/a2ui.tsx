import {
  basicCatalog,
  Catalog,
  type ReactComponentImplementation,
} from "@copilotkit/a2ui-renderer";
import type { CopilotKitProviderProps } from "@copilotkit/react-core/v2";

/**
 * Keep the SDK's schemas, data bindings and action handlers. The wrapper only supplies a stable
 * styling hook: the 1.70.1 basic catalog uses inline styles and does not consume the theme prop.
 * These are declarative primitives, not the separately granted OpenBot gallery/custom components.
 */
function branded(
  component: ReactComponentImplementation,
): ReactComponentImplementation {
  const Render = component.render;
  return {
    ...component,
    render: (props) => (
      <div data-openbot-a2ui={component.name} style={{ display: "contents" }}>
        <Render {...props} />
      </div>
    ),
  };
}

export const OPENBOT_A2UI_CATALOG = new Catalog(
  basicCatalog.id,
  Array.from(basicCatalog.components.values(), branded),
  Array.from(basicCatalog.functions.values()),
  basicCatalog.themeSchema,
);

const A2UI_OPTIONS = { catalog: OPENBOT_A2UI_CATALOG } satisfies NonNullable<
  CopilotKitProviderProps["a2ui"]
>;

/** Prop presence activates the SDK, so an unresolved or disabled capability must omit it. */
export function a2uiProviderOptions(enabled: boolean | undefined) {
  return enabled ? { a2ui: A2UI_OPTIONS } : {};
}
