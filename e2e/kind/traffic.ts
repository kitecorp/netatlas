/**
 * How long a journey waits for atlas-b's traffic figures. Right after an install netatlas may not have
 * polled Prometheus since its figures arrived, so they may come after the page opens: the waits never
 * reload, and rely on the page rendering again on each traffic poll.
 */
export const FIGURES_WAIT = 60_000;

/**
 * The spoken label of atlas-b's edge from recommender to postgres, which a policy allows and nobody calls.
 * Until netatlas's 24-hour query has answered, that edge reads as quiet in the last 5 minutes instead.
 */
export const IDLE_EDGE = 'From recommender to postgres, allowed by a policy, no calls recorded in the last 24 hours';
