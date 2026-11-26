/**
 * The cards a Bot draws in a conversation (its gallery components), drawn by the phone's own renderer
 * for each name. A name this app doesn't know is skipped. ./drawn.ts says which these are and reads
 * them from a message; ../live-run.ts hands over the ones a live run is drawing.
 */
import { useContext } from "react";
import { View } from "react-native";
import type {
  ConversationMessage,
  DrawnComponent,
} from "../api/generated/model";
import { ActivityReportCard } from "./activity";
import {
  ChecklistCard,
  MetricsCard,
  NoticeCard,
  QuoteCard,
  RecordCard,
} from "./cards";
import {
  AreaChartCard,
  BarChartCard,
  LineChartCard,
  PieChartCard,
  ProgressChartCard,
} from "./charts";
import { DrawnContext } from "./context";
import { ApprovalCard, type Asked, ChoiceCard, FormCard } from "./decisions";
import { drawable } from "./drawn";
import { DataTable } from "./table";

export { DrawnContext, type DrawnSetting, type ReportRead } from "./context";
export { type Answer, answersIn, drawable } from "./drawn";
export { GALLERY_SAMPLES } from "./samples";

/** Where a message's questions stand, from where the message does. */
function askedIn(message: Pick<ConversationMessage, "status">): Asked {
  if (
    message.status === "queued" ||
    message.status === "running" ||
    message.status === "waiting"
  )
    return "waiting";
  return message.status === "failed" ? "stopped" : "done";
}

/** One component, by its name. */
export function DrawnCard({
  component,
  botId = null,
  asked = "done",
}: {
  component: DrawnComponent;
  botId?: string | null;
  asked?: Asked;
}) {
  const { arriving: streaming, answers } = useContext(DrawnContext);
  const args = component.arguments ?? {};
  const arriving = streaming.has(component.toolCallId);
  const props = { args, arriving };
  switch (component.name) {
    case "showBarChart":
      return <BarChartCard {...props} />;
    case "showPieChart":
      return <PieChartCard {...props} />;
    case "showLineChart":
      return <LineChartCard {...props} />;
    case "showAreaChart":
      return <AreaChartCard {...props} />;
    case "showProgress":
      return <ProgressChartCard {...props} />;
    case "showRecord":
      return <RecordCard {...props} />;
    case "showMetrics":
      return <MetricsCard {...props} />;
    case "showChecklist":
      return <ChecklistCard {...props} />;
    case "showNotice":
      return <NoticeCard {...props} />;
    case "showQuote":
      return <QuoteCard {...props} />;
    case "showTable":
      return <DataTable {...props} />;
    case "showActivityReport":
      return (
        <ActivityReportCard
          {...props}
          toolCallId={component.toolCallId}
          botId={botId}
        />
      );
    case "askApproval":
    case "askChoice":
    case "askForm": {
      const Card =
        component.name === "askApproval"
          ? ApprovalCard
          : component.name === "askChoice"
            ? ChoiceCard
            : FormCard;
      return (
        <Card
          {...props}
          answer={answers.get(component.toolCallId)}
          asked={arriving ? "waiting" : asked}
        />
      );
    }
    default:
      return null;
  }
}

/** The cards a message holds, in the order the Bot drew them, under what it said. */
export function DrawnCards({ message }: { message: ConversationMessage }) {
  const components = drawable(message);
  if (components.length === 0) return null;
  return (
    <View className="gap-3 self-stretch">
      {components.map((component) => (
        <DrawnCard
          key={component.toolCallId}
          component={component}
          botId={message.botId}
          asked={askedIn(message)}
        />
      ))}
    </View>
  );
}
