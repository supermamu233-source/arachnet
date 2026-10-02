#!/usr/bin/env bash
set -euo pipefail

cd /home/smushimink/arachnet-robot

if [ ! -d .venv-scanner ]; then
  python3 -m venv --system-site-packages .venv-scanner
fi

source .venv-scanner/bin/activate
python -m pip install --upgrade pip
python -m pip install zxing-cpp pillow

echo
python - <<'PY'
from picamera2 import Picamera2
import zxingcpp
from PIL import Image
print("Picamera2 + ZXing + Pillow OK")
PY

echo
echo "Scanner environment ready."
echo "Next: create .env.robot from env.robot.example and set ROBOT_SECRET."
