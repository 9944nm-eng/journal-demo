# Онлайн-демо журнала: только синтетические данные, без MetaTrader 5, config.json и data\.
# Подходит для Render.com и Hugging Face Spaces: порт берётся из переменной PORT.
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PORT=7860 DEMO_DATA=/app/seed
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY journal ./journal
COPY web ./web
COPY scripts ./scripts
# демо-данные генерируются при сборке: бесплатный сервер слабый, при запуске это заняло бы минуты
RUN python scripts/demo_server.py --seed-only
# сервер запускается от обычного пользователя: ему нужна запись в базу и в /app/data (скриншоты демо)
RUN useradd -m -u 1000 user && mkdir -p /app/data && chown -R user /app
USER user
EXPOSE 7860
CMD ["python", "scripts/demo_server.py"]
