import type { Sessions } from "../core/sessions.js";
import type { DeliveryResult, Session } from "../core/session.js";

/** Existing integrations expose either a queue or a launch with bootstrap input. */
export async function resumeSession(system: Sessions, session: Session, message: string): Promise<DeliveryResult> {
  if (system.canSend) return system.send(session, message);
  const launched = await system.launchSession(session, message);
  return { ok: launched.ok, delivered: false, launchRequested: launched.requested, via: "cli-resume", detail: launched.detail,
    deferred: launched.deferred ?? false };
}
