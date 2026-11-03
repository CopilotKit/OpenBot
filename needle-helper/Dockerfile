# Needle (cactus-compute/needle, Apache-2.0), served for OpenBot. See serve.py.
FROM python:3.12-slim
ENV NEEDLE_TELEMETRY=0 DO_NOT_TRACK=1 PYTHONUNBUFFERED=1 HF_HOME=/models
RUN pip install --no-cache-dir cactus-needle==3.2.10
WORKDIR /app
COPY serve.py .
EXPOSE 4310
CMD ["python", "-I", "serve.py"]
