FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=4100
ENV VALET_DB_PATH=/data/valet.db

EXPOSE 4100

CMD ["npm", "start"]
