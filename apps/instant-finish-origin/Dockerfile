FROM python:3.13-slim-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.lock /app/requirements.lock
RUN pip install --no-cache-dir -r /app/requirements.lock
COPY grant.py publication.py storage.py index.py mezzanine.py lib_audio.py lib_origin.py service_auth.py server.py /app/
COPY entrypoint.sh /entrypoint.sh
RUN chmod 0555 /entrypoint.sh

ENV ORIGIN_BIND=0.0.0.0 \
    ORIGIN_PORT=3020 \
    ORIGIN_HOST_PUBLISH=127.0.0.1 \
    ORIGIN_CACHE=/var/cache/origin \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 3020
ENTRYPOINT ["/entrypoint.sh"]
