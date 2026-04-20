# ─── BU MotoSpace — Dockerfile ───────────────────────────────────────────────
# Node.js 20 LTS บน Alpine (เบา + ปลอดภัย)
FROM node:20-alpine

# ติดตั้ง dependency ของ sharp (native image processing)
RUN apk add --no-cache python3 make g++ vips-dev

# ตั้ง working directory
WORKDIR /app

# Copy package files ก่อน (ใช้ Docker layer cache ให้ได้ประโยชน์สูงสุด)
COPY package*.json ./

# ติดตั้ง production dependencies เท่านั้น
RUN npm install --omit=dev

# Copy source code ทั้งหมด
COPY . .

# สร้าง upload directories (app.js จะสร้างเองด้วย แต่ทำไว้ล่วงหน้าด้วยกัน)
RUN mkdir -p uploads/motorcycles \
             uploads/plates \
             uploads/id-cards \
             uploads/evidence \
             uploads/temp \
             uploads/misc

# Build Tailwind CSS (output.css)
RUN npm run build:css

# Expose port ที่ app ใช้ (ตาม APP_PORT ใน .env)
EXPOSE 8023

# Health check — ตรวจสอบว่า app ยังทำงานอยู่
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:8023/ || exit 1

# ใช้ non-root user เพื่อความปลอดภัย
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

# รัน app
CMD ["node", "app.js"]
