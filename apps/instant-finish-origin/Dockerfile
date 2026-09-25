FROM python:3.13-slim-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 65532 origin \
    && useradd --system --uid 65532 --gid 65532 --home-dir /var/cache/origin --shell /usr/sbin/nologin origin \
    && mkdir -p /var/cache/origin \
    && chown 65532:65532 /var/cache/origin \
    && chmod 0700 /var/cache/origin

WORKDIR /app
COPY requirements.lock /app/requirements.lock
RUN pip install --no-cache-dir -r /app/requirements.lock
COPY grant.py publication.py storage.py index.py mezzanine.py lib_audio.py lib_origin.py service_auth.py limits.py server.py /app/
COPY entrypoint.sh /entrypoint.sh
RUN chmod 0555 /entrypoint.sh

ENV ORIGIN_BIND=0.0.0.0 \
    ORIGIN_PORT=3020 \
    ORIGIN_HOST_PUBLISH=127.0.0.1 \
    ORIGIN_CACHE=/var/cache/origin \
    PYTHONDONTWRITEBYTECODE=1

USER 65532:65532
EXPOSE 3020
ENTRYPOINT ["/entrypoint.sh"]
