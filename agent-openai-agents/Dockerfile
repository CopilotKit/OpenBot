# The OpenAI Agents SDK, as a Bot on a ChatGPT plan. Python because that is what OpenAI publishes the
# SDK in and what the AG-UI project publishes its integration for.
FROM python:3.12-slim

WORKDIR /app

# Dependencies before source, so editing the Bot does not re-resolve the framework.
COPY agent-openai-agents/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY agent-openai-agents/src ./src

ENV PORT=4216
EXPOSE 4216
# 0.0.0.0, not `::`: uvicorn binds `::` as IPv6-only, and the Compose healthcheck and the server
# reach the Bot on IPv4.
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "4216"]
