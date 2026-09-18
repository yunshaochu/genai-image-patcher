@echo off
cd /d %~dp0
rem Prefer the Anaconda base env (has torch/cv2/flask); fall back to PATH.
set "PY=D:\developTool\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
echo Starting BananaChange unified backend on http://0.0.0.0:5001 ...
"%PY%" app.py
pause
