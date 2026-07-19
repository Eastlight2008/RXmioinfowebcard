#!/bin/bash
# ─────────────────────────────────────────────────────────────
# A2S Relay — Debian 部署脚本
# 用法: chmod +x setup.sh && sudo ./setup.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail

INSTALL_DIR=/opt/a2s-relay
LOG_DIR=/var/log/a2s-relay
VENV_DIR=$INSTALL_DIR/venv
SVC=a2s-relay

echo "==> 安装系统依赖..."
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-pip

echo "==> 创建目录..."
mkdir -p "$INSTALL_DIR" "$LOG_DIR"

echo "==> 复制源码..."
cp server.py "$INSTALL_DIR/"
cp requirements.txt "$INSTALL_DIR/"

if [ ! -f "$INSTALL_DIR/.env" ]; then
    cp .env.example "$INSTALL_DIR/.env"
    echo "==> 已创建 .env，请编辑设置密钥！"
fi

echo "==> 创建 Python 虚拟环境..."
python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/pip" install --upgrade pip -q
"$VENV_DIR/bin/pip" install -r "$INSTALL_DIR/requirements.txt" -q

echo "==> 安装 systemd 服务..."
cp a2s-relay.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable "$SVC"
systemctl restart "$SVC"

echo "==> 检查状态..."
sleep 2
systemctl status "$SVC" --no-pager || true

echo ""
echo "============================================"
echo "  部署完成！"
echo "  服务监听: 0.0.0.0:3000"
echo ""
echo "  下一步:"
echo "  1. 编辑 $INSTALL_DIR/.env 设置密钥"
echo "     vim $INSTALL_DIR/.env"
echo "  2. 配置防火墙 (推荐仅允许 Cloudflare IP)"
echo "     https://www.cloudflare.com/ips/"
echo "  3. 在 Cloudflare Pages 环境变量中设置:"
echo "     A2S_RELAY_URL = http://<VPS IP>:3000"
echo "     A2S_SECRET    = <与 .env 中相同的值>"
echo "  4. 重启: systemctl restart $SVC"
echo ""
echo "  常用命令:"
echo "    systemctl status $SVC"
echo "    systemctl restart $SVC"
echo "    journalctl -u $SVC -f"
echo "    curl http://127.0.0.1:3000/health"
echo "============================================"
