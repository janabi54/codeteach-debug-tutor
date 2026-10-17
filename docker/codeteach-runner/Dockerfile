FROM python:3.12-slim

# Non-root user
RUN useradd -m -u 1000 runner
USER runner
WORKDIR /home/runner

# No pip installs needed for v1 — stdlib only
CMD ["python", "/home/runner/main.py"]
