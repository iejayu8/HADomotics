FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PORT=8099 DATA_DIR=/app/data
EXPOSE 8099
CMD ["python", "server.py"]
