FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# No deployment-specific build arguments (#46): Supabase URL, anon key,
# cookie name and the application URL are read at request time from the
# container environment (MGM_PUBLIC_SUPABASE_URL, MGM_PUBLIC_SUPABASE_ANON_KEY,
# MGM_PUBLIC_SUPABASE_COOKIE_NAME, MGM_APP_URL), so one image serves any
# installation. See docs/setup.md "Runtime configuration".
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
