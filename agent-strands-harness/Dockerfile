# The AWS Strands harness, as a Bot. The Strands Bot's image with strands-harness added and a
# different agent mounted; what the two share is copied from shared/.
FROM python:3.12-slim

WORKDIR /app

# Dependencies before source, so editing the Bot does not re-resolve the framework.
COPY agent-strands-harness/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY agent-strands-harness/src ./src
COPY shared/model_providers.py shared/model-providers.json shared/run_model_key.py \
     shared/strands_bot.py shared/strands_system_prompt.py /shared/

ENV PORT=4217
EXPOSE 4217
# 0.0.0.0, not `::`. See agent-strands/Dockerfile.
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "4217"]
