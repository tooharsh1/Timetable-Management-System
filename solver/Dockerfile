FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app
WORKDIR /app

COPY solver/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY solver/app ./app
COPY solver/engine ./engine

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
