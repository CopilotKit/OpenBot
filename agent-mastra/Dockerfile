# Mastra, as a Bot. Bun and Mastra's own server, because Mastra serves its AG-UI route itself
# rather than handing back a handler to mount.
FROM oven/bun:1.3-alpine

WORKDIR /app
COPY agent-mastra/package.json ./
RUN bun install

COPY shared/listen-port.ts /shared/listen-port.ts
COPY agent-mastra/src ./src

# Built at image time, not at start: `mastra start` runs a bundle, and building on every container
# start would put a build step in front of a person waiting for a Bot.
RUN bunx mastra build --dir src/mastra

ENV PORT=4213
EXPOSE 4213
CMD ["bunx", "mastra", "start"]
