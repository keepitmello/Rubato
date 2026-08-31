export class RemoteActionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RemoteActionError";
    this.code = code;
  }
}

export function requireInteractiveControl(pi) {
  const control = pi.getInteractiveControl?.();
  if (!control) throw new RemoteActionError("terminal_required", "Interactive control is unavailable in this mode");
  return control;
}

export class InteractiveActionDispatcher {
  constructor(pi, options = {}) {
    this.pi = pi;
    this.resolveImages = options.resolveImages ?? (async (ids) => {
      if (ids?.length) throw new RemoteActionError("invalid_action", "Image attachments are unavailable");
      return [];
    });
    this.refreshEnvironment = options.refreshEnvironment ?? (async () => undefined);
    this.getRevision = options.getRevision ?? (() => 0);
    this.now = options.now ?? Date.now;
    this.dedupTtlMs = options.dedupTtlMs ?? 10 * 60 * 1000;
    this.tail = Promise.resolve();
    this.requests = new Map();
  }

  dispatch(request) {
    this.pruneRequests();
    const duplicate = this.requests.get(request.requestId);
    if (duplicate) return duplicate.promise;
    const promise = this.tail.then(() => this.execute(request));
    this.tail = promise.catch(() => undefined);
    this.requests.set(request.requestId, { at: this.now(), promise });
    return promise;
  }

  pruneRequests() {
    const cutoff = this.now() - this.dedupTtlMs;
    for (const [requestId, cached] of this.requests) {
      if (cached.at < cutoff) this.requests.delete(requestId);
    }
  }

  async execute(request) {
    if (request.expectedRevision !== undefined && request.expectedRevision !== this.getRevision()) {
      throw new RemoteActionError("stale_revision", "The session changed; refresh and retry");
    }
    const control = requireInteractiveControl(this.pi);
    const payload = request.payload;
    switch (request.action) {
      case "input.submit":
      case "input.steer":
      case "input.followUp": {
        const images = await this.resolveImages(payload.imageIds ?? []);
        const delivery = request.action === "input.steer" ? "steer"
          : request.action === "input.followUp" ? "followUp" : "auto";
        const result = await control.submitInput(payload.text, {
          images,
          delivery,
          source: "remote",
          clientInputId: request.requestId,
        });
        if (!result.accepted) {
          const code = result.reason === "terminal_required" ? "terminal_required" : "invalid_action";
          throw new RemoteActionError(code, result.reason);
        }
        return result;
      }
      case "agent.abort":
        await control.abortAgent();
        return { accepted: true };
      case "session.compact":
        await control.compact(payload.instructions);
        return { accepted: true };
      case "session.navigate":
        await control.navigateTree(payload.targetEntryId, {
          summarize: payload.summarize,
          instructions: payload.instructions,
        });
        return { accepted: true };
      case "session.fork":
        await control.fork(payload.targetEntryId);
        return { accepted: true };
      case "session.new":
        await control.newSession();
        return { accepted: true };
      case "session.reload":
        await control.reload();
        return { accepted: true };
      case "session.rename":
        control.setSessionName(payload.name);
        return { accepted: true };
      case "model.set":
        await control.setModel(payload.provider, payload.modelId);
        return { accepted: true };
      case "thinking.set":
        control.setThinkingLevel(payload.level);
        return { accepted: true };
      case "bash.execute":
        await control.executeUserBash(payload.command, payload.excludeFromContext);
        return { accepted: true };
      case "bash.abort":
        await control.abortUserBash();
        return { accepted: true };
      case "ui.respond":
        if (!control.respondToUiRequest(payload.requestId, payload.value)) {
          throw new RemoteActionError("invalid_action", "UI request is no longer pending");
        }
        return { accepted: true };
      case "environment.refresh":
        await this.refreshEnvironment();
        return { accepted: true };
      case "input.queue.clear":
        return control.clearPendingInputs();
      case "conversation.page":
        try {
          return await control.readConversationPage({
            before: payload.before,
            limit: payload.limit,
          });
        } catch (error) {
          const code = error?.code === "invalid_action" ? "invalid_action" : "invalid_action";
          throw new RemoteActionError(code, error?.message ?? "invalid_action");
        }
      default:
        throw new RemoteActionError("invalid_action", `Unsupported action: ${request.action}`);
    }
  }
}
