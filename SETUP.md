# Flash Sale System — Setup Guide

This guide explains how to configure, start, test, and stop the High-Concurrency E-Commerce Flash Sale System locally.

## 1. Prerequisites

Install the following:

- Git
- Node.js 22 and npm
- Docker Desktop with WSL 2 integration enabled, or a compatible Docker Engine
- Docker Compose
- WSL Ubuntu is recommended for the development environment used by this project.

Verify the installations:

```bash
node --version
npm --version
docker version
docker compose version
git --version
```

## 2. Clone the Repository

```bash
git clone YOUR_GITHUB_REPOSITORY_URL
cd flash-sale
```

Replace `YOUR_GITHUB_REPOSITORY_URL` with the actual repository URL.

## 3. Configure Environment Variables

Create a local environment file from the example:

```bash
cp .env.example .env
```

Open `.env` and configure the required credentials, session secret, service ports, and other environment variables according to the existing configuration.

The local configuration uses these ports by default:

| Service | Port |
|---|---:|
| HTTP application | 8081 |
| PostgreSQL | 5433 |
| Redis | 6379 |
| RabbitMQ AMQP | 5672 |
| RabbitMQ management interface | 15672 |

If your `.env.example` contains different defaults, use the values required by your Compose configuration.

**Security:** Never commit `.env` or publish real credentials. Commit only a sanitized `.env.example`.

## 4. Install Dependencies

From the project root:

```bash
npm run install:all
```

This runs the project's dependency installation script for its components.

## 5. Start the Application

Start the services using Docker Compose:

```bash
npm run up
```

Check the service status:

```bash
docker compose ps
```

Inspect logs when troubleshooting:

```bash
npm run logs
```

Confirm that the readiness endpoint responds:

```bash
curl http://localhost:8081/api/health/ready
```

Retrieve the sale information:

```bash
curl http://localhost:8081/api/sale
```

The application should be considered ready only when the required services and health checks are functioning correctly.

## 6. Reset the Sale

To reset the sale and start it after a short delay:

```bash
npm run reset-sale -- --start-in=10
```

This is useful when testing the countdown and checkout flow. Check the script's behavior before using it on any environment containing data you want to preserve.

## 7. Run Automated Tests

Run the test suite:

```bash
npm test
```

The project also provides these targeted commands:

```bash
npm run test:unit
npm run test:integration
```

Run the applicable test suites against the required services and review the actual results. Do not assume that a test passed simply because the command exists.

## 8. Run the Checkout Simulation

Run the configured simulation with 700 users:

```bash
npm run simulate -- --users=700
```

With an initial stock of 500 and 700 distinct eligible purchase attempts, the expected result is at most 500 confirmed purchases, with the remaining attempts unsuccessful because the inventory is exhausted.

This is an expected correctness outcome, not a recorded test result. Inspect the simulation output and database state to verify the actual behavior.

## 9. Check Inventory Consistency

Run the reconciliation command:

```bash
npm run reconcile
```

Review the output for discrepancies between persistent inventory, confirmed orders, and reservation state.

Reconciliation should be performed according to the script's documented safeguards, especially when reservations or queued messages are still being processed.

## 10. Validate NGINX and the Production Build

Validate the NGINX configuration:

```bash
docker compose exec nginx nginx -t
```

Run the frontend bundle-size check:

```bash
npm run bundle-size
```

These commands must be executed successfully before claiming that the configuration or bundle-size target has been verified.

## 11. Run the Load Test

Run the provided k6 test:

```bash
npm run loadtest
```

Review the results for request throughput, latency, failures, and other configured metrics.

A successful local test does not prove that the application can handle 100,000 concurrent checkout requests in production. Record the test environment, workload, and measured results when reporting performance.

## 12. Test Scaled API Instances

If you want to test the configured scaled deployment:

```bash
npm run up:scaled
```

Inspect the running containers:

```bash
docker compose ps
```

Repeat the correctness checks and confirm that the application continues to enforce the inventory limit.

## 13. Stop the Application

Stop the services:

```bash
npm run down
```

Use the project's volume-removal command only when you intentionally want to remove persistent development data. Review its effects before executing it.

## Troubleshooting

- **Docker services are unhealthy:** Run `docker compose ps` and inspect `npm run logs`.
- **Environment configuration errors:** Check `.env` against `.env.example`.
- **Port conflicts:** Verify that the configured ports are available and consistent with the Compose file.
- **Checkout failures:** Inspect API and worker logs, Redis connectivity, RabbitMQ status, and PostgreSQL connectivity.
- **Tests fail:** Ensure dependencies are installed and the required test services are available.
- **Load tests fail:** Confirm that the application is healthy before investigating workload and resource limits.

For additional details about the checkout workflow and architecture, see `README.md`.
