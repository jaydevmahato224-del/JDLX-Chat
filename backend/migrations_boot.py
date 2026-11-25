"""Boot-time schema migration for the standalone chat service.

``Dockerfile.chat`` / ``Procfile.chat`` run this before gunicorn so the schema
is applied exactly once per boot. ``database.init_db()`` is idempotent, but
running it from every gunicorn worker would race on the same tables, and
booting straight into gunicorn (no init) leaves a fresh database without any
tables. Any failure here must stop the boot so a broken migration is visible
in the deploy logs instead of surfacing as 500s at runtime.
"""

import logging
import os
import sys

logging.basicConfig(
    level=(os.environ.get("LOG_LEVEL") or "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("migrations_boot")


def main() -> int:
    # One-shot CLI boot check: never spawn background pool-warmer threads that
    # open extra Turso connections only to exit seconds later.
    os.environ.setdefault("DB_POOL_WARM_MIN", "0")
    from database import chat_schema_is_current, init_db  # imported late so env vars are already read

    if chat_schema_is_current():
        logger.info("chat schema is up to date (fast probe)")
        return 0
    init_db()
    logger.info("chat schema initialized/updated")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        logger.exception("migrations_boot failed")
        sys.exit(1)
