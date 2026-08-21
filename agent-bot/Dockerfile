# The built-in Bot only speaks AG-UI and a model provider; the browser runs in a separate computer
# container so either side can be replaced independently.
FROM oven/bun:1.3-alpine

WORKDIR /app
RUN chown bun:bun /app
USER bun
COPY --chown=bun:bun agent-bot/package.json agent-bot/bun.lock ./agent-bot/
# Installed against the committed lockfile, which was not in the build context before.
RUN cd agent-bot && bun install --frozen-lockfile

# Preserve the repo layout so `../../shared/bot-prompt` resolves the same in the image and locally.
COPY --chown=bun:bun shared ./shared
COPY --chown=bun:bun agent-bot/src ./agent-bot/src

ENV PORT=4200
EXPOSE 4200
CMD ["bun", "agent-bot/src/index.ts"]
