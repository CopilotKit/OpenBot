# LangGraph, as a Bot. Python rather than Bun because that is what the integration is published in,
# and the protocol is the only thing a Bot has to share with the others.
FROM python:3.12-slim

WORKDIR /app

# Dependencies before source, so editing the Bot does not re-resolve the framework.
COPY agent-langgraph-agui/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY agent-langgraph-agui/src ./src

ENV PORT=4206
EXPOSE 4206
# 0.0.0.0, not `::`. uvicorn binds `::` as IPv6-only, with no v4-mapped addresses, so a container
# started that way refuses 127.0.0.1: the Compose healthcheck never passes and the server cannot
# reach the Bot. Measured, not assumed. Inside a container this is the container's own namespace,
# and Compose is what decides which host addresses it is published on.
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "4206"]
