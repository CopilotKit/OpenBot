import { createChannelTelegram } from "./server";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name}.`);
    process.exit(1);
  }
  return value;
}

const secret = required("OPENTAG_SHARED_SECRET");
if (secret.length < 32) {
  console.error("OPENTAG_SHARED_SECRET must be at least 32 characters.");
  process.exit(1);
}

const channel = createChannelTelegram({
  botToken: required("TELEGRAM_BOT_TOKEN"),
  sharedSecret: secret,
  openBotAgentUrl: required("OPENBOT_AGENT_URL"),
  publicUrl: required("PUBLIC_URL"),
  port: Number(process.env.PORT ?? "8787"),
});

const server = await channel.listen();
console.log(
  JSON.stringify({
    type: "channel-telegram-listen",
    port: server.port,
  }),
);
