// Ceilings on the numbers a checkout or an admin form may enter.
//
// Every amount and count below is stored in an INTEGER column, which Postgres
// reads as int4: past 2,147,483,647 a value is not a large number but an error,
// and the arithmetic on the way there runs out of room sooner still — scaling
// pesos to centavos spends two digits of the headroom on its own. A mistyped
// bill used to reach the database unchallenged and surface much later as a
// 22003 on whatever page next tried that arithmetic, which is the worst place
// to find out. These refuse it at the door instead, an order of magnitude below
// the point where anything downstream breaks.
//
// They are deliberately generous: the job is to catch a slipped keyboard, not
// to price the product. Raising one is safe as long as it stays well under the
// int4 ceiling, in whichever unit the column actually stores.

/** ₱10,000,000.00, in centavos — above any single checkout here, 2x under int4. */
export const MAX_MONEY_CENTAVOS = 1_000_000_000;

/** The same ceiling for the paths that carry whole pesos, as a bill is typed. */
export const MAX_MONEY_PESOS = MAX_MONEY_CENTAVOS / 100;

/** Formatted the way the limit is worded to whoever tripped it. */
export const MAX_MONEY_DISPLAY = MAX_MONEY_PESOS.toLocaleString("en-PH");

// Campaign shape. These are counts rather than money, so the useful ceiling is
// the one that keeps them sane rather than the one int4 imposes: a campaign
// asking for more than this has mistyped, not outgrown the product.
export const MAX_BASE_ATTEMPTS = 1_000;
export const MAX_REFERRAL_DAILY_LIMIT = 1_000;
/** 30 days in minutes. A candidate held longer than that is a bug, not a policy. */
export const MAX_CANDIDATE_TIMEOUT_MINUTES = 43_200;
export const MAX_POOL_QUANTITY = 1_000_000;
export const MAX_SLOT_CAPACITY = 100_000;
