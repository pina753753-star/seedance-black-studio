FROM node:24.22.1-bookworm-slim
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install
COPY server.js reference-dance-inspection.js ./
EXPOSE 3000
CMD ["node", "server.js"]
