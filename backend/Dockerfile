FROM node:24-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-kan \
    tesseract-ocr-mal \
    tesseract-ocr-hin \
    graphicsmagick \
    imagemagick \
    ghostscript \
    poppler-utils \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "start:prod"]
