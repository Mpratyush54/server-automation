"""Run after installing sdk-python[telemetry,profiling] and Flask. Init before framework/DB imports."""
import os
from platform_sdk import platform

platform.init(
    project_name=os.getenv('PROJECT_NAME', 'sdk-demo-python'),
    platform_url=os.environ['PLATFORM_URL'],
    environment_name=os.getenv('ENVIRONMENT_NAME', 'development'),
    version=os.getenv('APP_VERSION', '1.0.0'),
    commit_sha=os.getenv('GIT_SHA'),
    databases=['postgres'],
)

from flask import Flask, jsonify

app = Flask(__name__)


@app.get('/health')
def health():
    return {'ok': True}


@app.get('/api/db-check')
def db_check():
    # OTel's logging handler exports this with the active HTTP trace context.
    import logging
    logging.getLogger('demo').warning('Database probe requested')
    rows = platform.db['postgres'].execute('SELECT 1 AS ok')
    platform.log('INFO', 'Database probe completed')
    return jsonify(rows)


if __name__ == '__main__':
    try:
        app.run(host='0.0.0.0', port=int(os.getenv('PORT', '4200')))
    finally:
        platform.shutdown()
