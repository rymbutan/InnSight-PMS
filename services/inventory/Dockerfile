FROM node:20-alpine
WORKDIR /app

# Dependencies are installed as root, WITH devDependencies. That is deliberate:
# the Prisma CLI is a devDependency and db-init.sh needs it at CONTAINER START.
# Setting NODE_ENV=production before this line would skip it, and `npx prisma`
# would then try to fetch the CLI over the network on every boot.
#
# `npm ci` (not `npm install`) installs exactly the committed lockfile. Only
# services/auth had a package-lock.json before; the other 8 re-resolved their
# transitive dependency tree on every build, so two builds of the same commit
# could ship different code.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY . .
RUN npx prisma generate --schema=src/prisma/schema.prisma

# Runtime environment. NODE_ENV was previously never set ANYWHERE in the repo,
# which is why the weak-JWT-secret hard-fail in src/middleware/auth.js could
# never fire, pino stayed at debug level, and Express kept dev-mode behaviour.
ENV NODE_ENV=production

# Drop root. node:20-alpine ships an unprivileged `node` user (uid 1000);
# every container in this stack previously ran as root.
RUN chown -R node:node /app
USER node

EXPOSE 3005

HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=6 \
  CMD wget -qO- http://127.0.0.1:3005/health >/dev/null 2>&1 || exit 1

# Seeding is NOT part of the startup command any more. It used to run on every
# container start, which meant (a) two replicas = two concurrent seeds racing on
# the same rows, and (b) for auth, re-deriving the admin credentials on every
# boot. Seed explicitly and once:  bash scripts/db-seed.sh
CMD ["sh", "-c", "sh ./db-init.sh && node src/index.js"]
