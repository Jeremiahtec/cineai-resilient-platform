FROM node:20-alpine

# Install system FFmpeg and tools
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 4000

ENV PORT=4000
ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
