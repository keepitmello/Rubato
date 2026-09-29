/**
 * One error shape for every client. `message` is user-facing English; `field` names the
 * input it belongs to (dotted, e.g. `schedule.time`); `closest` is a representable schedule
 * offered when the request cannot be expressed.
 */
export class ScheduleError extends Error {
  constructor(code, message, { field, closest } = {}) {
    super(message);
    this.name = 'ScheduleError';
    this.code = code;
    if (field !== undefined) this.field = field;
    if (closest !== undefined) this.closest = closest;
  }
  toJSON() {
    return { code: this.code, message: this.message,
      ...(this.field !== undefined ? { field: this.field } : {}),
      ...(this.closest !== undefined ? { closest: this.closest } : {}) };
  }
}
