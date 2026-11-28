# syntax=docker/dockerfile:1
# Medo schedule-dose service image — runs via tsx (path aliases require it; no compile step).
# Build: docker build --secret id=github_pat,env=GITHUB_PAT -t ghcr.io/kiro-ai-bit/medo-schedule-dose:<tag> .
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json tsconfig.json .npmrc ./
RUN --mount=type=secret,id=github_pat,env=GITHUB_PAT     npm ci --no-audit --no-fund
ENV NODE_ENV=production

COPY Core ./Core
COPY Application ./Application
COPY Infrastructure ./Infrastructure
COPY WebAPI ./WebAPI
COPY drizzle ./drizzle

USER node
EXPOSE 3004
CMD ["npm", "start"]
