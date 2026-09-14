# ULTRON AIR API
#
# Portable across every container host (Fly.io, Koyeb, Railway, Render, Cloud
# Run), so the choice of provider is not baked into the code.
#
# Node 22, not 24: 22 is the current LTS and is what hosted runtimes actually
# offer. The code uses nothing newer.
FROM node:22-alpine

# Small init process so SIGTERM from the platform reaches Node and the server
# can close connections cleanly instead of being killed mid-request.
RUN apk add --no-cache tini

WORKDIR /app

# Copy manifests first: this layer is cached and only rebuilds when
# dependencies actually change, not on every source edit.
COPY package*.json ./

# --omit=dev drops nodemon. --ignore-scripts blocks postinstall hooks from
# dependencies, which is one less way a supply-chain issue reaches production.
RUN npm ci --omit=dev --ignore-scripts

COPY src ./src
COPY scripts ./scripts

# Do not run as root. If the process is ever compromised, this limits it.
USER node

# Documentation only. The platform injects the real PORT, and index.js reads it.
EXPOSE 4000

ENV NODE_ENV=production

# NODE_ENV=production makes the server REFUSE to start without API_ACCESS_TOKEN
# (see src/middleware/security.js). That is deliberate: a deploy missing its
# token should fail loudly here, not serve an open API that spends your Gemini
# and Sarvam quota for whoever finds the URL.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
