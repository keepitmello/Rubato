import { createRelay } from './relay.mjs';

export default {
  fetch(request, env) {
    return createRelay(env)(request);
  },
};
