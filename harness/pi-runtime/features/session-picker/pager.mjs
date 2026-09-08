export const SESSION_PICKER_PAGE_SIZE = 12;
export const SESSION_PICKER_SCAN_PAGE_SIZE = 200;

function nonNegativeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function normalizeResult(result, requestedOffset) {
  if (Array.isArray(result)) {
    return {
      sessions: result,
      total: result.length,
      offset: 0,
      hasMore: false,
    };
  }
  if (!result || !Array.isArray(result.sessions)) {
    throw new TypeError("session picker loader must return a session array or page result");
  }
  const offset = nonNegativeInteger(result.offset, requestedOffset);
  const total = nonNegativeInteger(result.total, offset + result.sessions.length);
  return {
    sessions: result.sessions,
    total,
    offset,
    hasMore: result.hasMore === true,
  };
}

function appendUniqueByPath(current, added) {
  const paths = new Set(current.map((session) => session.path));
  const sessions = [...current];
  for (const session of added) {
    if (paths.has(session.path)) continue;
    paths.add(session.path);
    sessions.push(session);
  }
  return sessions;
}

/**
 * Session-picker pagination owner. A generation invalidates late results from
 * refreshes or scope changes without coupling the catalog API to TUI state.
 */
export class SessionPickerPager {
  constructor({ pageSize = SESSION_PICKER_PAGE_SIZE, scanPageSize = SESSION_PICKER_SCAN_PAGE_SIZE } = {}) {
    this.pageSize = pageSize;
    this.scanPageSize = scanPageSize;
    this.offset = 0;
    this.total = 0;
    this.hasMore = false;
    this.loadingMore = false;
    this.generation = 0;
  }

  reset() {
    this.generation += 1;
    this.offset = 0;
    this.total = 0;
    this.hasMore = false;
    this.loadingMore = false;
    return this.generation;
  }

  isCurrent(generation) {
    return generation === this.generation;
  }

  beginMore() {
    if (!this.hasMore || this.loadingMore) return undefined;
    this.loadingMore = true;
    return this.generation;
  }

  request({ remaining = false } = {}) {
    return {
      offset: this.offset,
      limit: remaining ? this.scanPageSize : this.pageSize,
    };
  }

  apply(result, current = [], { append = false, request = this.request() } = {}) {
    const requestedOffset = nonNegativeInteger(request?.offset, this.offset);
    const requestedLimit = Math.max(1, nonNegativeInteger(request?.limit, this.pageSize));
    const page = normalizeResult(result, requestedOffset);
    const sessions = append ? appendUniqueByPath(current, page.sessions) : [...page.sessions];
    // A catalog page can contain a header-valid entry whose full parse later
    // fails. When more candidates remain, advance by the requested slice rather
    // than the shorter visible result so an exhaustive search cannot loop.
    const consumed = page.hasMore ? requestedLimit : page.sessions.length;
    this.offset = Math.max(this.offset, page.offset + consumed);
    this.total = Math.max(page.total, sessions.length);
    this.hasMore = page.hasMore && this.offset < this.total;
    return sessions;
  }

  finishMore(generation) {
    if (this.isCurrent(generation)) this.loadingMore = false;
  }
}
