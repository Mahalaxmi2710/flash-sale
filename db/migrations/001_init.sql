-- Final authority for inventory and orders.

CREATE TABLE inventory (
  product_id      TEXT PRIMARY KEY,
  name            TEXT        NOT NULL,
  price_cents     INTEGER     NOT NULL CHECK (price_cents >= 0),
  initial_stock   INTEGER     NOT NULL CHECK (initial_stock >= 0),
  stock           INTEGER     NOT NULL,
  sale_starts_at  TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Defence in depth: even a buggy UPDATE cannot drive stock negative or above the initial amount.
  CONSTRAINT inventory_stock_range CHECK (stock >= 0 AND stock <= initial_stock)
);

CREATE TABLE orders (
  id               BIGSERIAL PRIMARY KEY,
  order_ref        UUID        NOT NULL DEFAULT gen_random_uuid(),
  tracking_id      TEXT        NOT NULL,
  idempotency_key  TEXT        NOT NULL,
  user_id          TEXT        NOT NULL,
  product_id       TEXT        NOT NULL REFERENCES inventory (product_id),
  status           TEXT        NOT NULL,
  failure_reason   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT orders_status_check CHECK (status IN ('CONFIRMED', 'SOLD_OUT', 'FAILED')),
  CONSTRAINT orders_order_ref_key UNIQUE (order_ref),
  -- Idempotency: one order row per tracking id and per (user, client idempotency key).
  CONSTRAINT orders_tracking_id_key UNIQUE (tracking_id),
  CONSTRAINT orders_user_idem_key UNIQUE (user_id, idempotency_key)
);

-- One confirmed unit per user per product.
CREATE UNIQUE INDEX orders_one_confirmed_per_user
  ON orders (user_id, product_id)
  WHERE status = 'CONFIRMED';