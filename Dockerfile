# Mini Agent server: the agent, real Python with common libraries, and Chromium for screenshots.
# Works on any host that runs Docker (Render, Railway, Fly.io, Google Cloud Run, a VPS).
FROM node:22-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv chromium fonts-dejavu-core fonts-noto-color-emoji poppler-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Python for the agent, with the libraries it uses to make files
RUN python3 -m venv /opt/py && /opt/py/bin/pip install --no-cache-dir \
      openpyxl python-docx python-pptx fpdf2 matplotlib pandas numpy pypdf pillow reportlab xlsxwriter \
      requests tabulate qrcode beautifulsoup4 lxml markdown
ENV PYTHON=/opt/py/bin/python CHROMIUM=/usr/bin/chromium MPLCONFIGDIR=/opt/mplcache \
    PORT=10000 DATA_DIR=/tmp/mini-agent NODE_ENV=production NODE_OPTIONS=--max-old-space-size=256
RUN mkdir -p /opt/mplcache && /opt/py/bin/python -c "import matplotlib.pyplot" && chmod -R a+rwX /opt/mplcache
# the agent's Python runs as this user, which can't read the server's secrets
RUN useradd --create-home --uid 10001 sandbox
WORKDIR /app
COPY server/package.json server/
RUN cd server && npm install --omit=dev --no-audit --no-fund
COPY index.html app.js styles.css py-worker.js ./
COPY assets ./assets
COPY server/*.mjs server/pytools.py server/
EXPOSE 10000
CMD ["node", "server/server.mjs"]
