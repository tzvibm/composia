FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY src/ src/

ENV PORT=3000
ENV COMPOSIA_DB=/data/composia

EXPOSE 3000

CMD ["node", "src/cli.js", "serve", "--port", "3000", "--db", "/data/composia"]
