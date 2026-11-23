FROM node:22-bookworm

# Install a recent PostgreSQL client in the runtime image, not just at build time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl --fail --silent --show-error --location \
        https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-18 \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PATH="/usr/lib/postgresql/18/bin:${PATH}"
WORKDIR /app

RUN pg_dump --version && pg_restore --version
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

CMD ["npm", "start"]
