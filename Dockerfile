# ---- Build stage ----
FROM node:22-slim AS build

WORKDIR /app

# Install all deps (including devDependencies for the Vite build)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build the frontend
COPY index.html vite.config.js tailwind.config.js postcss.config.js ./
COPY src/ src/
RUN npm run build

# ---- Production stage ----
FROM node:22-slim

RUN apt-get update && apt-get install -y unzip curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy built frontend, server source, and data scripts
COPY --from=build /app/dist ./dist
COPY src/ src/
COPY scripts/ scripts/

EXPOSE 3001

CMD ["node", "src/server.js"]
