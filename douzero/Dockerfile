# DouZero AI 推理服务 - 使用本地模型
FROM python:3.14-slim AS builder

WORKDIR /app

RUN pip install --no-cache-dir uv

COPY pyproject.toml uv.lock* ./
RUN uv sync --frozen --no-dev

COPY src/ ./src/
COPY server.py .
COPY models/ ./models/

FROM python:3.14-slim

WORKDIR /app

COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/src /app/src
COPY --from=builder /app/server.py /app/server.py
COPY --from=builder /app/models /app/models

# 片② D7 层 1：出货文件系统必须九个模型齐备（COPY 是目录拷贝，缺文件不报错）
RUN test -f /app/models/sl/landlord.onnx \
 && test -f /app/models/sl/landlord_down.onnx \
 && test -f /app/models/sl/landlord_up.onnx \
 && test -f /app/models/douzero_WP/landlord.onnx \
 && test -f /app/models/douzero_WP/landlord_down.onnx \
 && test -f /app/models/douzero_WP/landlord_up.onnx \
 && test -f /app/models/douzero_ADP/landlord.onnx \
 && test -f /app/models/douzero_ADP/landlord_down.onnx \
 && test -f /app/models/douzero_ADP/landlord_up.onnx

ENV DOUZERO_MODELS=/app/models
ENV PORT=2021
ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 2021

# 安全扫描（M0.1 T7）：非 root 运行（trivy DS-0002）。uid 1001 与 debian-slim 既有账号不冲突；
# /app 运行期只读（九个模型构建期已核齐；缺文件时的下载路径本就吞异常 ⇒ 只读也不会崩；
# 监听 2021 > 1024，无需 capabilities）。
RUN useradd -m -u 1001 appuser

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:2021/health')" || exit 1

USER appuser

CMD ["python", "server.py"]
