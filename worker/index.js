// Entrypoints for the mfa-data Worker; the logic is in release.js and gate.js.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { handleGateway, handleRelease } from "./release.js";
import { durableCounters, quotaMethods, storeAlarm } from "./gate.js";

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

// The document counters (gate.js): one object per browser ID ("b:<id>") and
// one per address ("a:<address>"). The class keeps the name it had when it
// held the old daily cap for each address; those older objects, named by the
// bare address, are no longer read.
export class DailyQuota extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.methods = quotaMethods(ctx.storage);
  }
  doc(args) { return this.methods.doc(args); }
  refund(args) { return this.methods.refund(args); }
  status(args) { return this.methods.status(args); }
  browserSession(args) { return this.methods.browserSession(args); }
  addressSession(args) { return this.methods.addressSession(args); }
  sessionGate(args) { return this.methods.sessionGate(args); }
  trip(args) { return this.methods.trip(args); }
  alarm() { return storeAlarm(this.ctx.storage); }
}

// Not cached (wrangler.toml [exports.default.cache]): origin check, flood
// guard, session check and document limits, then the cached Release
// entrypoint through ctx.exports.
export default {
  fetch(request, env, ctx) {
    return handleGateway(request, env, {
      release: (req) => ctx.exports.Release.fetch(req),
      counters: durableCounters(env.DAILY_QUOTA),
    });
  },
};
