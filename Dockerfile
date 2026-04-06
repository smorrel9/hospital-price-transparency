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

WORKDIR /app

# Install production deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy built frontend and server source
COPY --from=build /app/dist ./dist
COPY src/ src/

EXPOSE 3001

CMD ["node", "src/server.js"]
