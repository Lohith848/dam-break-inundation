# Deployment Guide — Production Staging & Hosting

## 1. Local Production Staging
To test the exact production build locally:

```bash
# 1. Build frontend bundle
cd frontend
npm run build

# 2. Run FastAPI serving the production frontend
cd ../backend
uvicorn app.main:app --host 0.0.0.0 --port 8000
```
FastAPI mounts `frontend/dist` (or `frontend/`) as the static root at `/` and serves `public/assets` at `/public/assets`.

## 2. Docker Containerization

### Dockerfile (Backend + Built Frontend)
```dockerfile
# Stage 1: Build Frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Production Python Runtime
FROM python:3.11-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./backend/
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ ./backend/
COPY public/ ./public/
COPY --from=frontend-builder /app/frontend/dist ./frontend/

EXPOSE 8000
CMD ["python", "-m", "uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

## 3. Cloud Deployment (AWS / GCP / Render)
1. Configure Environment Variables:
   - `GROQ_API_KEY`: Required for AI Copilot automated risk assessment (optional, graceful fallback if missing).
   - `PORT`: Set by platform provider (default 8000).
2. Static Asset CDN:
   - For high-concurrency deployments, mount `public/assets/` to an S3/CloudFront bucket and set `window.__API_BASE__` or asset URL prefix accordingly.
