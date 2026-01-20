# crm-api/Dockerfile
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app

# Dependências Python
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Código do backend + pasta web (seu front estático)
COPY . /app

# Servidor WSGI
CMD ["gunicorn","-b","0.0.0.0:8080","app:app","--workers","2","--threads","8","--timeout","180"]
