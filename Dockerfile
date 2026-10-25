FROM node:20-slim
WORKDIR /app
COPY package.json ./
COPY index.js ./
RUN apt-get update && apt-get install -y --no-install-recommends curl tar unzip ca-certificates && rm -rf /var/lib/apt/lists/*
EXPOSE 8080
CMD ["node", "index.js"]
