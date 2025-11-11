FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY scrape-one.mjs .
CMD ["node","/app/scrape-one.mjs"]
