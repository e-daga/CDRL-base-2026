.PHONY: setup verify run clean

setup:
	npm ci
	node scripts/setup.mjs

verify:
	npm ci
	node scripts/verify.mjs

run:
	node scripts/run.mjs

clean:
	docker compose down --volumes
