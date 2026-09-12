FROM node:20-slim
WORKDIR /app
COPY package*.json ./
# skip optional playwright (renderJs needs it; JSON API paths don't)
RUN npm install --omit=optional --no-audit --no-fund
COPY server.js scraper.js api.config.js ./
ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
