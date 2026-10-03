// Entrypoints for the mfa-data Worker; the logic is in release.js.

import { WorkerEntrypoint } from "cloudflare:workers";
import { handleGateway, handleRelease } from "./release.js";

// Cached (wrangler.toml [exports.Release.cache]): one file from GitHub.
export class Release extends WorkerEntrypoint {
  fetch(request) {
    // A release's name -> asset id map comes from this same entrypoint at
    // /_assets/<tag>, so the cache keeps it between asset misses. The gateway
    // never routes that path.
    const lookup = async (tag) => {
      const res = await this.ctx.exports.Release.fetch(new Request(new URL(`/_assets/${tag}`, request.url)));
      if (res.status === 404) return null;
      return res.ok ? res.json() : undefined;
    };
    return handleRelease(request, this.env, fetch, lookup);
  }
}

// Not cached (wrangler.toml [exports.default.cache]): origin check and rate
// limit, then the cached Release entrypoint through ctx.exports.
export default {
  fetch(request, env, ctx) {
    return handleGateway(request, env, (req) => ctx.exports.Release.fetch(req));
  },
};
