FROM python:3.12-slim

WORKDIR /app

COPY server.py index.html app.js styles.css manifest.json ./
COPY EZM-icon.png icon-512.png icon-192.png apple-touch-icon.png favicon.ico ./

RUN mkdir -p /data

ENV EZM_DATA_DIR=/data
ENV PORT=5050

EXPOSE 5050

CMD ["python", "server.py"]
