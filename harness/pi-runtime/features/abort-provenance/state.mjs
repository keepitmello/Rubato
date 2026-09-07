/**
 * Correlates an abort request with the only terminal event that can represent it.
 * AgentSession owns the event hooks; this class owns no provider or UI policy.
 */
export class AbortProvenance {
  #source;
  #agentEndEvent;
  #settlingAgentEndEvent;
  #agentEndBoundaryOpen = false;
  #stopContinuation = false;
  #clearedQueueAwaitingAbort = false;
  #gapAbortClaimed = false;

  get hasOpenAgentEndBoundary() {
    return this.#agentEndEvent !== undefined || this.#agentEndBoundaryOpen;
  }

  get currentSource() {
    return this.#source ?? this.#agentEndEvent?.abortSource ?? this.#settlingAgentEndEvent?.abortSource;
  }

  noteClearedQueue(hadMessages, abortWillFollow) {
    if (hadMessages && abortWillFollow) this.#clearedQueueAwaitingAbort = true;
  }

  beginAbort(source, {
    agentActive,
    sessionRunActive,
    retrying,
    compacting,
    pendingMessages,
  }) {
    const userOwned = source === "user";
    if (this.hasOpenAgentEndBoundary) {
      if (userOwned) {
        this.#source = "user";
        const event = this.#agentEndEvent ?? this.#settlingAgentEndEvent;
        if (event) {
          event.aborted = true;
          event.abortSource = "user";
        }
        if (sessionRunActive) this.#stopContinuation = true;
      }
      this.#clearedQueueAwaitingAbort = false;
      return { abortCurrentAgent: false, emitSessionAbort: false, joinedAgentEnd: true };
    }

    if (agentActive) {
      if (this.#source === undefined || userOwned) this.#source = source;
      if (sessionRunActive) this.#stopContinuation = true;
      this.#clearedQueueAwaitingAbort = false;
      return { abortCurrentAgent: true, emitSessionAbort: false, joinedAgentEnd: false };
    }

    const inGap = Boolean(
      retrying ||
      compacting ||
      pendingMessages ||
      this.#clearedQueueAwaitingAbort ||
      sessionRunActive,
    );
    this.#clearedQueueAwaitingAbort = false;
    if (sessionRunActive) this.#stopContinuation = true;
    const emitSessionAbort = userOwned && inGap && !this.#gapAbortClaimed;
    if (emitSessionAbort) this.#gapAbortClaimed = true;
    return { abortCurrentAgent: false, emitSessionAbort, joinedAgentEnd: false };
  }

  beginAgentEnd(messages, willRetry) {
    const lastAssistant = [...messages].reverse().find((message) => message?.role === "assistant");
    const abortedWithoutSource = lastAssistant?.stopReason === "aborted";
    const providerSource = lastAssistant?.abortSource === "provider" ? "provider" : undefined;
    const abortSource = this.#source ?? providerSource;
    const event = {
      type: "agent_end",
      messages,
      willRetry,
      ...(abortSource !== undefined || abortedWithoutSource ? { aborted: true } : {}),
      ...(abortSource === undefined ? {} : { abortSource }),
    };
    if (event.aborted) this.#stopContinuation = true;
    this.#agentEndEvent = event;
    this.#settlingAgentEndEvent = undefined;
    this.#agentEndBoundaryOpen = false;
    return event;
  }

  endAgentEnd(event) {
    if (this.#agentEndEvent === event) {
      this.#agentEndEvent = undefined;
      this.#settlingAgentEndEvent = event;
      this.#agentEndBoundaryOpen = true;
    }
    this.#source = undefined;
  }

  closeAgentEndBoundary() {
    this.#agentEndBoundaryOpen = false;
    this.#settlingAgentEndEvent = undefined;
  }

  takeStopContinuation() {
    const value = this.#stopContinuation;
    this.#stopContinuation = false;
    return value;
  }

  finishGapAbort() {
    this.#gapAbortClaimed = false;
  }
}
