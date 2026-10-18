# Atria PDF engine（AGPL-3.0-or-later）。Cloud Run：gcloud run deploy --source services/pdf-engine
FROM node:24.14.0-slim
WORKDIR /app
ENV NODE_ENV=production
# package-lock.json 固定所有依賴的版本（公開的原始碼＝部署的內容）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY LICENSE README.md ./
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/main.ts"]
