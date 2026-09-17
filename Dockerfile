# Versioned API image for the lab conductor and self-host.
# Canonical production deploys to Cloudflare Workers (scripts/deploy.sh).
# Book trees are a runtime mount: /book/eng and /book/langs.
# Dev Container uses the `dev` target (source bind-mounted at /app).

FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS dev
WORKDIR /app
ENV PORT=3000
ENV BOOK_TREE=/book/eng
EXPOSE 3000
CMD ["bun", "run", "dev"]

FROM oven/bun:1.3-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY . .
ENV PORT=3000
ENV BOOK_TREE=/book/eng
EXPOSE 3000
ENV DATABASE_URL=postgresql://dummy:dummy@localhost:5432/dummy
ENV APP_JWT_SECRET=glama-introspection-dummy-secret
ENV ADMIN_USER_IDS=
CMD ["bun", "run", "start"]
