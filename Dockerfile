# Atria PDF engine（AGPL-3.0-or-later）。Cloud Run：gcloud run deploy --source services/pdf-engine
FROM node:24.14.0-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY LICENSE README.md ./
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/main.ts"]
