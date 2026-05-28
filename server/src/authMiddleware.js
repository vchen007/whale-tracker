import { timingSafeEqual } from 'crypto';
import fp from 'fastify-plugin';

/**
 * Bearer-token authentication plugin.
 *
 * Reads AUTH_TOKEN from process.env. When registered, decorates the Fastify
 * instance with an `authenticate` pre-handler that routes can opt into:
 *
 *   app.get('/secret', { preHandler: [app.authenticate] }, handler)
 *
 * If AUTH_TOKEN is not set the plugin still loads but rejects every request
 * with 503 ("auth not configured") so the server never silently runs wide-open.
 */
function authPlugin(fastify, _opts, done) {
  const token = process.env.AUTH_TOKEN ?? '';

  fastify.decorate('authenticate', async (req, reply) => {
    if (!token) {
      reply.code(503).send({ error: 'auth not configured — set AUTH_TOKEN env var' });
      return;
    }

    const header = req.headers.authorization ?? '';
    const match = header.match(/^Bearer\s+(\S+)$/i);
    const provided = match?.[1] ?? '';

    if (!provided) {
      reply.code(401).send({ error: 'missing Authorization: Bearer <token> header' });
      return;
    }

    // Constant-time comparison to prevent timing attacks
    const a = Buffer.from(token, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      reply.code(401).send({ error: 'invalid token' });
      return;
    }
  });

  done();
}

export default fp(authPlugin, { name: 'auth-middleware' });
