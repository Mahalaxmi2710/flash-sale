# High-Concurrency E-Commerce Flash Sale System

A flash-sale checkout system designed to maintain inventory consistency and handle sudden bursts of purchase requests using atomic inventory reservations and asynchronous order processing.

## Overview

This project addresses the challenges of an e-commerce flash sale where 500 smartphones are available and a large number of users may attempt to purchase them simultaneously.

The system separates checkout request acceptance from final order confirmation to reduce synchronous processing and protect inventory consistency.

## Technology Stack

- **Frontend:** React.js, Vite, JavaScript
- **Backend:** Node.js 22, Express.js
- **Inventory reservation:** Redis 7 with atomic Lua scripts
- **Message queue:** RabbitMQ
- **Database:** PostgreSQL 16
- **Reverse proxy:** NGINX
- **Containerization:** Docker Compose
- **Testing:** Vitest, Node.js test runner, k6

## Architecture

1. **Frontend:** Displays sale information, a countdown, checkout controls, and order status.
2. **NGINX:** Serves frontend assets, routes API requests, and applies configured rate limits.
3. **Express API:** Validates checkout requests, handles idempotency, and coordinates reservations and message publication.
4. **Redis:** Atomically manages inventory reservations to prevent concurrent requests from reserving beyond the available stock.
5. **RabbitMQ:** Buffers checkout events for asynchronous processing.
6. **Background workers:** Process checkout messages and perform database operations.
7. **PostgreSQL:** Stores persistent inventory and order records, using transactions, conditional stock updates, and database constraints.

## Key Features

- Atomic inventory reservations using Redis Lua scripts.
- Asynchronous checkout processing through RabbitMQ.
- Idempotency to prevent duplicate processing during retries.
- Transactional database updates and inventory constraints.
- Message acknowledgements, retry handling, and dead-letter processing.
- Order-status tracking through API polling.
- Inventory reconciliation and recovery support.
- Docker Compose-based local deployment.
- Automated correctness tests and a k6 load-test script.

## Inventory Consistency

The system enforces a maximum sale quantity of 500 smartphones. Redis provides fast reservation control, while PostgreSQL maintains persistent inventory and order records.

The architecture combines atomic operations, database transactions, unique constraints, and idempotent message processing to prevent overselling and duplicate confirmed orders.

Redis, RabbitMQ, and PostgreSQL do not share a single distributed ACID transaction; recovery and reconciliation are therefore important parts of the design.

## Getting Started

See **[SETUP.md](SETUP.md)** for prerequisites, environment configuration, installation, Docker Compose commands, and testing instructions.

## Performance and Testing

The project includes automated tests, a checkout simulation, an inventory reconciliation command, and a k6 load-test script.

Actual test results, bundle measurements, and throughput should be recorded after running the relevant checks in the target environment. The assessment's 100,000-request scenario is a design requirement, not a claim of verified production capacity.

## Security

- Keep `.env` out of version control.
- Use `.env.example` as the configuration template.
- Configure strong credentials and a secure session secret.
- Validate requests and use the configured request limits.
- Do not expose internal service ports unnecessarily.

## License

No license has been specified. Add a license if you intend to distribute the project under particular reuse terms.
