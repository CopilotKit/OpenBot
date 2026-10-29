import { Component, type ReactNode } from "react";

/**
 * A component that throws must not take the conversation with it.
 *
 * Browser-authored components render in the transcript from model-supplied arguments, sometimes
 * while a tool call is still streaming. A render failure is isolated to the component card and shown
 * as a user-readable failure line; stacks stay in the developer console.
 */
export class ToolRenderBoundary extends Component<
  {
    name: string;
    children: ReactNode;
    /**
     * Changes when the call's arguments do. A card that failed on arguments still streaming gets
     * another chance with the next chunk, because half an argument list is often what it choked on.
     */
    resetKey?: unknown;
    /** The call is complete: a failure now is about the arguments themselves, and it stays. */
    final?: boolean;
  },
  { failed: boolean; failedFinal: boolean; key: unknown }
> {
  state = { failed: false, failedFinal: false, key: undefined as unknown };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: { resetKey?: unknown },
    state: { failed: boolean; failedFinal: boolean; key: unknown },
  ) {
    if (props.resetKey === state.key) return null;
    if (state.failed && !state.failedFinal && props.resetKey !== undefined) {
      return { key: props.resetKey, failed: false };
    }
    return { key: props.resetKey };
  }

  componentDidCatch(error: unknown) {
    this.setState({ failedFinal: Boolean(this.props.final) });
    // Keep stack details out of the conversation while preserving them for component authors.
    console.error(
      "[gallery] a component failed to render",
      this.props.name,
      error,
    );
  }

  render() {
    if (this.state.failed) {
      return (
        <p className="my-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          Couldn't show <span className="font-medium">{this.props.name}</span>.
          The rest of the conversation is fine.
        </p>
      );
    }
    return this.props.children;
  }
}
