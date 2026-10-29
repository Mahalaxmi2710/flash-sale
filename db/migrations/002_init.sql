-- Supports the post-test invariant checks (count of CONFIRMED per product) and reconciliation.
CREATE INDEX orders_product_status_idx ON orders (product_id, status);