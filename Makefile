.PHONY: setup verify run clean

setup:
	npm ci
	docker compose up -d postgres
	node scripts/wait-for-postgres.mjs
	node scripts/migrate.mjs
	node scripts/seed.mjs

verify:
	npm ci
	docker compose up -d postgres
	node scripts/wait-for-postgres.mjs
	node scripts/migrate.mjs
	node scripts/seed.mjs
	npm test
	node scripts/verify.mjs

run:
	node scripts/run.mjs

clean:
	docker compose down --volumes
