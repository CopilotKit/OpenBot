import { Component, type ReactNode } from "react";
import { ArgumentsArrivingContext } from "@/components/gallery/streaming";

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
  static contextType = ArgumentsArrivingContext;
  declare context: React.ContextType<typeof ArgumentsArrivingContext>;

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
    /*
     * Failed on arguments that are still arriving: nothing, until the next chunk retries it. Shown,
     * the error box flashed between chunks for the whole stream of a card that then drew fine.
     */
    if (
      this.state.failed &&
      !this.state.failedFinal &&
      !this.props.final &&
      this.props.resetKey !== undefined &&
      this.context
    ) {
      return null;
    }
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

/**
 * Whether a tool call can no longer change: it has a result, or its arguments are complete.
 *
 * NOT JUST THE RESULT. A decision has none until the person answers it, and the run stays busy for
 * the whole wait, so a decision that threw on its complete arguments was taken for one still
 * streaming and drew nothing; the turn hung invisibly until somebody pressed Stop. Streamed
 * arguments are a JSON object whose closing brace comes last, so they parse only once the last of
 * them has arrived.
 */
export function toolCallFinal(
  args: string,
  result: string | undefined,
): boolean {
  if (result !== undefined) return true;
  try {
    JSON.parse(args);
    return true;
  } catch {
    return false;
  }
}
