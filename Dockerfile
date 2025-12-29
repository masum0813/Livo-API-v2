FROM node:20-slim
WORKDIR /app

# Install production dependencies (no native build deps required for Redis client)
COPY package.json package-lock.json* ./
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm install --production

COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
