#!/bin/bash
pkill -f "47.104.86.62:8080" 2>/dev/null && echo "测试采集器已停止" || echo "未找到运行中的测试采集器"
